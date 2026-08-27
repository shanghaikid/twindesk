import {
  parseConnectorCursor,
  parseIsoTimestamp,
  type ConnectorCursor,
  type ConnectorHealth,
  type ConnectorIssue,
  type IsoTimestamp,
  type SecretReference,
} from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import { FEISHU_USER_MESSAGE_STREAM } from './user-message-discovery.ts'

export const FEISHU_CONNECTOR_DIAGNOSTICS_VERSION = 1 as const
export const DEFAULT_FEISHU_CURSOR_STALE_AFTER_MS = 15 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

export type FeishuDiagnosticsClientErrorCode =
  | 'not_authorized'
  | 'rate_limited'
  | 'network'
  | 'invalid_response'
  | 'storage_unavailable'
  | 'unknown'

export class FeishuDiagnosticsClientError extends Error {
  readonly code: FeishuDiagnosticsClientErrorCode

  constructor(code: FeishuDiagnosticsClientErrorCode) {
    const supported = [
      'not_authorized',
      'rate_limited',
      'network',
      'invalid_response',
      'storage_unavailable',
      'unknown',
    ] as const
    const normalized =
      typeof code === 'string' && supported.includes(code as (typeof supported)[number])
        ? (code as FeishuDiagnosticsClientErrorCode)
        : 'unknown'
    super('The Feishu diagnostics adapter failed.')
    this.name = 'FeishuDiagnosticsClientError'
    this.code = normalized
  }
}

export type FeishuConnectorDiagnosticsErrorCode =
  'invalid_configuration' | 'invalid_client' | 'invalid_clock'

export class FeishuConnectorDiagnosticsError extends Error {
  readonly code: FeishuConnectorDiagnosticsErrorCode

  constructor(code: FeishuConnectorDiagnosticsErrorCode, message: string) {
    super(message)
    this.name = 'FeishuConnectorDiagnosticsError'
    this.code = code
  }
}

export interface FeishuIdentityProbeRequest {
  readonly kind: 'feishu_identity_probe_request'
  readonly schemaVersion: typeof FEISHU_CONNECTOR_DIAGNOSTICS_VERSION
  readonly accountId: string
  readonly appId: string
  readonly identityType: 'bot' | 'user'
  readonly principalId: string
  readonly credentialReference: SecretReference
}

export interface FeishuCursorProbeRequest {
  readonly kind: 'feishu_cursor_probe_request'
  readonly schemaVersion: typeof FEISHU_CONNECTOR_DIAGNOSTICS_VERSION
  readonly connectorId: 'feishu'
  readonly accountId: string
  readonly streams: readonly string[]
}

export interface FeishuConnectorDiagnosticsClient {
  /** Resolve the credential reference and return normalized authorization metadata. */
  inspectIdentity(request: FeishuIdentityProbeRequest, signal: AbortSignal): Promise<unknown>
  /** Read product-owned durable cursors without returning external payloads. */
  readCursors(request: FeishuCursorProbeRequest, signal: AbortSignal): Promise<unknown>
}

export type FeishuRateLimitDiagnostic =
  | Readonly<{
      identityType: 'bot' | 'user'
      status: 'available'
      limit: number
      remaining: number
      resetsAt: IsoTimestamp
    }>
  | Readonly<{
      identityType: 'bot' | 'user'
      status: 'limited'
      resetsAt: IsoTimestamp
    }>
  | Readonly<{
      identityType: 'bot' | 'user'
      status: 'unknown'
    }>

type FeishuRateLimitObservation =
  | Readonly<{
      status: 'available'
      limit: number
      remaining: number
      resetsAt: IsoTimestamp
    }>
  | Readonly<{ status: 'limited'; resetsAt: IsoTimestamp }>
  | Readonly<{ status: 'unknown' }>

export interface FeishuCursorDiagnostic {
  readonly stream: string
  readonly status: 'current' | 'stale' | 'future' | 'not_started' | 'unavailable'
  readonly updatedAt?: IsoTimestamp
  readonly committedThrough?: IsoTimestamp
}

