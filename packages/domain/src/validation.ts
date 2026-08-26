import {
  DOMAIN_SCHEMA_VERSION,
  type ActionProposal,
  type ApprovalRecord,
  type AuditRecord,
  type ConnectorCursor,
  type DomainRecord,
  type Draft,
  type ExternalEvent,
  type ExternalReference,
  type ExternalThread,
  type JsonValue,
  type WorkItem,
} from './model.ts'

/** Boundary error that reports a field path without echoing sensitive input. */
export class DomainValidationError extends TypeError {
  readonly path: string

  constructor(path: string, expectation: string) {
    super(`${path} ${expectation}`)
    this.name = 'DomainValidationError'
    this.path = path
  }
}

type UnknownRecord = Record<string, unknown>

function fail(path: string, expectation: string): never {
  throw new DomainValidationError(path, expectation)
}

function objectAt(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'must be an object')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, 'must be a plain object')
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail(`${path}.${key}`, 'must be a data field')
    }
  }
  return value as UnknownRecord
}

function exactKeys(
  value: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required')
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not supported by this schema version')
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail(path, 'must be a non-empty string')
  }
  return value
}

function optionalStringProperty(
  record: UnknownRecord,
  key: string,
  path: string,
): string | undefined {
  return Object.hasOwn(record, key) ? stringAt(record[key], path) : undefined
}

function literalAt<const Value extends string | number>(
  value: unknown,
  expected: Value,
  path: string,
): Value {
  if (value !== expected) return fail(path, `must equal ${JSON.stringify(expected)}`)
  return expected
}

function enumAt<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    return fail(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as Value
}

function timestampAt(value: unknown, path: string): string {
  const text = stringAt(value, path)
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(text)
  if (match === null) {
    return fail(path, 'must be a UTC ISO-8601 timestamp')
  }
  if (!Number.isFinite(Date.parse(text))) return fail(path, 'must be a valid timestamp')
  const base = text.replace(/(?:\.\d{1,3})?Z$/u, '')
  const canonicalInput = `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`
  if (new Date(text).toISOString() !== canonicalInput) {
    return fail(path, 'must be a valid timestamp')
  }
  return text
}

function digestAt(value: unknown, path: string): string {
  const text = stringAt(value, path)
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) {
    return fail(path, 'must be a lowercase sha256 digest')
  }
  return text
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail(path, 'must be a positive safe integer')
  }
  return value as number
}

function stringArrayAt(
  value: unknown,
  path: string,
  options: { readonly nonEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value)) return fail(path, 'must be an array')
  if (options.nonEmpty === true && value.length === 0) return fail(path, 'must not be empty')
  const result = value.map((entry, index) => stringAt(entry, `${path}[${index}]`))
  if (new Set(result).size !== result.length) return fail(path, 'must not contain duplicates')
  return result
}

function jsonAt(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 16) return fail(path, 'must not exceed 16 levels of nesting')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail(path, 'must contain only finite numbers')
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonAt(entry, `${path}[${index}]`, depth + 1))
  }
  const record = objectAt(value, path)
  for (const [key, entry] of Object.entries(record)) {
    jsonAt(entry, `${path}.${key}`, depth + 1)
  }
  return record as JsonValue
}

function externalReferenceAt(value: unknown, path: string): ExternalReference {
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    ['connectorId', 'accountId', 'objectType', 'externalId'],
    ['sourceTimestamp'],
  )
  stringAt(record.connectorId, `${path}.connectorId`)
  stringAt(record.accountId, `${path}.accountId`)
  stringAt(record.objectType, `${path}.objectType`)
  stringAt(record.externalId, `${path}.externalId`)
  if (Object.hasOwn(record, 'sourceTimestamp')) {
    timestampAt(record.sourceTimestamp, `${path}.sourceTimestamp`)
  }
  return record as unknown as ExternalReference
}

function referenceArrayAt(value: unknown, path: string): readonly ExternalReference[] {
  if (!Array.isArray(value) || value.length === 0) return fail(path, 'must be a non-empty array')
  const references = value.map((entry, index) => externalReferenceAt(entry, `${path}[${index}]`))
  const identities = references.map(
    ({ connectorId, accountId, objectType, externalId }) =>
      `${connectorId}\u0000${accountId}\u0000${objectType}\u0000${externalId}`,
  )
  if (new Set(identities).size !== identities.length)
    return fail(path, 'must not contain duplicates')
  return references
}

function commonRecordAt(record: UnknownRecord, kind: DomainRecord['kind'], path: string): void {
  literalAt(record.kind, kind, `${path}.kind`)
  literalAt(record.schemaVersion, DOMAIN_SCHEMA_VERSION, `${path}.schemaVersion`)
  stringAt(record.id, `${path}.id`)
}

