import { parseIsoTimestamp, type IsoTimestamp, type SecretReference } from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION = 1 as const
export const FEISHU_SCOPE_OBSERVATION_MAX_AGE_MS = 60_000
const MAX_CLOCK_SKEW_MS = 5 * 60_000

export type FeishuScopedOperation = 'bot_reply' | 'user_reply' | 'user_message_discovery'

export type FeishuOperationScopeAuthorizationErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'not_authorized'
  | 'scope_missing'
  | 'observation_stale'
  | 'probe_unavailable'

export type FeishuOperationScopeAuthorizationRecovery =
  'do_not_retry' | 'repair_configuration' | 'reauthorize' | 'grant_scope' | 'retry'

export class FeishuOperationScopeAuthorizationError extends Error {
  readonly code: FeishuOperationScopeAuthorizationErrorCode
  readonly recovery: FeishuOperationScopeAuthorizationRecovery

  constructor(
    code: FeishuOperationScopeAuthorizationErrorCode,
    recovery: FeishuOperationScopeAuthorizationRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOperationScopeAuthorizationError'
    this.code = code
    this.recovery = recovery
  }
}

export type FeishuOperationScopeProbeClientErrorCode =
  'not_authorized' | 'rate_limited' | 'network' | 'invalid_response' | 'unavailable' | 'unknown'

export class FeishuOperationScopeProbeClientError extends Error {
  readonly code: FeishuOperationScopeProbeClientErrorCode

  constructor(code: FeishuOperationScopeProbeClientErrorCode) {
    const supported = [
      'not_authorized',
      'rate_limited',
      'network',
      'invalid_response',
      'unavailable',
      'unknown',
    ] as const
    const normalized =
      typeof code === 'string' && supported.includes(code as (typeof supported)[number])
        ? (code as FeishuOperationScopeProbeClientErrorCode)
        : 'unknown'
    super('The Feishu operation scope probe failed.')
    this.name = 'FeishuOperationScopeProbeClientError'
    this.code = normalized
  }
}

export interface FeishuOperationScopeProbeRequest {
  readonly kind: 'feishu_operation_scope_probe_request'
  readonly schemaVersion: typeof FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION
  readonly accountId: string
  readonly appId: string
  readonly identityType: 'bot' | 'user'
  readonly principalId: string
  readonly credentialReference: SecretReference
  readonly operation: FeishuScopedOperation
  readonly requiredScopes: readonly string[]
}

export interface FeishuOperationScopeProbeClient {
  /** Resolve the exact identity and return a fresh, normalized scope observation. */
  inspectCurrentScopes(
    request: FeishuOperationScopeProbeRequest,
    signal: AbortSignal,
  ): Promise<unknown>
}

export interface FeishuOperationScopeAuthorization {
  readonly kind: 'feishu_operation_scope_authorization'
  readonly schemaVersion: typeof FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION
  readonly accountId: string
  readonly identityType: 'bot' | 'user'
  readonly operation: FeishuScopedOperation
  readonly requiredScopes: readonly string[]
  readonly grantedScopes: readonly string[]
  readonly observedAt: IsoTimestamp
}

export interface FeishuOperationScopeAuthorizerOptions {
  readonly configuration: unknown
  readonly client: FeishuOperationScopeProbeClient
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const POLICIES: Readonly<
  Record<
    FeishuScopedOperation,
    Readonly<{ identityType: 'bot' | 'user'; scopes: readonly string[] }>
  >
> = Object.freeze({
  bot_reply: Object.freeze({
    identityType: 'bot',
    scopes: Object.freeze(['im:message:send_as_bot']),
  }),
  user_reply: Object.freeze({
    identityType: 'user',
    scopes: Object.freeze(['im:message:send_as_user']),
  }),
  user_message_discovery: Object.freeze({
    identityType: 'user',
    scopes: Object.freeze(['im:chat:read', 'im:message:readonly', 'search:message']),
  }),
})

function fail(
  code: FeishuOperationScopeAuthorizationErrorCode,
  recovery: FeishuOperationScopeAuthorizationRecovery,
  message: string,
): FeishuOperationScopeAuthorizationError {
  return new FeishuOperationScopeAuthorizationError(code, recovery, message)
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

function method(value: unknown): FeishuOperationScopeProbeClient['inspectCurrentScopes'] {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      throw new TypeError()
    }
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'inspectCurrentScopes')
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return descriptor.value.bind(
          value,
        ) as FeishuOperationScopeProbeClient['inspectCurrentScopes']
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu scope probe adapter is invalid.')
  }
}

function readOptions(value: unknown): Readonly<{
  configuration: FeishuIdentityConfiguration
  inspect: FeishuOperationScopeProbeClient['inspectCurrentScopes']
  now: () => number
}> {
  try {
    const record = dataRecord(value)
    exactKeys(
      record,
      Object.hasOwn(record, 'now')
        ? ['configuration', 'client', 'now']
        : ['configuration', 'client'],
    )
    const nowValue = Object.hasOwn(record, 'now') ? record.now : Date.now
    if (typeof nowValue !== 'function') throw new TypeError()
    const now = nowValue as () => number
    return Object.freeze({
      configuration: parseFeishuIdentityConfiguration(record.configuration),
      inspect: method(record.client),
      now,
    })
  } catch (error) {
    if (error instanceof FeishuOperationScopeAuthorizationError) throw error
    throw fail('invalid_request', 'do_not_retry', 'The Feishu scope authorizer is invalid.')
  }
}