export interface FeishuConnectorDiagnostics {
  readonly kind: 'feishu_connector_diagnostics'
  readonly schemaVersion: typeof FEISHU_CONNECTOR_DIAGNOSTICS_VERSION
  readonly health: ConnectorHealth
  readonly rateLimits: readonly FeishuRateLimitDiagnostic[]
  readonly cursors: readonly FeishuCursorDiagnostic[]
}

export interface FeishuConnectorDiagnosticsOptions {
  readonly now?: () => number
  readonly cursorStaleAfterMs?: number
  readonly streams?: readonly string[]
}

interface ParsedIdentityObservation {
  readonly identityType: 'bot' | 'user'
  readonly authorization: 'authorized' | 'not_authorized'
  readonly requiredScopes: readonly string[]
  readonly grantedScopes: readonly string[]
  readonly rateLimit: FeishuRateLimitObservation
}

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(
  code: FeishuConnectorDiagnosticsErrorCode,
  message: string,
): FeishuConnectorDiagnosticsError {
  return new FeishuConnectorDiagnosticsError(code, message)
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

function exactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new TypeError()
  }
}

function boundedString(value: unknown, maximum = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function boundedName(value: unknown): string {
  const name = boundedString(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(name)) throw new TypeError()
  return name
}

function timestamp(value: unknown): IsoTimestamp {
  return parseIsoTimestamp(value)
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError()
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length > 256
  ) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(descriptors).some((key) => key !== 'length' && !/^\d+$/u.test(key)) ||
    Object.keys(descriptors).filter((key) => /^\d+$/u.test(key)).length !== value.length
  ) {
    throw new TypeError()
  }
  const values = Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
    return boundedName(descriptor.value)
  })
  if (new Set(values).size !== values.length) throw new TypeError()
  return Object.freeze(values.toSorted())
}

function parseRateLimit(value: unknown, nowMs: number): FeishuRateLimitObservation {
  const record = dataRecord(value)
  if (record.status === 'unknown') {
    exactKeys(record, ['status'])
    return Object.freeze({ status: 'unknown' })
  }
  if (record.status === 'limited') {
    exactKeys(record, ['status', 'resetsAt'])
    const resetsAt = timestamp(record.resetsAt)
    if (Date.parse(resetsAt) < nowMs - MAX_CLOCK_SKEW_MS) throw new TypeError()
    return Object.freeze({ status: 'limited', resetsAt })
  }
  if (record.status !== 'available') throw new TypeError()
  exactKeys(record, ['status', 'limit', 'remaining', 'resetsAt'])
  if (
    !Number.isSafeInteger(record.limit) ||
    !Number.isSafeInteger(record.remaining) ||
    (record.limit as number) <= 0 ||
    (record.remaining as number) < 0 ||
    (record.remaining as number) > (record.limit as number)
  ) {
    throw new TypeError()
  }
  const resetsAt = timestamp(record.resetsAt)
  if (Date.parse(resetsAt) < nowMs - MAX_CLOCK_SKEW_MS) throw new TypeError()
  if ((record.remaining as number) === 0) {
    return Object.freeze({ status: 'limited', resetsAt })
  }
  return Object.freeze({
    status: 'available',
    limit: record.limit as number,
    remaining: record.remaining as number,
    resetsAt,
  })
}

function parseIdentityObservation(
  value: unknown,
  request: FeishuIdentityProbeRequest,
  nowMs: number,
): ParsedIdentityObservation {
  const record = dataRecord(value)
  exactKeys(record, [
    'kind',
    'schemaVersion',
    'accountId',
    'appId',
    'identityType',
    'principalId',
    'authorization',
    'requiredScopes',
    'grantedScopes',
    'rateLimit',
  ])
  if (
    record.kind !== 'feishu_identity_probe_result' ||
    record.schemaVersion !== 1 ||
    record.accountId !== request.accountId ||
    record.appId !== request.appId ||
    record.identityType !== request.identityType ||
    record.principalId !== request.principalId ||
    (record.authorization !== 'authorized' && record.authorization !== 'not_authorized')
  ) {
    throw new TypeError()
  }
  const requiredScopes = stringList(record.requiredScopes)
  if (requiredScopes.length === 0) throw new TypeError()
  return Object.freeze({
    identityType: request.identityType,
    authorization: record.authorization,
    requiredScopes,
    grantedScopes: stringList(record.grantedScopes),
    rateLimit: parseRateLimit(record.rateLimit, nowMs),
  })
}

