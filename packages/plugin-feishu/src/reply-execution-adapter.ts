import { parseSecretReference, type SecretReference } from '@twindesk/domain'

import { FeishuBotKeychainScopeProbe } from './bot-keychain-scope-probe.ts'
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
  FeishuOperationScopeAuthorizationError,
  FeishuOperationScopeAuthorizer,
  type FeishuOperationScopeProbeClient,
  type FeishuOperationScopeProbeRequest,
} from './operation-scope-authorization.ts'
import {
  FEISHU_REPLY_EXECUTION_VERSION,
  FeishuReplyExecutionClientError,
  type FeishuReplyExecutionClient,
  type FeishuReplyExecutionRequest,
} from './reply-execution.ts'
import { FeishuReplyHttpClient, type FeishuReplyHttpResult } from './reply-http-client.ts'
import { type FeishuRuntimeLease } from './runtime-lease.ts'
import { FeishuSystemKeychainError, FeishuSystemKeychainSecretResolver } from './system-keychain.ts'
import { FeishuUserCredentialScopeProbe } from './user-credential-scope-probe.ts'

const IDEMPOTENCY_KEY_PATTERN = /^tdfr1:[a-f0-9]{40}$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const MAX_REPLY_TEXT_CHARACTERS = 20_000
const MAX_REPLY_TEXT_BYTES = 64 * 1024

export interface FeishuReplyExecutionAdapterOptions {
  readonly configuration: unknown
  /** The Host-owned lease must remain held for the adapter's complete lifetime. */
  readonly lease: FeishuRuntimeLease
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly replyClient: FeishuReplyHttpClient
  readonly botScopeProbe?: FeishuBotKeychainScopeProbe
  readonly botTokenAcquirer?: FeishuBotTenantTokenAcquirer
  readonly userScopeProbe?: FeishuUserCredentialScopeProbe
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>
type AssertLeaseHeld = FeishuRuntimeLease['assertHeld']

interface ParsedOptions {
  readonly configuration: FeishuIdentityConfiguration
  readonly assertLeaseHeld: AssertLeaseHeld
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly replyClient: FeishuReplyHttpClient
  readonly botTokenAcquirer?: FeishuBotTenantTokenAcquirer
  readonly scopeClient: FeishuOperationScopeProbeClient
  readonly now: () => number
}

function clientError(
  code: ConstructorParameters<typeof FeishuReplyExecutionClientError>[0],
): FeishuReplyExecutionClientError {
  return new FeishuReplyExecutionClientError(code)
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

function method(value: unknown, name: 'assertHeld'): AssertLeaseHeld {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      throw new TypeError()
    }
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return descriptor.value.bind(value) as AssertLeaseHeld
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw clientError('invalid_response')
  }
}

function readOptions(value: unknown): ParsedOptions {
  try {
    const record = dataRecord(value)
    const configuration = parseFeishuIdentityConfiguration(record.configuration)
    const expected = ['configuration', 'lease', 'resolver', 'replyClient']
    if (configuration.bot !== undefined) expected.push('botScopeProbe', 'botTokenAcquirer')
    if (configuration.user !== undefined) expected.push('userScopeProbe')
    if (Object.hasOwn(record, 'now')) expected.push('now')
    exactKeys(record, expected)
    const resolver = record.resolver
    const replyClient = record.replyClient
    const now = Object.hasOwn(record, 'now') ? record.now : Date.now
    const botScopeProbe = record.botScopeProbe
    const botTokenAcquirer = record.botTokenAcquirer
    const userScopeProbe = record.userScopeProbe
    if (
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(replyClient instanceof FeishuReplyHttpClient) ||
      typeof now !== 'function' ||
      (configuration.bot !== undefined &&
        (!(botScopeProbe instanceof FeishuBotKeychainScopeProbe) ||
          !(botTokenAcquirer instanceof FeishuBotTenantTokenAcquirer))) ||
      (configuration.user !== undefined &&
        !(userScopeProbe instanceof FeishuUserCredentialScopeProbe))
    ) {
      throw new TypeError()
    }
    const scopeClient: FeishuOperationScopeProbeClient = Object.freeze({
      inspectCurrentScopes(request: FeishuOperationScopeProbeRequest, signal: AbortSignal) {
        return request.identityType === 'bot'
          ? (botScopeProbe as FeishuBotKeychainScopeProbe).inspectCurrentScopes(request, signal)
          : (userScopeProbe as FeishuUserCredentialScopeProbe).inspectCurrentScopes(request, signal)
      },
    })
    return Object.freeze({
      configuration,
      assertLeaseHeld: method(record.lease, 'assertHeld'),
      resolver,
      replyClient,
      ...(configuration.bot === undefined
        ? {}
        : { botTokenAcquirer: botTokenAcquirer as FeishuBotTenantTokenAcquirer }),
      scopeClient,
      now: now as () => number,
    })
  } catch (error) {
    if (error instanceof FeishuReplyExecutionClientError) throw error
    throw clientError('invalid_response')
  }
}