function draftContentAt(value: unknown, path: string): void {
  const record = objectAt(value, path)
  exactKeys(record, path, ['mediaType', 'text'])
  enumAt(record.mediaType, ['text/plain', 'text/markdown'], `${path}.mediaType`)
  stringAt(record.text, `${path}.text`)
}

function chronology(start: string, end: string, endPath: string): void {
  if (Date.parse(end) < Date.parse(start)) fail(endPath, 'must not be earlier than its start')
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function parseExternalEvent(value: unknown): ExternalEvent {
  const path = 'external_event'
  const record = objectAt(value, path)
  exactKeys(record, path, [
    'kind',
    'schemaVersion',
    'id',
    'idempotencyKey',
    'source',
    'eventType',
    'occurredAt',
    'receivedAt',
    'context',
    'normalized',
  ])
  commonRecordAt(record, 'external_event', path)
  stringAt(record.idempotencyKey, `${path}.idempotencyKey`)
  externalReferenceAt(record.source, `${path}.source`)
  stringAt(record.eventType, `${path}.eventType`)
  const occurredAt = timestampAt(record.occurredAt, `${path}.occurredAt`)
  const receivedAt = timestampAt(record.receivedAt, `${path}.receivedAt`)
  chronology(occurredAt, receivedAt, `${path}.receivedAt`)
  const context = objectAt(record.context, `${path}.context`)
  if (context.status === 'complete') {
    exactKeys(context, `${path}.context`, ['status'])
  } else if (context.status === 'partial') {
    exactKeys(context, `${path}.context`, ['status', 'missing'])
    stringArrayAt(context.missing, `${path}.context.missing`, { nonEmpty: true })
  } else {
    fail(`${path}.context.status`, 'must be complete or partial')
  }
  const normalized = objectAt(record.normalized, `${path}.normalized`)
  jsonAt(normalized, `${path}.normalized`)
  return deepFreeze(record as unknown as ExternalEvent)
}

export function parseExternalThread(value: unknown): ExternalThread {
  const path = 'external_thread'
  const record = objectAt(value, path)
  exactKeys(record, path, [
    'kind',
    'schemaVersion',
    'id',
    'subject',
    'externalReferences',
    'sourceEventIds',
    'createdAt',
    'updatedAt',
  ])
  commonRecordAt(record, 'external_thread', path)
  stringAt(record.subject, `${path}.subject`)
  referenceArrayAt(record.externalReferences, `${path}.externalReferences`)
  stringArrayAt(record.sourceEventIds, `${path}.sourceEventIds`, { nonEmpty: true })
  const createdAt = timestampAt(record.createdAt, `${path}.createdAt`)
  const updatedAt = timestampAt(record.updatedAt, `${path}.updatedAt`)
  chronology(createdAt, updatedAt, `${path}.updatedAt`)
  return deepFreeze(record as unknown as ExternalThread)
}

export function parseWorkItem(value: unknown): WorkItem {
  const path = 'work_item'
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    [
      'kind',
      'schemaVersion',
      'id',
      'threadId',
      'sourceEventIds',
      'inboxState',
      'title',
      'summary',
      'attentionReason',
      'createdAt',
      'updatedAt',
    ],
    ['selectedPersonaId'],
  )
  commonRecordAt(record, 'work_item', path)
  stringAt(record.threadId, `${path}.threadId`)
  stringArrayAt(record.sourceEventIds, `${path}.sourceEventIds`, { nonEmpty: true })
  enumAt(
    record.inboxState,
    ['needs_reply', 'needs_review', 'waiting', 'done'],
    `${path}.inboxState`,
  )
  stringAt(record.title, `${path}.title`)
  stringAt(record.summary, `${path}.summary`)
  stringAt(record.attentionReason, `${path}.attentionReason`)
  optionalStringProperty(record, 'selectedPersonaId', `${path}.selectedPersonaId`)
  const createdAt = timestampAt(record.createdAt, `${path}.createdAt`)
  const updatedAt = timestampAt(record.updatedAt, `${path}.updatedAt`)
  chronology(createdAt, updatedAt, `${path}.updatedAt`)
  return deepFreeze(record as unknown as WorkItem)
}

export function parseDraft(value: unknown): Draft {
  const path = 'draft'
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    [
      'kind',
      'schemaVersion',
      'id',
      'workItemId',
      'personaId',
      'revision',
      'state',
      'content',
      'createdAt',
      'updatedAt',
    ],
    ['sessionId', 'runId', 'rationale'],
  )
  commonRecordAt(record, 'draft', path)
  stringAt(record.workItemId, `${path}.workItemId`)
  stringAt(record.personaId, `${path}.personaId`)
  optionalStringProperty(record, 'sessionId', `${path}.sessionId`)
  optionalStringProperty(record, 'runId', `${path}.runId`)
  positiveIntegerAt(record.revision, `${path}.revision`)
  enumAt(record.state, ['editing', 'ready_for_review', 'superseded', 'cancelled'], `${path}.state`)
  draftContentAt(record.content, `${path}.content`)
  optionalStringProperty(record, 'rationale', `${path}.rationale`)
  const createdAt = timestampAt(record.createdAt, `${path}.createdAt`)
  const updatedAt = timestampAt(record.updatedAt, `${path}.updatedAt`)
  chronology(createdAt, updatedAt, `${path}.updatedAt`)
  return deepFreeze(record as unknown as Draft)
}