function issue(code: string, message: string, retryable: boolean): ConnectorIssue {
  return Object.freeze({ code, message, retryable })
}

function clientIssue(error: unknown, identityType?: 'bot' | 'user'): ConnectorIssue {
  const code = error instanceof FeishuDiagnosticsClientError ? error.code : 'unknown'
  const prefix = identityType === undefined ? 'cursor' : `${identityType}_identity`
  switch (code) {
    case 'not_authorized':
      return issue(
        `${prefix}_not_authorized`,
        'A configured Feishu identity is not authorized.',
        false,
      )
    case 'rate_limited':
      return issue(`${prefix}_rate_limited`, 'The Feishu diagnostic probe is rate limited.', true)
    case 'storage_unavailable':
      return identityType === undefined
        ? issue(
            'cursor_storage_unavailable',
            'The durable Feishu cursor store is unavailable.',
            true,
          )
        : issue(
            `${prefix}_storage_unavailable`,
            'The configured Feishu identity credential store is unavailable.',
            true,
          )
    case 'network':
      return issue(
        `${prefix}_network`,
        'The Feishu diagnostic probe could not reach its service.',
        true,
      )
    case 'invalid_response':
      return issue(
        `${prefix}_invalid_response`,
        'The Feishu diagnostic response is invalid.',
        false,
      )
    case 'unknown':
    default:
      return issue(`${prefix}_probe_failed`, 'The Feishu diagnostic probe failed.', true)
  }
}

function rateDiagnostic(
  identityType: 'bot' | 'user',
  value: FeishuRateLimitObservation | undefined,
): FeishuRateLimitDiagnostic {
  if (value === undefined || value.status === 'unknown') {
    return Object.freeze({ identityType, status: 'unknown' })
  }
  if (value.status === 'limited') {
    return Object.freeze({ identityType, status: 'limited', resetsAt: value.resetsAt })
  }
  return Object.freeze({
    identityType,
    status: 'available',
    limit: value.limit,
    remaining: value.remaining,
    resetsAt: value.resetsAt,
  })
}

function cursorResponse(
  value: unknown,
  request: FeishuCursorProbeRequest,
): readonly ConnectorCursor[] {
  const record = dataRecord(value)
  exactKeys(record, ['kind', 'schemaVersion', 'connectorId', 'accountId', 'cursors'])
  if (
    record.kind !== 'feishu_cursor_probe_result' ||
    record.schemaVersion !== 1 ||
    record.connectorId !== request.connectorId ||
    record.accountId !== request.accountId ||
    !Array.isArray(record.cursors)
  ) {
    throw new TypeError()
  }
  if (
    Object.getPrototypeOf(record.cursors) !== Array.prototype ||
    Object.getOwnPropertySymbols(record.cursors).length !== 0 ||
    record.cursors.length > 256
  ) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.cursors)
  if (
    Object.keys(descriptors).some((key) => key !== 'length' && !/^\d+$/u.test(key)) ||
    Object.keys(descriptors).filter((key) => /^\d+$/u.test(key)).length !== record.cursors.length
  ) {
    throw new TypeError()
  }
  const cursors = Array.from({ length: record.cursors.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
    return parseConnectorCursor(descriptor.value)
  })
  if (
    cursors.some(
      (cursor) =>
        cursor.connectorId !== 'feishu' ||
        cursor.accountId !== request.accountId ||
        !request.streams.includes(cursor.stream),
    ) ||
    new Set(cursors.map((cursor) => cursor.stream)).size !== cursors.length
  ) {
    throw new TypeError()
  }
  return Object.freeze(cursors)
}

function validateStreams(value: readonly string[] | undefined): readonly string[] {
  const streams = value ?? [FEISHU_USER_MESSAGE_STREAM]
  const parsed = stringList(streams)
  if (parsed.length === 0) throw new TypeError()
  return parsed
}

export class FeishuConnectorDiagnosticsService {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #client: FeishuConnectorDiagnosticsClient
  readonly #now: () => number
  readonly #cursorStaleAfterMs: number
  readonly #streams: readonly string[]

