export type AuditCategory =
  'ingestion' | 'routing' | 'run' | 'draft' | 'approval' | 'execution' | 'system'
export type AuditOutcome = 'pending' | 'success' | 'failure' | 'cancelled' | 'uncertain'
export type AuditActorType = 'user' | 'system' | 'persona' | 'connector'
export type AuditReferenceKind =
  | 'external_event'
  | 'external_thread'
  | 'work_item'
  | 'session'
  | 'run'
  | 'tool_call'
  | 'draft'
  | 'action_proposal'
  | 'approval_record'
  | 'action_receipt'
  | 'connector_cursor'

export interface AuditItem {
  readonly category: AuditCategory
  readonly outcome: AuditOutcome
  readonly actorType: AuditActorType
  readonly actorLabel: string
  readonly summary: string
  readonly referenceKinds: readonly AuditReferenceKind[]
  readonly occurredAt: string
}

export interface AuditSnapshot {
  readonly version: 1
  readonly fixture: true
  readonly items: readonly AuditItem[]
}

type UnknownRecord = Readonly<Record<string, unknown>>

const CATEGORIES = Object.freeze([
  'ingestion',
  'routing',
  'run',
  'draft',
  'approval',
  'execution',
  'system',
] as const)
const OUTCOMES = Object.freeze(['pending', 'success', 'failure', 'cancelled', 'uncertain'] as const)
const ACTOR_TYPES = Object.freeze(['user', 'system', 'persona', 'connector'] as const)
const REFERENCE_KINDS = Object.freeze([
  'external_event',
  'external_thread',
  'work_item',
  'session',
  'run',
  'tool_call',
  'draft',
  'action_proposal',
  'approval_record',
  'action_receipt',
  'connector_cursor',
] as const)

function invalidAuditResponse(): never {
  throw new Error('Local API returned an invalid Audit response.')
}

function recordAt(value: unknown, keys: readonly string[]): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidAuditResponse()
  }
  const record = value as UnknownRecord
  const actualKeys = Object.keys(record)
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    return invalidAuditResponse()
  }
  return record
}

function stringAt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalidAuditResponse()
  return value
}

function timestampAt(value: unknown): string {
  const timestamp = stringAt(value)
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(timestamp)
  if (match === null || !Number.isFinite(Date.parse(timestamp))) return invalidAuditResponse()
  const base = timestamp.replace(/(?:\.\d{1,3})?Z$/u, '')
  const canonical = `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`
  if (new Date(timestamp).toISOString() !== canonical) return invalidAuditResponse()
  return timestamp
}

function enumAt<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) return invalidAuditResponse()
  return value as Value
}

function parseAuditItem(value: unknown): AuditItem {
  const item = recordAt(value, [
    'category',
    'outcome',
    'actorType',
    'actorLabel',
    'summary',
    'referenceKinds',
    'occurredAt',
  ])
  if (!Array.isArray(item.referenceKinds) || item.referenceKinds.length === 0) {
    return invalidAuditResponse()
  }
  return {
    category: enumAt(item.category, CATEGORIES),
    outcome: enumAt(item.outcome, OUTCOMES),
    actorType: enumAt(item.actorType, ACTOR_TYPES),
    actorLabel: stringAt(item.actorLabel),
    summary: stringAt(item.summary),
    referenceKinds: item.referenceKinds.map((kind) => enumAt(kind, REFERENCE_KINDS)),
    occurredAt: timestampAt(item.occurredAt),
  }
}

/** Parse the versioned, presentation-safe loopback Audit response. */
export function parseAuditSnapshot(value: unknown): AuditSnapshot {
  const snapshot = recordAt(value, ['version', 'fixture', 'items'])
  if (snapshot.version !== 1 || snapshot.fixture !== true || !Array.isArray(snapshot.items)) {
    throw new Error('Local API returned an unsupported Audit response.')
  }
  return {
    version: 1,
    fixture: true,
    items: snapshot.items.map(parseAuditItem),
  }
}