export function parseActionProposal(value: unknown): ActionProposal {
  const path = 'action_proposal'
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    [
      'kind',
      'schemaVersion',
      'id',
      'workItemId',
      'actionType',
      'risk',
      'identity',
      'target',
      'content',
      'contentDigest',
      'idempotencyKey',
      'state',
      'createdAt',
      'updatedAt',
    ],
    ['draftId'],
  )
  commonRecordAt(record, 'action_proposal', path)
  stringAt(record.workItemId, `${path}.workItemId`)
  optionalStringProperty(record, 'draftId', `${path}.draftId`)
  stringAt(record.actionType, `${path}.actionType`)
  enumAt(record.risk, ['write', 'destructive'], `${path}.risk`)
  const identity = objectAt(record.identity, `${path}.identity`)
  exactKeys(identity, `${path}.identity`, [
    'connectorId',
    'accountId',
    'identityType',
    'displayName',
  ])
  stringAt(identity.connectorId, `${path}.identity.connectorId`)
  stringAt(identity.accountId, `${path}.identity.accountId`)
  enumAt(identity.identityType, ['bot', 'user'], `${path}.identity.identityType`)
  stringAt(identity.displayName, `${path}.identity.displayName`)
  const target = externalReferenceAt(record.target, `${path}.target`)
  if (identity.connectorId !== target.connectorId || identity.accountId !== target.accountId) {
    fail(`${path}.identity`, 'must match the target connector and account')
  }
  draftContentAt(record.content, `${path}.content`)
  digestAt(record.contentDigest, `${path}.contentDigest`)
  stringAt(record.idempotencyKey, `${path}.idempotencyKey`)
  enumAt(
    record.state,
    [
      'proposed',
      'awaiting_approval',
      'approved',
      'rejected',
      'cancelled',
      'executing',
      'succeeded',
      'failed',
      'uncertain',
    ],
    `${path}.state`,
  )
  const createdAt = timestampAt(record.createdAt, `${path}.createdAt`)
  const updatedAt = timestampAt(record.updatedAt, `${path}.updatedAt`)
  chronology(createdAt, updatedAt, `${path}.updatedAt`)
  return deepFreeze(record as unknown as ActionProposal)
}

export function parseApprovalRecord(value: unknown): ApprovalRecord {
  const path = 'approval_record'
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    [
      'kind',
      'schemaVersion',
      'id',
      'proposalId',
      'decision',
      'identityDigest',
      'targetDigest',
      'contentDigest',
      'requestedAt',
      'expiresAt',
    ],
    ['decidedAt', 'responderUserId', 'consumedAt'],
  )
  commonRecordAt(record, 'approval_record', path)
  stringAt(record.proposalId, `${path}.proposalId`)
  const decision = enumAt(
    record.decision,
    ['pending', 'approved', 'rejected', 'cancelled', 'expired'],
    `${path}.decision`,
  )
  digestAt(record.identityDigest, `${path}.identityDigest`)
  digestAt(record.targetDigest, `${path}.targetDigest`)
  digestAt(record.contentDigest, `${path}.contentDigest`)
  const requestedAt = timestampAt(record.requestedAt, `${path}.requestedAt`)
  const expiresAt = timestampAt(record.expiresAt, `${path}.expiresAt`)
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    fail(`${path}.expiresAt`, 'must be later than requestedAt')
  }
  const decidedAt = Object.hasOwn(record, 'decidedAt')
    ? timestampAt(record.decidedAt, `${path}.decidedAt`)
    : undefined
  const responderUserId = optionalStringProperty(
    record,
    'responderUserId',
    `${path}.responderUserId`,
  )
  const consumedAt = Object.hasOwn(record, 'consumedAt')
    ? timestampAt(record.consumedAt, `${path}.consumedAt`)
    : undefined

  if (decision === 'pending' && (decidedAt !== undefined || responderUserId !== undefined)) {
    fail(`${path}.decision`, 'pending approval must not contain a decision response')
  }
  if ((decision === 'approved' || decision === 'rejected') && responderUserId === undefined) {
    fail(`${path}.responderUserId`, `is required when decision is ${decision}`)
  }
  if (decision !== 'pending' && decidedAt === undefined) {
    fail(`${path}.decidedAt`, 'is required after a decision')
  }
  if (consumedAt !== undefined && decision !== 'approved') {
    fail(`${path}.consumedAt`, 'is allowed only for an approved action')
  }
  if (decidedAt !== undefined) chronology(requestedAt, decidedAt, `${path}.decidedAt`)
  if (
    decision === 'approved' &&
    decidedAt !== undefined &&
    Date.parse(decidedAt) > Date.parse(expiresAt)
  ) {
    fail(`${path}.decidedAt`, 'must not be later than expiresAt for approval')
  }
  if (consumedAt !== undefined && decidedAt !== undefined) {
    chronology(decidedAt, consumedAt, `${path}.consumedAt`)
  }
  if (consumedAt !== undefined && Date.parse(consumedAt) > Date.parse(expiresAt)) {
    fail(`${path}.consumedAt`, 'must not be later than expiresAt')
  }
  return deepFreeze(record as unknown as ApprovalRecord)
}