  constructor(
    configuration: unknown,
    client: FeishuConnectorDiagnosticsClient,
    options: FeishuConnectorDiagnosticsOptions = {},
  ) {
    try {
      this.#configuration = parseFeishuIdentityConfiguration(configuration)
    } catch {
      throw fail('invalid_configuration', 'The Feishu diagnostics configuration is invalid.')
    }
    if (
      typeof client !== 'object' ||
      client === null ||
      typeof client.inspectIdentity !== 'function' ||
      typeof client.readCursors !== 'function'
    ) {
      throw fail('invalid_client', 'The Feishu diagnostics client is invalid.')
    }
    this.#client = client
    this.#now = options.now ?? Date.now
    const staleAfter = options.cursorStaleAfterMs ?? DEFAULT_FEISHU_CURSOR_STALE_AFTER_MS
    if (
      !Number.isSafeInteger(staleAfter) ||
      staleAfter <= 0 ||
      staleAfter > 30 * 24 * 60 * 60 * 1_000
    ) {
      throw fail('invalid_configuration', 'The Feishu cursor freshness policy is invalid.')
    }
    this.#cursorStaleAfterMs = staleAfter
    try {
      this.#streams = validateStreams(options.streams)
    } catch {
      throw fail('invalid_configuration', 'The Feishu diagnostic streams are invalid.')
    }
  }

  async health(signal: AbortSignal): Promise<ConnectorHealth> {
    return (await this.diagnose(signal)).health
  }

