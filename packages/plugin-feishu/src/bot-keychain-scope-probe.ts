import { parseIsoTimestamp, parseSecretReference, type IsoTimestamp } from '@twindesk/domain'

import {
  FeishuBotIdentityScopeHttpClient,
  type FeishuBotIdentityScopeObservation,
} from './bot-identity-scope-http-client.ts'
import {
  FeishuBotTenantTokenAcquirer,
  FeishuBotTenantTokenAcquisitionError,
} from './bot-tenant-token-acquisition.ts'
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
} from './operation-scope-authorization.ts'
import { FeishuSystemKeychainError, FeishuSystemKeychainSecretResolver } from './system-keychain.ts'

export interface FeishuBotKeychainScopeProbeOptions {
  readonly configuration: unknown
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly tokenAcquirer: FeishuBotTenantTokenAcquirer
  readonly scopeClient: FeishuBotIdentityScopeHttpClient
  readonly now?: () => number
}

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
  const actual = Object.keys(record)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new TypeError()
  }
}

function readOptions(value: unknown): Readonly<{
  configuration: FeishuIdentityConfiguration
  resolver: FeishuSystemKeychainSecretResolver
  tokenAcquirer: FeishuBotTenantTokenAcquirer
  scopeClient: FeishuBotIdentityScopeHttpClient
  now: () => number
}> {
  try {
    const record = dataRecord(value)
    exactKeys(
      record,
      Object.hasOwn(record, 'now')
        ? ['configuration', 'resolver', 'tokenAcquirer', 'scopeClient', 'now']
        : ['configuration', 'resolver', 'tokenAcquirer', 'scopeClient'],
    )
    const configuration = parseFeishuIdentityConfiguration(record.configuration)
    const nowValue = Object.hasOwn(record, 'now') ? record.now : Date.now
    if (
      configuration.bot === undefined ||
      !(record.resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(record.tokenAcquirer instanceof FeishuBotTenantTokenAcquirer) ||
      !(record.scopeClient instanceof FeishuBotIdentityScopeHttpClient) ||
      typeof nowValue !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      configuration,
      resolver: record.resolver,
      tokenAcquirer: record.tokenAcquirer,
      scopeClient: record.scopeClient,
      now: nowValue as () => number,
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
): FeishuOperationScopeProbeRequest {
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
    const expectedScopes = requiredFeishuOperationScopes('bot_reply')
    requestScopes(record.requiredScopes, expectedScopes)
    const reference = parseSecretReference(record.credentialReference)
    const bot = configuration.bot
    if (
      bot === undefined ||
      record.kind !== 'feishu_operation_scope_probe_request' ||
      record.schemaVersion !== FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION ||
      record.accountId !== configuration.accountId ||
      record.appId !== configuration.appId ||
      record.identityType !== 'bot' ||
      record.principalId !== bot.principalId ||
      record.operation !== 'bot_reply' ||
      reference.kind !== bot.credentialReference.kind ||
      reference.schemaVersion !== bot.credentialReference.schemaVersion ||
      reference.id !== bot.credentialReference.id ||
      reference.store !== bot.credentialReference.store ||
      reference.purpose !== bot.credentialReference.purpose
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      kind: 'feishu_operation_scope_probe_request',
      schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
      accountId: configuration.accountId,
      appId: configuration.appId,
      identityType: 'bot',
      principalId: bot.principalId,
      credentialReference: bot.credentialReference,
      operation: 'bot_reply',
      requiredScopes: expectedScopes,
    })
  } catch (error) {
    if (error instanceof FeishuOperationScopeProbeClientError) throw error
    throw clientError('invalid_response')
  }
}

function observationTime(now: () => number): IsoTimestamp {
  try {
    const milliseconds = now()
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 8_640_000_000_000_000
    ) {
      throw new TypeError()
    }
    return parseIsoTimestamp(new Date(milliseconds).toISOString())
  } catch {
    throw clientError('invalid_response')
  }
}

function scopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) throw new TypeError()
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    throw new TypeError()
  }
  const result = Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
    const scope = descriptor.value
    if (
      typeof scope !== 'string' ||
      scope.length === 0 ||
      scope.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)
    ) {
      throw new TypeError()
    }
    return scope
  })
  if (
    new Set(result).size !== result.length ||
    result.some((scope, index) => index > 0 && scope <= (result[index - 1] as string))
  ) {
    throw new TypeError()
  }
  return Object.freeze(result)
}

function validateObservation(
  value: FeishuBotIdentityScopeObservation,
  configuration: FeishuIdentityConfiguration,
): readonly string[] {
  try {
    const record = dataRecord(value)
    exactKeys(record, ['kind', 'schemaVersion', 'appId', 'principalId', 'grantedScopes'])
    const grantedScopes = scopes(record.grantedScopes)
    if (
      record.kind !== 'feishu_bot_identity_scope_observation' ||
      record.schemaVersion !== 1 ||
      record.appId !== configuration.appId
    ) {
      throw new TypeError()
    }
    if (record.principalId !== configuration.bot?.principalId) {
      throw clientError('not_authorized')
    }
    return grantedScopes
  } catch (error) {
    if (error instanceof FeishuOperationScopeProbeClientError) throw error
    throw clientError('invalid_response')
  }
}

function mapCredentialError(error: unknown): FeishuOperationScopeProbeClientError {
  if (error instanceof FeishuOperationScopeProbeClientError) return error
  if (error instanceof FeishuBotTenantTokenAcquisitionError) {
    if (error.code === 'configuration_invalid') return clientError('not_authorized')
    if (error.code === 'retry_later') return clientError('unavailable')
    return clientError('invalid_response')
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
  if (error instanceof FeishuCredentialBundleError) return clientError('invalid_response')
  return clientError('unavailable')
}

/** Resolve the configured Bot credential and remotely verify its principal and tenant scopes. */
export class FeishuBotKeychainScopeProbe implements FeishuOperationScopeProbeClient {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #tokenAcquirer: FeishuBotTenantTokenAcquirer
  readonly #scopeClient: FeishuBotIdentityScopeHttpClient
  readonly #now: () => number

  constructor(options: FeishuBotKeychainScopeProbeOptions) {
    const validated = readOptions(options)
    this.#configuration = validated.configuration
    this.#resolver = validated.resolver
    this.#tokenAcquirer = validated.tokenAcquirer
    this.#scopeClient = validated.scopeClient
    this.#now = validated.now
  }

  async inspectCurrentScopes(
    requestValue: FeishuOperationScopeProbeRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
    signal.throwIfAborted()
    const request = validateRequest(requestValue, this.#configuration)
    const parser = new FeishuCredentialBundleParser()
    try {
      return await this.#resolver.withSecret(request.credentialReference, signal, (bundle) =>
        parser.withCredential(this.#configuration, 'bot', bundle, signal, (credential) => {
          if (credential.kind !== 'feishu_app_credential_bundle') {
            throw clientError('invalid_response')
          }
          return this.#tokenAcquirer.acquire(
            { appId: credential.appId, appSecret: credential.appSecret },
            signal,
            async (token) => {
              const observation = await this.#scopeClient.inspect(
                { appId: credential.appId, accessToken: token.accessToken },
                signal,
              )
              const grantedScopes = validateObservation(observation, this.#configuration)
              return Object.freeze({
                kind: 'feishu_operation_scope_probe_result',
                schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
                accountId: this.#configuration.accountId,
                appId: this.#configuration.appId,
                identityType: 'bot',
                principalId: this.#configuration.bot!.principalId,
                operation: 'bot_reply',
                authorization: 'authorized',
                grantedScopes,
                observedAt: observationTime(this.#now),
              })
            },
          )
        }),
      )
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      throw mapCredentialError(error)
    }
  }
}
