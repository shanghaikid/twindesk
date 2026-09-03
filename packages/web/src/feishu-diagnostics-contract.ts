export type FeishuDiagnosticRecovery =
  'reauthorize' | 'grant_scope' | 'retry' | 'repair_configuration' | 'restart_host'

export type FeishuRuntimeDiagnostic =
  | Readonly<{
      version: 1
      state: 'disabled'
      reason: 'not_configured' | 'host_configuration_missing'
    }>
  | Readonly<{ version: 1; state: 'starting' | 'running' | 'stopped' }>
  | Readonly<{
      version: 1
      state: 'attention_required'
      recovery: Exclude<FeishuDiagnosticRecovery, 'retry'>
    }>

export interface FeishuDiagnosticsSnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly status: 'not_configured' | 'healthy' | 'degraded' | 'unavailable'
  readonly checkedAt: string | null
  readonly runtime: FeishuRuntimeDiagnostic
  readonly identities: readonly Readonly<{
    identityType: 'bot' | 'user'
    status: 'ready' | 'attention_required' | 'unavailable'
    requiredScopes: readonly string[]
    missingScopes: readonly string[]
  }>[]
  readonly rateLimits: readonly Readonly<{
    identityType: 'bot' | 'user'
    status: 'available' | 'limited' | 'unknown'
    resetsAt?: string
  }>[]
  readonly cursors: readonly Readonly<{
    stream: string
    status: 'current' | 'stale' | 'future' | 'not_started' | 'unavailable'
    updatedAt?: string
    committedThrough?: string
  }>[]
  readonly issues: readonly Readonly<{
    code: string
    recovery: FeishuDiagnosticRecovery
  }>[]
}

type UnknownRecord = Readonly<Record<string, unknown>>

const REQUIRED_SCOPES = Object.freeze({
  bot: Object.freeze(['im:message:send_as_bot']),
  user: Object.freeze([
    'im:chat:read',
    'im:message:readonly',
    'im:message:send_as_user',
    'search:message',
  ]),
})
const ISSUE_RECOVERY = Object.freeze({
  bot_identity_not_authorized: 'repair_configuration',
  bot_identity_rate_limited: 'retry',
  bot_identity_storage_unavailable: 'restart_host',
  bot_identity_network: 'retry',
  bot_identity_invalid_response: 'repair_configuration',
  bot_identity_probe_failed: 'restart_host',
  bot_scope_missing: 'grant_scope',
  bot_rate_limited: 'retry',
  user_identity_not_authorized: 'reauthorize',
  user_identity_rate_limited: 'retry',
  user_identity_storage_unavailable: 'restart_host',
  user_identity_network: 'retry',
  user_identity_invalid_response: 'repair_configuration',
  user_identity_probe_failed: 'restart_host',
  user_scope_missing: 'grant_scope',
  user_rate_limited: 'retry',
  cursor_not_authorized: 'retry',
  cursor_rate_limited: 'retry',
  cursor_storage_unavailable: 'retry',
  cursor_network: 'retry',
  cursor_invalid_response: 'repair_configuration',
  cursor_probe_failed: 'retry',
  cursor_in_future: 'repair_configuration',
  cursor_stale: 'retry',
  polling_disabled: 'repair_configuration',
  polling_stopped: 'restart_host',
} satisfies Readonly<Record<string, FeishuDiagnosticRecovery>>)

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu diagnostics response.')
}

function recordAt(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = [...required, ...optional]
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      return invalid()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    return invalid()
  }
}

function arrayAt(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    return invalid()
  }
  return Object.freeze(
    Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return invalid()
      return descriptor.value
    }),
  )
}

function nameAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    return invalid()
  }
  return value
}

function timestampAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return invalid()
  }
  return value
}

function scopeList(value: unknown): readonly string[] {
  const scopes = arrayAt(value, 512).map(nameAt)
  if (
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope, index) => index > 0 && scope <= scopes[index - 1]!)
  ) {
    return invalid()
  }
  return Object.freeze(scopes)
}

function runtimeAt(value: unknown): FeishuRuntimeDiagnostic {
  const base = recordAt(value, ['version', 'state'], ['reason', 'recovery'])
  if (base.version !== 1) return invalid()
  if (base.state === 'disabled') {
    const runtime = recordAt(value, ['version', 'state', 'reason'])
    if (runtime.reason !== 'not_configured' && runtime.reason !== 'host_configuration_missing')
      return invalid()
    return Object.freeze({ version: 1, state: 'disabled', reason: runtime.reason })
  }
  if (base.state === 'starting' || base.state === 'running' || base.state === 'stopped') {
    recordAt(value, ['version', 'state'])
    return Object.freeze({ version: 1, state: base.state })
  }
  if (base.state !== 'attention_required') return invalid()
  const runtime = recordAt(value, ['version', 'state', 'recovery'])
  if (
    !['reauthorize', 'grant_scope', 'repair_configuration', 'restart_host'].includes(
      runtime.recovery as string,
    )
  )
    return invalid()
  return Object.freeze({
    version: 1,
    state: 'attention_required',
    recovery: runtime.recovery as Exclude<FeishuDiagnosticRecovery, 'retry'>,
  })
}

