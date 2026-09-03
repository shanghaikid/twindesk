import { parseIsoTimestamp } from '@twindesk/domain'

import { FeishuCredentialBundleError, FeishuCredentialBundleParser } from './credential-bundle.ts'
import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import {
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationError,
} from './oauth-rotation-coordinator.ts'
import {
  FeishuOperationScopeAuthorizationError,
  FeishuOperationScopeAuthorizer,
  requiredFeishuOperationScopes,
} from './operation-scope-authorization.ts'
import { FeishuRuntimeLeaseError, type FeishuRuntimeLease } from './runtime-lease.ts'
import { FeishuSystemKeychainError, FeishuSystemKeychainSecretResolver } from './system-keychain.ts'
import { FeishuUserCredentialScopeProbe } from './user-credential-scope-probe.ts'
import {
  FeishuUserMessageSearchClientError,
  type FeishuUserMessageSearchClient,
  type FeishuUserMessageSearchRequest,
} from './user-message-discovery.ts'
import { FeishuUserMessageSearchHttpClient } from './user-message-search-http-client.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const MAX_PAGE_SIZE = 50
const MAX_PAGE_TOKEN_CHARACTERS = 4096

type UnknownRecord = Readonly<Record<string, unknown>>
type AssertLeaseHeld = FeishuRuntimeLease['assertHeld']

export interface FeishuUserMessageSearchAdapterOptions {
  readonly configuration: unknown
  /** Verified Host-only tenant identity; never accepted from browser input. */
  readonly tenantKey: string
  /** The Host-owned lease must remain held for the adapter's complete lifetime. */
  readonly lease: FeishuRuntimeLease
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly scopeProbe: FeishuUserCredentialScopeProbe
  readonly rotationCoordinator: FeishuOAuthRotationCoordinator
  readonly httpClient: FeishuUserMessageSearchHttpClient
  readonly now?: () => number
}

interface ParsedOptions {
  readonly configuration: FeishuIdentityConfiguration
  readonly tenantKey: string
  readonly assertLeaseHeld: AssertLeaseHeld
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly scopeProbe: FeishuUserCredentialScopeProbe
  readonly rotationCoordinator: FeishuOAuthRotationCoordinator
  readonly httpClient: FeishuUserMessageSearchHttpClient
  readonly now: () => number
}

function clientError(
  code: ConstructorParameters<typeof FeishuUserMessageSearchClientError>[0],
): FeishuUserMessageSearchClientError {
  return new FeishuUserMessageSearchClientError(code)
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

function method(value: unknown): AssertLeaseHeld {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError()
  }
  let owner: object | null = value
  for (let depth = 0; owner !== null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'assertHeld')
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError()
      }
      return descriptor.value.bind(value) as AssertLeaseHeld
    }
    owner = Object.getPrototypeOf(owner) as object | null
  }
  throw new TypeError()
}