function policy(value: unknown): Readonly<{
  operation: FeishuScopedOperation
  identityType: 'bot' | 'user'
  scopes: readonly string[]
}> {
  if (typeof value !== 'string' || !Object.hasOwn(POLICIES, value)) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu operation is invalid.')
  }
  const operation = value as FeishuScopedOperation
  const selected = POLICIES[operation]
  return Object.freeze({ operation, identityType: selected.identityType, scopes: selected.scopes })
}

function scopeList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError()
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
  const scopes = Array.from({ length: value.length }, (_, index) => {
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
  if (new Set(scopes).size !== scopes.length) throw new TypeError()
  return Object.freeze(scopes.toSorted())
}

function clock(now: () => number): number {
  let value: number
  try {
    value = now()
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu scope clock is invalid.')
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu scope clock is invalid.')
  }
  return value
}

function authorizationFailure(
  identityType: 'bot' | 'user',
): FeishuOperationScopeAuthorizationError {
  return fail(
    'not_authorized',
    identityType === 'user' ? 'reauthorize' : 'repair_configuration',
    'The configured Feishu identity is not authorized.',
  )
}

function mapClientError(
  error: unknown,
  identityType: 'bot' | 'user',
): FeishuOperationScopeAuthorizationError {
  if (error instanceof FeishuOperationScopeProbeClientError) {
    if (error.code === 'not_authorized') {
      return authorizationFailure(identityType)
    }
    if (error.code === 'invalid_response') {
      return fail('invalid_client', 'do_not_retry', 'The Feishu scope probe response is invalid.')
    }
  }
  return fail('probe_unavailable', 'retry', 'The current Feishu scope state is unavailable.')
}

export function requiredFeishuOperationScopes(operationValue: unknown): readonly string[] {
  return policy(operationValue).scopes
}

/**
 * Recheck one fixed operation policy immediately before invoking its callback.
 * Scope evidence grants no approval and carries no credential value.
 */
export class FeishuOperationScopeAuthorizer {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #inspect: FeishuOperationScopeProbeClient['inspectCurrentScopes']
  readonly #now: () => number

  constructor(options: FeishuOperationScopeAuthorizerOptions) {
    const validated = readOptions(options)
    this.#configuration = validated.configuration
    this.#inspect = validated.inspect
    this.#now = validated.now
  }

  async withAuthorizedOperation<TResult>(
    operationValue: unknown,
    signal: AbortSignal,
    consume: (authorization: FeishuOperationScopeAuthorization) => Promise<TResult>,
  ): Promise<TResult> {
    signal.throwIfAborted()
    const selected = policy(operationValue)
    if (typeof consume !== 'function') {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu scope consumer is invalid.')
    }
    const identity = this.#configuration[selected.identityType]
    if (identity === undefined) {
      throw fail(
        'not_authorized',
        'repair_configuration',
        'The required Feishu identity is not configured.',
      )
    }
    const request: FeishuOperationScopeProbeRequest = Object.freeze({
      kind: 'feishu_operation_scope_probe_request',
      schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
      accountId: this.#configuration.accountId,
      appId: this.#configuration.appId,
      identityType: selected.identityType,
      principalId: identity.principalId,
      credentialReference: identity.credentialReference,
      operation: selected.operation,
      requiredScopes: selected.scopes,
    })
    clock(this.#now)
    let response: unknown
    try {
      response = await this.#inspect(request, signal)
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      throw mapClientError(error, selected.identityType)
    }
    signal.throwIfAborted()
    let record: UnknownRecord
    let observedAt: IsoTimestamp
    let grantedScopes: readonly string[]
    try {
      record = dataRecord(response)
      exactKeys(record, [
        'kind',
        'schemaVersion',
        'accountId',
        'appId',
        'identityType',
        'principalId',
        'operation',
        'authorization',
        'grantedScopes',
        'observedAt',
      ])
      observedAt = parseIsoTimestamp(record.observedAt)
      grantedScopes = scopeList(record.grantedScopes)
      if (
        record.kind !== 'feishu_operation_scope_probe_result' ||
        record.schemaVersion !== FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION ||
        record.accountId !== request.accountId ||
        record.appId !== request.appId ||
        record.identityType !== request.identityType ||
        record.principalId !== request.principalId ||
        record.operation !== request.operation ||
        (record.authorization !== 'authorized' && record.authorization !== 'not_authorized')
      ) {
        throw new TypeError()
      }
    } catch {
      throw fail('invalid_client', 'do_not_retry', 'The Feishu scope probe response is invalid.')
    }
    const now = clock(this.#now)
    const observedMilliseconds = Date.parse(observedAt)
    if (
      observedMilliseconds > now + MAX_CLOCK_SKEW_MS ||
      now - observedMilliseconds > FEISHU_SCOPE_OBSERVATION_MAX_AGE_MS
    ) {
      throw fail('observation_stale', 'retry', 'The Feishu scope observation is not current.')
    }
    if (record.authorization !== 'authorized') {
      throw authorizationFailure(selected.identityType)
    }
    const granted = new Set(grantedScopes)
    if (selected.scopes.some((scope) => !granted.has(scope))) {
      throw fail(
        'scope_missing',
        'grant_scope',
        'The configured Feishu identity is missing a required operation scope.',
      )
    }
    signal.throwIfAborted()
    return consume(
      Object.freeze({
        kind: 'feishu_operation_scope_authorization',
        schemaVersion: FEISHU_OPERATION_SCOPE_AUTHORIZATION_VERSION,
        accountId: this.#configuration.accountId,
        identityType: selected.identityType,
        operation: selected.operation,
        requiredScopes: selected.scopes,
        grantedScopes,
        observedAt,
      }),
    )
  }
}