function exactReference(actual: SecretReference, expected: SecretReference): boolean {
  return (
    actual.kind === expected.kind &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.id === expected.id &&
    actual.store === expected.store &&
    actual.purpose === expected.purpose
  )
}

function boundedIdentifier(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function replyContent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REPLY_TEXT_CHARACTERS ||
    new TextEncoder().encode(value).byteLength > MAX_REPLY_TEXT_BYTES ||
    /[\u0000\u000b\u000c\u007f]/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function readRequest(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
): FeishuReplyExecutionRequest {
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
      'targetMessageId',
      'content',
      'idempotencyKey',
    ])
    if (record.identityType !== 'bot' && record.identityType !== 'user') throw new TypeError()
    const identity = configuration[record.identityType]
    const reference = parseSecretReference(record.credentialReference)
    const targetMessageId = boundedIdentifier(record.targetMessageId)
    const content = replyContent(record.content)
    const idempotencyKey = boundedIdentifier(record.idempotencyKey, 50)
    if (
      identity === undefined ||
      record.kind !== 'feishu_reply_execution_request' ||
      record.schemaVersion !== FEISHU_REPLY_EXECUTION_VERSION ||
      record.accountId !== configuration.accountId ||
      record.appId !== configuration.appId ||
      record.principalId !== identity.principalId ||
      !exactReference(reference, identity.credentialReference) ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      kind: 'feishu_reply_execution_request',
      schemaVersion: FEISHU_REPLY_EXECUTION_VERSION,
      accountId: configuration.accountId,
      appId: configuration.appId,
      identityType: record.identityType,
      principalId: identity.principalId,
      credentialReference: identity.credentialReference,
      targetMessageId,
      content,
      idempotencyKey,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function result(request: FeishuReplyExecutionRequest, response: FeishuReplyHttpResult): unknown {
  return Object.freeze({
    status: 'found',
    accountId: request.accountId,
    identityType: request.identityType,
    idempotencyKey: request.idempotencyKey,
    targetMessageId: request.targetMessageId,
    messageId: response.messageId,
    sentAt: response.sentAt,
  })
}

function mapPreflightError(error: unknown): FeishuReplyExecutionClientError {
  if (error instanceof FeishuReplyExecutionClientError) return error
  if (error instanceof FeishuOperationScopeAuthorizationError) {
    if (error.code === 'not_authorized') return clientError('not_authorized')
    if (error.code === 'scope_missing') return clientError('scope_missing')
    if (
      error.code === 'credential_refresh_required' ||
      error.code === 'observation_stale' ||
      error.code === 'probe_unavailable'
    ) {
      return clientError('preflight_unavailable')
    }
    return clientError('invalid_response')
  }
  if (error instanceof FeishuSystemKeychainError) {
    if (error.code === 'not_found') return clientError('not_authorized')
    if (error.code === 'unavailable') return clientError('preflight_unavailable')
    return clientError('invalid_response')
  }
  if (error instanceof FeishuBotTenantTokenAcquisitionError) {
    if (error.code === 'configuration_invalid') return clientError('not_authorized')
    if (error.code === 'retry_later') return clientError('preflight_unavailable')
    return clientError('invalid_response')
  }
  if (error instanceof FeishuCredentialBundleError) {
    if (error.code === 'credential_expired') return clientError('not_authorized')
    return clientError('invalid_response')
  }
  return clientError('preflight_unavailable')
}

/**
 * Send-only production composition for an already-approved reply.
 *
 * Construct and use this adapter only inside `FeishuRuntimeLeaseManager.withLease`.
 * Scope inspection and credential resolution remain separate callbacks, and no
 * token or raw Feishu payload escapes this boundary.
 */
export class FeishuReplyExecutionAdapter implements FeishuReplyExecutionClient {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #assertLeaseHeld: AssertLeaseHeld
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #replyClient: FeishuReplyHttpClient
  readonly #botTokenAcquirer: FeishuBotTenantTokenAcquirer | undefined
  readonly #scopeAuthorizer: FeishuOperationScopeAuthorizer
  readonly #now: () => number

  constructor(options: FeishuReplyExecutionAdapterOptions) {
    const validated = readOptions(options)
    this.#configuration = validated.configuration
    this.#assertLeaseHeld = validated.assertLeaseHeld
    this.#resolver = validated.resolver
    this.#replyClient = validated.replyClient
    this.#botTokenAcquirer = validated.botTokenAcquirer
    this.#scopeAuthorizer = new FeishuOperationScopeAuthorizer({
      configuration: validated.configuration,
      client: validated.scopeClient,
      now: validated.now,
    })
    this.#now = validated.now
  }

  async send(requestValue: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
    signal.throwIfAborted()
    const request = readRequest(requestValue, this.#configuration)
    try {
      this.#assertLeaseHeld()
      const operation = request.identityType === 'bot' ? 'bot_reply' : 'user_reply'
      return await this.#scopeAuthorizer.withAuthorizedOperation(operation, signal, async () => {
        this.#assertLeaseHeld()
        return request.identityType === 'bot'
          ? this.#sendBot(request, signal)
          : this.#sendUser(request, signal)
      })
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      throw mapPreflightError(error)
    }
  }

  async #sendUser(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown> {
    const parser = new FeishuCredentialBundleParser({ now: this.#now })
    return this.#resolver.withSecret(request.credentialReference, signal, (bundle) =>
      parser.withCredential(this.#configuration, 'user', bundle, signal, async (credential) => {
        if (
          credential.kind !== 'feishu_user_oauth_credential_bundle' ||
          credential.accessTokenStatus !== 'usable'
        ) {
          throw clientError('preflight_unavailable')
        }
        if (!credential.scopes.includes('im:message:send_as_user')) {
          throw clientError('scope_missing')
        }
        this.#assertLeaseHeld()
        return result(
          request,
          await this.#replyClient.send(
            {
              targetMessageId: request.targetMessageId,
              content: request.content,
              idempotencyKey: request.idempotencyKey,
              accessToken: credential.accessToken,
            },
            signal,
          ),
        )
      }),
    )
  }

  async #sendBot(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown> {
    const tokenAcquirer = this.#botTokenAcquirer
    if (tokenAcquirer === undefined) throw clientError('invalid_response')
    const parser = new FeishuCredentialBundleParser({ now: this.#now })
    return this.#resolver.withSecret(request.credentialReference, signal, (bundle) =>
      parser.withCredential(this.#configuration, 'bot', bundle, signal, (credential) => {
        if (credential.kind !== 'feishu_app_credential_bundle') {
          throw clientError('invalid_response')
        }
        return tokenAcquirer.acquire(
          { appId: credential.appId, appSecret: credential.appSecret },
          signal,
          async (token) => {
            this.#assertLeaseHeld()
            return result(
              request,
              await this.#replyClient.send(
                {
                  targetMessageId: request.targetMessageId,
                  content: request.content,
                  idempotencyKey: request.idempotencyKey,
                  accessToken: token.accessToken,
                },
                signal,
              ),
            )
          },
        )
      }),
    )
  }
}