  async diagnose(signal: AbortSignal): Promise<FeishuConnectorDiagnostics> {
    signal.throwIfAborted()
    const nowMs = this.#readClock()
    const checkedAt = timestamp(new Date(nowMs).toISOString())
    const identities = (['bot', 'user'] as const).filter(
      (identityType) => this.#configuration[identityType] !== undefined,
    )
    const identityResults = await Promise.all(
      identities.map(async (identityType) => {
        const identity = this.#configuration[identityType]
        if (identity === undefined) throw new TypeError()
        const request: FeishuIdentityProbeRequest = Object.freeze({
          kind: 'feishu_identity_probe_request',
          schemaVersion: FEISHU_CONNECTOR_DIAGNOSTICS_VERSION,
          accountId: this.#configuration.accountId,
          appId: this.#configuration.appId,
          identityType,
          principalId: identity.principalId,
          credentialReference: identity.credentialReference,
        })
        let response: unknown
        try {
          response = await this.#client.inspectIdentity(request, signal)
          signal.throwIfAborted()
        } catch (error) {
          signal.throwIfAborted()
          return Object.freeze({ identityType, error: clientIssue(error, identityType) })
        }
        try {
          const observation = parseIdentityObservation(response, request, nowMs)
          return Object.freeze({ identityType, observation })
        } catch {
          return Object.freeze({
            identityType,
            error: clientIssue(new FeishuDiagnosticsClientError('invalid_response'), identityType),
          })
        }
      }),
    )

    const issues: ConnectorIssue[] = []
    const healthIdentities = identityResults.map((result) => {
      const configured = this.#configuration[result.identityType]
      if (configured === undefined) throw new TypeError()
      if ('error' in result) {
        issues.push(result.error)
        return Object.freeze({
          accountId: this.#configuration.accountId,
          identityType: result.identityType,
          displayName: configured.displayName,
          requiredScopes: Object.freeze([]),
          grantedScopes: Object.freeze([]),
          missingScopes: Object.freeze([]),
        })
      }
      const observation = result.observation
      const granted = new Set(observation.grantedScopes)
      const missingScopes = Object.freeze(
        observation.requiredScopes.filter((scope) => !granted.has(scope)),
      )
      if (observation.authorization === 'not_authorized') {
        issues.push(
          issue(
            `${result.identityType}_identity_not_authorized`,
            'A configured Feishu identity is not authorized.',
            false,
          ),
        )
      }
      if (missingScopes.length > 0) {
        issues.push(
          issue(
            `${result.identityType}_scope_missing`,
            'A configured Feishu identity is missing a required scope.',
            false,
          ),
        )
      }
      if (observation.rateLimit.status === 'limited') {
        issues.push(
          issue(
            `${result.identityType}_rate_limited`,
            'A configured Feishu identity is currently rate limited.',
            true,
          ),
        )
      }
      return Object.freeze({
        accountId: this.#configuration.accountId,
        identityType: result.identityType,
        displayName: configured.displayName,
        requiredScopes: observation.requiredScopes,
        grantedScopes: observation.grantedScopes,
        missingScopes,
      })
    })

    const rateLimits: FeishuRateLimitDiagnostic[] = identityResults.map((result) =>
      rateDiagnostic(
        result.identityType,
        'observation' in result ? result.observation.rateLimit : undefined,
      ),
    )

    signal.throwIfAborted()
    const cursorRequest: FeishuCursorProbeRequest = Object.freeze({
      kind: 'feishu_cursor_probe_request',
      schemaVersion: FEISHU_CONNECTOR_DIAGNOSTICS_VERSION,
      connectorId: 'feishu',
      accountId: this.#configuration.accountId,
      streams: this.#streams,
    })
    let cursors: readonly FeishuCursorDiagnostic[] = Object.freeze(
      this.#streams.map((stream) => Object.freeze({ stream, status: 'unavailable' as const })),
    )
    let cursorValue: unknown
    let cursorReadSucceeded = false
    try {
      cursorValue = await this.#client.readCursors(cursorRequest, signal)
      signal.throwIfAborted()
      cursorReadSucceeded = true
    } catch (error) {
      signal.throwIfAborted()
      issues.push(clientIssue(error))
      cursors = Object.freeze(
        this.#streams.map((stream) => Object.freeze({ stream, status: 'unavailable' as const })),
      )
      cursorValue = undefined
    }
    if (cursorReadSucceeded) {
      try {
        const stored = cursorResponse(cursorValue, cursorRequest)
        const byStream = new Map(stored.map((cursor) => [cursor.stream, cursor]))
        cursors = Object.freeze(
          this.#streams.map((stream) => {
            const cursor = byStream.get(stream)
            if (cursor === undefined)
              return Object.freeze({ stream, status: 'not_started' as const })
            const updated = Date.parse(cursor.updatedAt)
            const status =
              updated > nowMs + MAX_CLOCK_SKEW_MS
                ? ('future' as const)
                : nowMs - updated > this.#cursorStaleAfterMs
                  ? ('stale' as const)
                  : ('current' as const)
            if (status === 'future') {
              issues.push(
                issue(
                  'cursor_in_future',
                  'A durable Feishu cursor is newer than the local clock.',
                  false,
                ),
              )
            } else if (status === 'stale') {
              issues.push(
                issue('cursor_stale', 'A durable Feishu cursor has not advanced recently.', true),
              )
            }
            return Object.freeze({
              stream,
              status,
              updatedAt: cursor.updatedAt,
              ...(cursor.committedThrough === undefined
                ? {}
                : { committedThrough: cursor.committedThrough }),
            })
          }),
        )
      } catch {
        issues.push(clientIssue(new FeishuDiagnosticsClientError('invalid_response')))
        cursors = Object.freeze(
          this.#streams.map((stream) => Object.freeze({ stream, status: 'unavailable' as const })),
        )
      }
    }

    const availableIdentities = identityResults.filter(
      (result) => 'observation' in result && result.observation.authorization === 'authorized',
    ).length
    const status: ConnectorHealth['status'] =
      availableIdentities === 0 ? 'unavailable' : issues.length === 0 ? 'healthy' : 'degraded'
    const health: ConnectorHealth = Object.freeze({
      connectorId: 'feishu',
      status,
      checkedAt,
      identities: Object.freeze(healthIdentities),
      issues: Object.freeze(issues),
    })
    return Object.freeze({
      kind: 'feishu_connector_diagnostics',
      schemaVersion: FEISHU_CONNECTOR_DIAGNOSTICS_VERSION,
      health,
      rateLimits: Object.freeze(rateLimits),
      cursors,
    })
  }

  #readClock(): number {
    let value: number
    try {
      value = this.#now()
    } catch {
      throw fail('invalid_clock', 'The Feishu diagnostics clock is invalid.')
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw fail('invalid_clock', 'The Feishu diagnostics clock is invalid.')
    }
    return value
  }
}