function identifier(value: unknown, maximum = 512): string {
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

function opaquePageToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PAGE_TOKEN_CHARACTERS ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function readOptions(value: unknown): ParsedOptions {
  try {
    const record = dataRecord(value)
    exactKeys(
      record,
      Object.hasOwn(record, 'now')
        ? [
            'configuration',
            'tenantKey',
            'lease',
            'resolver',
            'scopeProbe',
            'rotationCoordinator',
            'httpClient',
            'now',
          ]
        : [
            'configuration',
            'tenantKey',
            'lease',
            'resolver',
            'scopeProbe',
            'rotationCoordinator',
            'httpClient',
          ],
    )
    const configuration = parseFeishuIdentityConfiguration(record.configuration)
    const resolver = record.resolver
    const scopeProbe = record.scopeProbe
    const rotationCoordinator = record.rotationCoordinator
    const httpClient = record.httpClient
    const now = Object.hasOwn(record, 'now') ? record.now : Date.now
    if (
      configuration.user === undefined ||
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(scopeProbe instanceof FeishuUserCredentialScopeProbe) ||
      !(rotationCoordinator instanceof FeishuOAuthRotationCoordinator) ||
      !(httpClient instanceof FeishuUserMessageSearchHttpClient) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      configuration,
      tenantKey: identifier(record.tenantKey),
      assertLeaseHeld: method(record.lease),
      resolver,
      scopeProbe,
      rotationCoordinator,
      httpClient,
      now: now as () => number,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function requestInstant(value: unknown): string {
  const timestamp = parseIsoTimestamp(value)
  if (new Date(Date.parse(timestamp)).toISOString() !== timestamp) throw new TypeError()
  return timestamp
}

function readRequest(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  tenantKey: string,
): FeishuUserMessageSearchRequest {
  try {
    const record = dataRecord(value)
    exactKeys(
      record,
      Object.hasOwn(record, 'pageToken')
        ? [
            'identityType',
            'accountId',
            'appId',
            'tenantKey',
            'userPrincipalId',
            'startTime',
            'endTime',
            'pageSize',
            'pageToken',
          ]
        : [
            'identityType',
            'accountId',
            'appId',
            'tenantKey',
            'userPrincipalId',
            'startTime',
            'endTime',
            'pageSize',
          ],
    )
    const user = configuration.user
    const startTime = requestInstant(record.startTime)
    const endTime = requestInstant(record.endTime)
    const pageToken = Object.hasOwn(record, 'pageToken')
      ? opaquePageToken(record.pageToken)
      : undefined
    if (
      user === undefined ||
      record.identityType !== 'user' ||
      record.accountId !== configuration.accountId ||
      record.appId !== configuration.appId ||
      record.tenantKey !== tenantKey ||
      record.userPrincipalId !== user.principalId ||
      Date.parse(startTime) >= Date.parse(endTime) ||
      !Number.isSafeInteger(record.pageSize) ||
      (record.pageSize as number) < 1 ||
      (record.pageSize as number) > MAX_PAGE_SIZE
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      identityType: 'user',
      accountId: configuration.accountId,
      appId: configuration.appId,
      tenantKey,
      userPrincipalId: user.principalId,
      startTime,
      endTime,
      pageSize: record.pageSize as number,
      ...(pageToken === undefined ? {} : { pageToken }),
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function mapError(error: unknown): FeishuUserMessageSearchClientError {
  if (error instanceof FeishuUserMessageSearchClientError) return error
  if (error instanceof FeishuOperationScopeAuthorizationError) {
    if (error.code === 'not_authorized') return clientError('not_authorized')
    if (error.code === 'scope_missing') return clientError('scope_missing')
    if (
      error.code === 'credential_refresh_required' ||
      error.code === 'observation_stale' ||
      error.code === 'probe_unavailable'
    ) {
      return clientError('network')
    }
    return clientError('invalid_response')
  }
  if (error instanceof FeishuOAuthRotationError) {
    if (error.code === 'reauthorization_required') return clientError('not_authorized')
    if (
      error.code === 'rotation_pending' ||
      error.code === 'rotation_uncertain' ||
      error.code === 'journal_unavailable'
    ) {
      return clientError('unknown')
    }
    return clientError('invalid_response')
  }
  if (error instanceof FeishuSystemKeychainError) {
    if (error.code === 'not_found') return clientError('not_authorized')
    if (error.code === 'unavailable') return clientError('network')
    return clientError('invalid_response')
  }
  if (error instanceof FeishuCredentialBundleError) {
    if (error.code === 'credential_expired') return clientError('not_authorized')
    return clientError('invalid_response')
  }
  if (error instanceof FeishuRuntimeLeaseError) return clientError('unknown')
  return clientError('unknown')
}

/**
 * Configured production User search client for one already-held Host lease.
 * Rotation, scope authorization, and a final Keychain read all precede HTTP.
 */
export class FeishuUserMessageSearchAdapter implements FeishuUserMessageSearchClient {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #tenantKey: string
  readonly #assertLeaseHeld: AssertLeaseHeld
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #scopeAuthorizer: FeishuOperationScopeAuthorizer
  readonly #rotationCoordinator: FeishuOAuthRotationCoordinator
  readonly #httpClient: FeishuUserMessageSearchHttpClient
  readonly #now: () => number

  constructor(options: FeishuUserMessageSearchAdapterOptions) {
    const validated = readOptions(options)
    this.#configuration = validated.configuration
    this.#tenantKey = validated.tenantKey
    this.#assertLeaseHeld = validated.assertLeaseHeld
    this.#resolver = validated.resolver
    this.#scopeAuthorizer = new FeishuOperationScopeAuthorizer({
      configuration: validated.configuration,
      client: validated.scopeProbe,
      now: validated.now,
    })
    this.#rotationCoordinator = validated.rotationCoordinator
    this.#httpClient = validated.httpClient
    this.#now = validated.now
  }

  async search(
    requestValue: FeishuUserMessageSearchRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
    signal.throwIfAborted()
    const request = readRequest(requestValue, this.#configuration, this.#tenantKey)
    try {
      this.#assertLeaseHeld()
      await this.#rotationCoordinator.refreshIfNeeded(this.#configuration, signal)
      this.#assertLeaseHeld()
      return await this.#scopeAuthorizer.withAuthorizedOperation(
        'user_message_discovery',
        signal,
        async () => {
          this.#assertLeaseHeld()
          const user = this.#configuration.user
          if (user === undefined) throw clientError('invalid_response')
          const parser = new FeishuCredentialBundleParser({ now: this.#now })
          return this.#resolver.withSecret(user.credentialReference, signal, (bundle) =>
            parser.withCredential(
              this.#configuration,
              'user',
              bundle,
              signal,
              async (credential) => {
                const requiredScopes = requiredFeishuOperationScopes('user_message_discovery')
                if (
                  credential.kind !== 'feishu_user_oauth_credential_bundle' ||
                  credential.accessTokenStatus !== 'usable'
                ) {
                  throw clientError('not_authorized')
                }
                if (requiredScopes.some((scope) => !credential.scopes.includes(scope))) {
                  throw clientError('scope_missing')
                }
                this.#assertLeaseHeld()
                const result = await this.#httpClient.search(
                  Object.freeze({ ...request, accessToken: credential.accessToken }),
                  signal,
                )
                signal.throwIfAborted()
                this.#assertLeaseHeld()
                return result
              },
            ),
          )
        },
      )
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      throw mapError(error)
    }
  }
}