/** Parse the exact identifier-free diagnostics response before rendering it. */
export function parseFeishuDiagnosticsSnapshot(value: unknown): FeishuDiagnosticsSnapshot {
  const snapshot = recordAt(value, [
    'version',
    'connectorId',
    'status',
    'checkedAt',
    'runtime',
    'identities',
    'rateLimits',
    'cursors',
    'issues',
  ])
  if (
    snapshot.version !== 1 ||
    snapshot.connectorId !== 'feishu' ||
    !['not_configured', 'healthy', 'degraded', 'unavailable'].includes(snapshot.status as string)
  ) {
    return invalid()
  }
  const checkedAt = snapshot.checkedAt === null ? null : timestampAt(snapshot.checkedAt)
  const runtime = runtimeAt(snapshot.runtime)
  const identities = arrayAt(snapshot.identities, 2).map((value) => {
    const identity = recordAt(value, ['identityType', 'status', 'requiredScopes', 'missingScopes'])
    if (
      (identity.identityType !== 'bot' && identity.identityType !== 'user') ||
      !['ready', 'attention_required', 'unavailable'].includes(identity.status as string)
    ) {
      return invalid()
    }
    const requiredScopes = scopeList(identity.requiredScopes)
    const missingScopes = scopeList(identity.missingScopes)
    const expectedScopes = REQUIRED_SCOPES[identity.identityType]
    if (
      requiredScopes.length !== expectedScopes.length ||
      requiredScopes.some((scope, index) => scope !== expectedScopes[index]) ||
      missingScopes.some((scope) => !requiredScopes.includes(scope)) ||
      (identity.status === 'ready' && missingScopes.length !== 0)
    )
      return invalid()
    return Object.freeze({
      identityType: identity.identityType,
      status: identity.status as 'ready' | 'attention_required' | 'unavailable',
      requiredScopes,
      missingScopes,
    })
  })
  if (new Set(identities.map((identity) => identity.identityType)).size !== identities.length)
    return invalid()
  if (
    identities.some(
      (identity, index) =>
        index > 0 && identity.identityType <= identities[index - 1]!.identityType,
    )
  )
    return invalid()
  const rateLimits = arrayAt(snapshot.rateLimits, 2).map((value) => {
    const rate = recordAt(value, ['identityType', 'status'], ['resetsAt'])
    if (
      (rate.identityType !== 'bot' && rate.identityType !== 'user') ||
      !['available', 'limited', 'unknown'].includes(rate.status as string) ||
      (rate.status === 'unknown' && Object.hasOwn(rate, 'resetsAt')) ||
      (rate.status !== 'unknown' && !Object.hasOwn(rate, 'resetsAt'))
    ) {
      return invalid()
    }
    return Object.freeze({
      identityType: rate.identityType,
      status: rate.status as 'available' | 'limited' | 'unknown',
      ...(rate.status === 'unknown' ? {} : { resetsAt: timestampAt(rate.resetsAt) }),
    })
  })
  const cursors = arrayAt(snapshot.cursors, 16).map((value) => {
    const cursor = recordAt(value, ['stream', 'status'], ['updatedAt', 'committedThrough'])
    if (
      !['current', 'stale', 'future', 'not_started', 'unavailable'].includes(
        cursor.status as string,
      )
    )
      return invalid()
    const stream = nameAt(cursor.stream)
    if (
      (cursor.status === 'not_started' || cursor.status === 'unavailable') &&
      (Object.hasOwn(cursor, 'updatedAt') || Object.hasOwn(cursor, 'committedThrough'))
    )
      return invalid()
    return Object.freeze({
      stream,
      status: cursor.status as 'current' | 'stale' | 'future' | 'not_started' | 'unavailable',
      ...(Object.hasOwn(cursor, 'updatedAt') ? { updatedAt: timestampAt(cursor.updatedAt) } : {}),
      ...(Object.hasOwn(cursor, 'committedThrough')
        ? { committedThrough: timestampAt(cursor.committedThrough) }
        : {}),
    })
  })
  if (
    snapshot.status !== 'not_configured' &&
    (cursors.length !== 1 ||
      cursors[0]?.stream !== 'user_visible_messages' ||
      new Set(cursors.map((cursor) => cursor.stream)).size !== cursors.length)
  )
    return invalid()
  const recoveries = [
    'reauthorize',
    'grant_scope',
    'retry',
    'repair_configuration',
    'restart_host',
  ] as const
  const issues = arrayAt(snapshot.issues, 64).map((value) => {
    const issue = recordAt(value, ['code', 'recovery'])
    const code = nameAt(issue.code)
    const expectedRecovery = ISSUE_RECOVERY[code as keyof typeof ISSUE_RECOVERY]
    if (
      !recoveries.includes(issue.recovery as (typeof recoveries)[number]) ||
      expectedRecovery === undefined ||
      (code === 'polling_stopped'
        ? issue.recovery === 'retry'
        : issue.recovery !== expectedRecovery)
    ) {
      return invalid()
    }
    return Object.freeze({
      code,
      recovery: issue.recovery as FeishuDiagnosticRecovery,
    })
  })
  if (
    (snapshot.status === 'not_configured') !== (checkedAt === null) ||
    (snapshot.status === 'not_configured' &&
      (identities.length !== 0 ||
        rateLimits.length !== 0 ||
        cursors.length !== 0 ||
        issues.length !== 0)) ||
    (snapshot.status === 'healthy' &&
      (issues.length !== 0 || identities.some((identity) => identity.status !== 'ready'))) ||
    (snapshot.status === 'degraded' && issues.length === 0) ||
    (snapshot.status === 'unavailable' &&
      identities.some((identity) => identity.status === 'ready')) ||
    rateLimits.length !== identities.length ||
    rateLimits.some((rate, index) => rate.identityType !== identities[index]?.identityType)
  ) {
    return invalid()
  }
  return Object.freeze({
    version: 1,
    connectorId: 'feishu',
    status: snapshot.status as FeishuDiagnosticsSnapshot['status'],
    checkedAt,
    runtime,
    identities: Object.freeze(identities),
    rateLimits: Object.freeze(rateLimits),
    cursors: Object.freeze(cursors),
    issues: Object.freeze(issues),
  })
}
