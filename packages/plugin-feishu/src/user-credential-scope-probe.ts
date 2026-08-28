import { parseIsoTimestamp, parseSecretReference, type IsoTimestamp } from '@twindesk/domain'

import { FeishuCredentialBundleError, FeishuCredentialBundleParser } from './credential-bundle.ts'
import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import {
  FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
  FeishuOperationScopeProbeClientError,
  requiredFeishuOperationScopes,
  type FeishuOperationScopeProbeClient,
  type FeishuOperationScopeProbeRequest,
  type FeishuScopedOperation,
} from './operation-scope-authorization.ts'
import { FeishuSystemKeychainError, FeishuSystemKeychainSecretResolver } from './system-keychain.ts'

export interface FeishuUserCredentialScopeProbeOptions {
  readonly configuration: unknown
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly now?: () => number
}

type UserScopedOperation = Extract<FeishuScopedOperation, 'user_reply' | 'user_message_discovery'>
type UnknownRecord = Readonly<Record<string, unknown>>

function clientError(
  code: ConstructorParameters<typeof FeishuOperationScopeProbeClientError>[0],
): FeishuOperationScopeProbeClientError {
  return new FeishuOperationScopeProbeClientError(code)
}

function dataRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    throw new TypeError()
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const keys = Object.keys(record)
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new TypeError()
  }
}

function readOptions(value: unknown): Readonly<{
  configuration: FeishuIdentityConfiguration
  resolver: FeishuSystemKeychainSecretResolver
  now: () => number
}> {
  try {
    const record = dataRecord(value)
    exactKeys(
      record,
      Object.hasOwn(record, 'now')
        ? ['configuration', 'resolver', 'now']
        : ['configuration', 'resolver'],
    )
    const configuration = parseFeishuIdentityConfiguration(record.configuration)
    const resolver = record.resolver
    const nowValue = Object.hasOwn(record, 'now') ? record.now : Date.now
    if (
      configuration.user === undefined ||
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      typeof nowValue !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ configuration, resolver, now: nowValue as () => number })
  } catch {
    throw clientError('invalid_response')
  }
}

function observedAt(
  now: () => number,
): Readonly<{ milliseconds: number; timestamp: IsoTimestamp }> {
  let milliseconds: number
  try {
    milliseconds = now()
  } catch {
    throw clientError('invalid_response')
  }
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 8_640_000_000_000_000
  ) {
    throw clientError('invalid_response')
  }
  try {
    return Object.freeze({
      milliseconds,
      timestamp: parseIsoTimestamp(new Date(milliseconds).toISOString()),
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function requestScopes(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length') ||
    value.length !== expected.length
  ) {
    throw new TypeError()
  }
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value !== expected[index]
    ) {
      throw new TypeError()
    }
  }
}

function validateRequest(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
): Readonly<{ request: FeishuOperationScopeProbeRequest; operation: UserScopedOperation }> {
  try {
    const record = dataRecord(value)
    exactKeys(record, [
      'kind',
      'schemaVersion',
      'accountId',
      'appId',
      'identityType',
      'principalId',
      'credentialReference',
      'operation',
      'requiredScopes',
    ])
    const operation = record.operation
    if (operation !== 'user_reply' && operation !== 'user_message_discovery') {
      throw new TypeError()
    }
    const expectedScopes = requiredFeishuOperationScopes(operation)
    requestScopes(record.requiredScopes, expectedScopes)
    const reference = parseSecretReference(record.credentialReference)
    const user = configuration.user
    if (
      user === undefined ||
      record.kind !== 'feishu_operation_scope_probe_request' ||
      record.schemaVersion !== FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION ||
      record.accountId !== configuration.accountId ||
      record.appId !== configuration.appId ||
      record.identityType !== 'user' ||
      record.principalId !== user.principalId ||
      reference.kind !== user.credentialReference.kind ||
      reference.schemaVersion !== user.credentialReference.schemaVersion ||
      reference.id !== user.credentialReference.id ||
      reference.store !== user.credentialReference.store ||
      reference.purpose !== user.credentialReference.purpose
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      request: Object.freeze({
        kind: 'feishu_operation_scope_probe_request',
        schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
        accountId: configuration.accountId,
        appId: configuration.appId,
        identityType: 'user',
        principalId: user.principalId,
        credentialReference: reference,
        operation,
        requiredScopes: expectedScopes,
      }),
      operation,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function mapCredentialError(error: unknown): FeishuOperationScopeProbeClientError {
  if (error instanceof FeishuCredentialBundleError) {
    return error.code === 'credential_expired'
      ? clientError('not_authorized')
      : clientError('invalid_response')
  }
  if (error instanceof FeishuSystemKeychainError) {
    if (error.code === 'not_found') return clientError('not_authorized')
    if (
      error.code === 'invalid_reference' ||
      error.code === 'invalid_consumer' ||
      error.code === 'unsupported_store' ||
      error.code === 'unsupported_purpose' ||
      error.code === 'unsupported_platform' ||
      error.code === 'secret_empty' ||
      error.code === 'secret_too_large'
    ) {
      return clientError('invalid_response')
    }
  }
  return clientError('unavailable')
}

/**
 * Resolve and parse the exact User OAuth bundle, returning only its current
 * authorization and scope metadata. No token bytes escape the callbacks.
 */
export class FeishuUserCredentialScopeProbe implements FeishuOperationScopeProbeClient {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #now: () => number

  constructor(options: FeishuUserCredentialScopeProbeOptions) {
    const validated = readOptions(options)
    this.#configuration = validated.configuration
    this.#resolver = validated.resolver
    this.#now = validated.now
  }

  async inspectCurrentScopes(
    requestValue: FeishuOperationScopeProbeRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const { request, operation } = validateRequest(requestValue, this.#configuration)
    const observation = observedAt(this.#now)
    const parser = new FeishuCredentialBundleParser({ now: () => observation.milliseconds })
    try {
      return await this.#resolver.withSecret(request.credentialReference, signal, (bundle) =>
        parser.withCredential(this.#configuration, 'user', bundle, signal, (credential) => {
          if (credential.kind !== 'feishu_user_oauth_credential_bundle') {
            throw clientError('invalid_response')
          }
          if (credential.accessTokenStatus !== 'usable') {
            throw clientError('refresh_required')
          }
          return Object.freeze({
            kind: 'feishu_operation_scope_probe_result',
            schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
            accountId: this.#configuration.accountId,
            appId: this.#configuration.appId,
            identityType: 'user',
            principalId: this.#configuration.user!.principalId,
            operation,
            authorization: 'authorized',
            grantedScopes: credential.scopes,
            observedAt: observation.timestamp,
          })
        }),
      )
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof FeishuOperationScopeProbeClientError) throw error
      throw mapCredentialError(error)
    }
  }
}