export function parseConnectorCursor(value: unknown): ConnectorCursor {
  const path = 'connector_cursor'
  const record = objectAt(value, path)
  exactKeys(
    record,
    path,
    ['kind', 'schemaVersion', 'id', 'connectorId', 'accountId', 'stream', 'position', 'updatedAt'],
    ['committedThrough'],
  )
  commonRecordAt(record, 'connector_cursor', path)
  stringAt(record.connectorId, `${path}.connectorId`)
  stringAt(record.accountId, `${path}.accountId`)
  stringAt(record.stream, `${path}.stream`)
  stringAt(record.position, `${path}.position`)
  if (Object.hasOwn(record, 'committedThrough')) {
    timestampAt(record.committedThrough, `${path}.committedThrough`)
  }
  timestampAt(record.updatedAt, `${path}.updatedAt`)
  return deepFreeze(record as unknown as ConnectorCursor)
}

export function parseAuditRecord(value: unknown): AuditRecord {
  const path = 'audit_record'
  const record = objectAt(value, path)
  exactKeys(record, path, [
    'kind',
    'schemaVersion',
    'id',
    'category',
    'outcome',
    'actor',
    'summary',
    'references',
    'details',
    'occurredAt',
  ])
  commonRecordAt(record, 'audit_record', path)
  enumAt(
    record.category,
    ['ingestion', 'routing', 'run', 'draft', 'approval', 'execution', 'system'],
    `${path}.category`,
  )
  enumAt(
    record.outcome,
    ['pending', 'success', 'failure', 'cancelled', 'uncertain'],
    `${path}.outcome`,
  )
  const actor = objectAt(record.actor, `${path}.actor`)
  exactKeys(actor, `${path}.actor`, ['type'], ['id'])
  const actorType = enumAt(
    actor.type,
    ['user', 'system', 'persona', 'connector'],
    `${path}.actor.type`,
  )
  const actorId = optionalStringProperty(actor, 'id', `${path}.actor.id`)
  if (actorType !== 'system' && actorId === undefined) {
    fail(`${path}.actor.id`, `is required when actor type is ${actorType}`)
  }
  stringAt(record.summary, `${path}.summary`)
  if (!Array.isArray(record.references)) fail(`${path}.references`, 'must be an array')
  const references = record.references.map((entry, index) => {
    const reference = objectAt(entry, `${path}.references[${index}]`)
    exactKeys(reference, `${path}.references[${index}]`, ['kind', 'id'])
    const kind = stringAt(reference.kind, `${path}.references[${index}].kind`)
    const id = stringAt(reference.id, `${path}.references[${index}].id`)
    return `${kind}\u0000${id}`
  })
  if (new Set(references).size !== references.length) {
    fail(`${path}.references`, 'must not contain duplicates')
  }
  const details = objectAt(record.details, `${path}.details`)
  jsonAt(details, `${path}.details`)
  timestampAt(record.occurredAt, `${path}.occurredAt`)
  return deepFreeze(record as unknown as AuditRecord)
}

/** Parse one unknown persisted or API value using its explicit record kind. */
export function parseDomainRecord(value: unknown): DomainRecord {
  const record = objectAt(value, 'record')
  switch (record.kind) {
    case 'external_event':
      return parseExternalEvent(value)
    case 'external_thread':
      return parseExternalThread(value)
    case 'work_item':
      return parseWorkItem(value)
    case 'draft':
      return parseDraft(value)
    case 'action_proposal':
      return parseActionProposal(value)
    case 'approval_record':
      return parseApprovalRecord(value)
    case 'connector_cursor':
      return parseConnectorCursor(value)
    case 'audit_record':
      return parseAuditRecord(value)
    default:
      return fail('record.kind', 'is not a supported TwinDesk record kind')
  }
}
