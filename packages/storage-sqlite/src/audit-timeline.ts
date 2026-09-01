import type { DatabaseSync } from 'node:sqlite'

import {
  parseAuditRecord,
  parseIsoTimestamp,
  type AuditCategory,
  type AuditOutcome,
  type AuditRecord,
  type AuditRecordId,
  type AuditReference,
  type AuditReferenceKind,
  type IsoTimestamp,
  type JsonValue,
  type WorkItemId,
} from '@twindesk/domain'

export type AuditTimelineErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'record_conflict'
  | 'missing_reference'
  | 'reference_mismatch'
  | 'reference_chronology'
  | 'stored_record_invalid'
  | 'storage_error'

export class AuditTimelineError extends Error {
  readonly code: AuditTimelineErrorCode
  readonly inputIndex: number | undefined

  constructor(
    code: AuditTimelineErrorCode,
    message: string,
    options: { readonly inputIndex?: number } = {},
  ) {
    super(message)
    this.name = 'AuditTimelineError'
    this.code = code
    this.inputIndex = options.inputIndex
  }
}

export interface AuditAppendItem {
  readonly inputIndex: number
  readonly disposition: 'inserted' | 'duplicate'
}

export interface AuditAppendResult {
  readonly insertedCount: number
  readonly duplicateCount: number
  readonly items: readonly AuditAppendItem[]
}

export interface AuditTimelineCursor {
  readonly occurredAt: IsoTimestamp
  readonly id: AuditRecordId
}

export interface AuditTimelineQuery {
  readonly workItemId?: WorkItemId
  readonly reference?: AuditReference
  readonly categories?: readonly AuditCategory[]
  readonly outcomes?: readonly AuditOutcome[]
  readonly limit?: number
  readonly after?: AuditTimelineCursor
}

export interface AuditTimelinePage {
  readonly records: readonly AuditRecord[]
  readonly nextCursor?: AuditTimelineCursor
}

interface AuditRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly category: unknown
  readonly outcome: unknown
  readonly actor_type: unknown
  readonly actor_id: unknown
  readonly summary: unknown
  readonly details_json: unknown
  readonly occurred_at: unknown
}

interface AuditReferenceRow {
  readonly reference_kind: unknown
  readonly reference_id: unknown
}

interface ResolvedReference {
  readonly exists: boolean
  readonly workItemIds: readonly string[]
  readonly earliestAt?: string
}

const AUDIT_COLUMNS = `kind, schema_version, id, category, outcome, actor_type,
  actor_id, summary, details_json, occurred_at`
const AUDIT_CATEGORIES = Object.freeze([
  'ingestion',
  'routing',
  'run',
  'draft',
  'approval',
  'execution',
  'system',
] as const)
const AUDIT_OUTCOMES = Object.freeze([
  'pending',
  'success',
  'failure',
  'cancelled',
  'uncertain',
] as const)
const AUDIT_REFERENCE_KINDS = Object.freeze([
  'connector',
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

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed operation error.
  }
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuditTimelineError('invalid_request', 'The audit request must be an object.')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AuditTimelineError('invalid_request', 'The audit request must be a data object.')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuditTimelineError('invalid_request', 'The audit request has unsupported fields.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    throw new AuditTimelineError('invalid_request', 'The audit request must not use accessors.')
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const keys = Object.keys(descriptors)
  if (
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new AuditTimelineError(
      'invalid_request',
      'The audit request has missing or unsupported fields.',
    )
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuditTimelineError('invalid_request', 'An audit identifier is invalid.')
  }
  return value
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(',')}}`
}

function parseStoredAuditRecord(
  row: AuditRow,
  referenceRows: readonly AuditReferenceRow[],
): AuditRecord {
  try {
    if (typeof row.details_json !== 'string') throw new TypeError('invalid details')
    const references = referenceRows.map((reference) => ({
      kind: reference.reference_kind,
      id: reference.reference_id,
    }))
    return parseAuditRecord({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      category: row.category,
      outcome: row.outcome,
      actor: {
        type: row.actor_type,
        ...(row.actor_id === null ? {} : { id: row.actor_id }),
      },
      summary: row.summary,
      references,
      details: JSON.parse(row.details_json) as unknown,
      occurredAt: row.occurred_at,
    })
  } catch {
    throw new AuditTimelineError('stored_record_invalid', 'A stored audit record is invalid.')
  }
}

export function readAuditInSnapshot(database: DatabaseSync, id: string): AuditRecord | undefined {
  const row = database
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_records WHERE id = ?`)
    .get(id) as AuditRow | undefined
  if (row === undefined) return undefined
  const references = database
    .prepare(
      `SELECT reference_kind, reference_id
       FROM audit_references WHERE audit_record_id = ? ORDER BY ordinal`,
    )
    .all(id) as unknown as AuditReferenceRow[]
  return parseStoredAuditRecord(row, references)
}

function sameAuditRecord(left: AuditRecord, right: AuditRecord): boolean {
  return (
    left.id === right.id &&
    left.category === right.category &&
    left.outcome === right.outcome &&
    left.actor.type === right.actor.type &&
    left.actor.id === right.actor.id &&
    left.summary === right.summary &&
    left.occurredAt === right.occurredAt &&
    canonicalJson(left.details) === canonicalJson(right.details) &&
    left.references.length === right.references.length &&
    left.references.every(
      (reference, index) =>
        reference.kind === right.references[index]?.kind &&
        reference.id === right.references[index]?.id,
    )
  )
}

function relatedRows(
  database: DatabaseSync,
  sql: string,
  id: string,
): readonly { readonly work_item_id: unknown; readonly earliest_at: unknown }[] {
  return database.prepare(sql).all(id) as unknown as readonly {
    readonly work_item_id: unknown
    readonly earliest_at: unknown
  }[]
}

function resolutionFromRows(
  rows: readonly { readonly work_item_id: unknown; readonly earliest_at: unknown }[],
): ResolvedReference {
  if (rows.length === 0) return Object.freeze({ exists: false, workItemIds: Object.freeze([]) })
  const workItemIds: string[] = []
  let earliestAt: string | undefined
  for (const row of rows) {
    if (row.work_item_id !== null && typeof row.work_item_id !== 'string') {
      throw new AuditTimelineError('stored_record_invalid', 'An audit reference is invalid.')
    }
    if (row.earliest_at !== null && typeof row.earliest_at !== 'string') {
      throw new AuditTimelineError('stored_record_invalid', 'An audit reference is invalid.')
    }
    if (typeof row.work_item_id === 'string') workItemIds.push(row.work_item_id)
    if (
      typeof row.earliest_at === 'string' &&
      (earliestAt === undefined || Date.parse(row.earliest_at) < Date.parse(earliestAt))
    ) {
      earliestAt = row.earliest_at
    }
  }
  return Object.freeze({
    exists: true,
    workItemIds: Object.freeze([...new Set(workItemIds)]),
    ...(earliestAt === undefined ? {} : { earliestAt }),
  })
}

function resolveLocalReference(
  database: DatabaseSync,
  reference: AuditReference,
): ResolvedReference | undefined {
  switch (reference.kind) {
    case 'connector':
      return undefined
    case 'external_event':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT wi.work_item_id, event.received_at AS earliest_at
           FROM external_events event
           LEFT JOIN work_item_events wi ON wi.event_id = event.id
           WHERE event.id = ?`,
          reference.id,
        ),
      )
    case 'external_thread':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT item.id AS work_item_id, thread.created_at AS earliest_at
           FROM external_threads thread
           LEFT JOIN work_items item ON item.thread_id = thread.id
           WHERE thread.id = ?`,
          reference.id,
        ),
      )
    case 'work_item':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT id AS work_item_id, created_at AS earliest_at FROM work_items WHERE id = ?`,
          reference.id,
        ),
      )
    case 'draft':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT work_item_id, created_at AS earliest_at FROM drafts WHERE id = ?`,
          reference.id,
        ),
      )
    case 'action_proposal':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT work_item_id, created_at AS earliest_at FROM action_proposals WHERE id = ?`,
          reference.id,
        ),
      )
    case 'approval_record':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT proposal.work_item_id, approval.requested_at AS earliest_at
           FROM approval_records approval
           JOIN action_proposals proposal ON proposal.id = approval.proposal_id
           WHERE approval.id = ?`,
          reference.id,
        ),
      )
    case 'action_receipt':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT proposal.work_item_id, receipt.attempted_at AS earliest_at
           FROM action_receipts receipt
           JOIN action_proposals proposal ON proposal.id = receipt.proposal_id
           WHERE receipt.execution_attempt_id = ?`,
          reference.id,
        ),
      )
    case 'connector_cursor':
      return resolutionFromRows(
        relatedRows(
          database,
          `SELECT NULL AS work_item_id, updated_at AS earliest_at
           FROM connector_cursors WHERE id = ?`,
          reference.id,
        ),
      )
    case 'session':
    case 'run':
    case 'tool_call':
      return undefined
  }
}

function validateReferences(database: DatabaseSync, record: AuditRecord): void {
  const workItemIds = new Set(
    record.references
      .filter((reference) => reference.kind === 'work_item')
      .map((reference) => reference.id),
  )
  let owningThreadId: string | undefined
  const findOwningThread = database.prepare(`SELECT thread_id FROM work_items WHERE id = ?`)
  for (const workItemId of workItemIds) {
    const row = findOwningThread.get(workItemId) as { readonly thread_id: unknown } | undefined
    if (row === undefined) continue
    if (typeof row.thread_id !== 'string') {
      throw new AuditTimelineError('stored_record_invalid', 'A Work Item owner is invalid.')
    }
    if (owningThreadId !== undefined && row.thread_id !== owningThreadId) {
      throw new AuditTimelineError(
        'reference_mismatch',
        'One Audit record cannot span multiple Threads.',
      )
    }
    owningThreadId = row.thread_id
  }
  const kinds = new Set(record.references.map((reference) => reference.kind))
  if (
    (kinds.has('session') || kinds.has('run') || kinds.has('tool_call')) &&
    workItemIds.size === 0
  ) {
    throw new AuditTimelineError(
      'reference_mismatch',
      'Harness audit references require a Work Item link.',
    )
  }
  if (
    (kinds.has('draft') ||
      kinds.has('action_proposal') ||
      kinds.has('approval_record') ||
      kinds.has('action_receipt')) &&
    workItemIds.size === 0
  ) {
    throw new AuditTimelineError(
      'reference_mismatch',
      'A Work Item-owned audit reference requires its Work Item link.',
    )
  }
  if (kinds.has('run') && !kinds.has('session')) {
    throw new AuditTimelineError('reference_mismatch', 'A Run audit reference requires a Session.')
  }
  if (kinds.has('tool_call') && !kinds.has('run')) {
    throw new AuditTimelineError('reference_mismatch', 'A Tool call reference requires a Run.')
  }

  for (const reference of record.references) {
    const resolved = resolveLocalReference(database, reference)
    if (resolved === undefined) continue
    if (!resolved.exists) {
      throw new AuditTimelineError('missing_reference', 'A local audit reference is missing.')
    }
    if (
      workItemIds.size > 0 &&
      reference.kind !== 'connector_cursor' &&
      resolved.workItemIds.length === 0
    ) {
      throw new AuditTimelineError(
        'reference_mismatch',
        'A local audit reference is not linked to the referenced Work Item.',
      )
    }
    if (
      workItemIds.size > 0 &&
      resolved.workItemIds.length > 0 &&
      !resolved.workItemIds.some((id) => workItemIds.has(id))
    ) {
      throw new AuditTimelineError(
        'reference_mismatch',
        'A local audit reference belongs to another Work Item.',
      )
    }
    if (
      resolved.earliestAt !== undefined &&
      Date.parse(record.occurredAt) < Date.parse(resolved.earliestAt)
    ) {
      throw new AuditTimelineError(
        'reference_chronology',
        'The audit record precedes a referenced local record.',
      )
    }
  }
}

function writeAuditRecord(database: DatabaseSync, record: AuditRecord): void {
  const inserted = database
    .prepare(
      `INSERT INTO audit_records (
         kind, schema_version, id, category, outcome, actor_type, actor_id,
         summary, details_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.kind,
      record.schemaVersion,
      record.id,
      record.category,
      record.outcome,
      record.actor.type,
      record.actor.id ?? null,
      record.summary,
      canonicalJson(record.details),
      record.occurredAt,
    )
  if (inserted.changes !== 1) {
    throw new AuditTimelineError('storage_error', 'The audit record was not stored.')
  }
  const insertReference = database.prepare(
    `INSERT INTO audit_references (
       audit_record_id, ordinal, reference_kind, reference_id
     ) VALUES (?, ?, ?, ?)`,
  )
  record.references.forEach((reference, ordinal) => {
    const result = insertReference.run(record.id, ordinal, reference.kind, reference.id)
    if (result.changes !== 1) {
      throw new AuditTimelineError('storage_error', 'An audit reference was not stored.')
    }
  })
}

export function appendAuditRecords(
  database: DatabaseSync,
  inputs: readonly AuditRecord[],
): AuditAppendResult {
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new AuditTimelineError('storage_error', 'The audit transaction could not start.')
  }
  try {
    const result = appendAuditRecordsInTransaction(database, inputs)
    database.exec('COMMIT')
    return result
  } catch (error) {
    rollback(database)
    if (error instanceof AuditTimelineError) throw error
    throw new AuditTimelineError('storage_error', 'The audit batch could not be stored.')
  }
}

/** Internal composition primitive for a caller-owned SQLite transaction. */
export function appendAuditRecordsInTransaction(
  database: DatabaseSync,
  inputs: readonly AuditRecord[],
): AuditAppendResult {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new AuditTimelineError('invalid_request', 'The audit batch must be a non-empty array.')
  }
  const records = inputs.map((input, inputIndex) => {
    try {
      return parseAuditRecord(input)
    } catch {
      throw new AuditTimelineError('invalid_request', 'An audit record is invalid.', { inputIndex })
    }
  })
  const items: AuditAppendItem[] = []
  let insertedCount = 0
  let duplicateCount = 0
  for (const [inputIndex, record] of records.entries()) {
    const existing = readAuditInSnapshot(database, record.id)
    if (existing !== undefined) {
      if (!sameAuditRecord(existing, record)) {
        throw new AuditTimelineError('record_conflict', 'The audit identity conflicts.', {
          inputIndex,
        })
      }
      duplicateCount += 1
      items.push(Object.freeze({ inputIndex, disposition: 'duplicate' }))
      continue
    }
    try {
      validateReferences(database, record)
    } catch (error) {
      if (error instanceof AuditTimelineError) {
        throw new AuditTimelineError(error.code, error.message, { inputIndex })
      }
      throw error
    }
    writeAuditRecord(database, record)
    insertedCount += 1
    items.push(Object.freeze({ inputIndex, disposition: 'inserted' }))
  }
  return Object.freeze({
    insertedCount,
    duplicateCount,
    items: Object.freeze(items),
  })
}

export function readAuditRecord(
  database: DatabaseSync,
  id: AuditRecordId,
): AuditRecord | undefined {
  const auditId = nonEmptyString(id)
  try {
    database.exec('BEGIN')
  } catch {
    throw new AuditTimelineError('storage_error', 'The audit read could not start.')
  }
  try {
    const record = readAuditInSnapshot(database, auditId)
    database.exec('COMMIT')
    return record
  } catch (error) {
    rollback(database)
    if (error instanceof AuditTimelineError) throw error
    throw new AuditTimelineError('storage_error', 'The audit record could not be read.')
  }
}

function parseEnumFilter<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): readonly Value[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuditTimelineError('invalid_request', `${label} must be a non-empty array.`)
  }
  const parsed = value.map((entry) => {
    if (typeof entry !== 'string' || !allowed.includes(entry as Value)) {
      throw new AuditTimelineError('invalid_request', `${label} contains an unsupported value.`)
    }
    return entry as Value
  })
  if (new Set(parsed).size !== parsed.length) {
    throw new AuditTimelineError('invalid_request', `${label} must not contain duplicates.`)
  }
  return Object.freeze(parsed)
}

function parseReference(value: unknown): AuditReference {
  const record = dataRecord(value, ['kind', 'id'])
  if (
    typeof record.kind !== 'string' ||
    !AUDIT_REFERENCE_KINDS.includes(record.kind as AuditReferenceKind)
  ) {
    throw new AuditTimelineError('invalid_request', 'The audit reference kind is unsupported.')
  }
  return Object.freeze({
    kind: record.kind as AuditReferenceKind,
    id: nonEmptyString(record.id),
  })
}

function parseTimelineQuery(input: AuditTimelineQuery): {
  readonly workItemId?: WorkItemId
  readonly reference?: AuditReference
  readonly categories: readonly AuditCategory[]
  readonly outcomes: readonly AuditOutcome[]
  readonly limit: number
  readonly after?: AuditTimelineCursor
} {
  const record = dataRecord(
    input,
    [],
    ['workItemId', 'reference', 'categories', 'outcomes', 'limit', 'after'],
  )
  const categories = Object.hasOwn(record, 'categories')
    ? parseEnumFilter(record.categories, AUDIT_CATEGORIES, 'Audit categories')
    : AUDIT_CATEGORIES
  const outcomes = Object.hasOwn(record, 'outcomes')
    ? parseEnumFilter(record.outcomes, AUDIT_OUTCOMES, 'Audit outcomes')
    : AUDIT_OUTCOMES
  const limit = Object.hasOwn(record, 'limit') ? record.limit : 50
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new AuditTimelineError('invalid_request', 'The audit limit must be between 1 and 100.')
  }
  const workItemId = Object.hasOwn(record, 'workItemId')
    ? (nonEmptyString(record.workItemId) as WorkItemId)
    : undefined
  const reference = Object.hasOwn(record, 'reference')
    ? parseReference(record.reference)
    : undefined
  let after: AuditTimelineCursor | undefined
  if (Object.hasOwn(record, 'after')) {
    const cursor = dataRecord(record.after, ['occurredAt', 'id'])
    after = Object.freeze({
      occurredAt: parseIsoTimestamp(cursor.occurredAt),
      id: nonEmptyString(cursor.id) as AuditRecordId,
    })
  }
  return Object.freeze({
    ...(workItemId === undefined ? {} : { workItemId }),
    ...(reference === undefined ? {} : { reference }),
    categories,
    outcomes,
    limit: limit as number,
    ...(after === undefined ? {} : { after }),
  })
}

export function queryAuditTimeline(
  database: DatabaseSync,
  input: AuditTimelineQuery = {},
): AuditTimelinePage {
  const query = parseTimelineQuery(input)
  const clauses: string[] = []
  const parameters: Array<string | number> = []
  clauses.push(`audit.category IN (${query.categories.map(() => '?').join(', ')})`)
  parameters.push(...query.categories)
  clauses.push(`audit.outcome IN (${query.outcomes.map(() => '?').join(', ')})`)
  parameters.push(...query.outcomes)
  if (query.workItemId !== undefined) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM audit_references work_item_reference
         WHERE work_item_reference.audit_record_id = audit.id
           AND work_item_reference.reference_kind = 'work_item'
           AND work_item_reference.reference_id = ?
       )`,
    )
    parameters.push(query.workItemId)
  }
  if (query.reference !== undefined) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM audit_references exact_reference
         WHERE exact_reference.audit_record_id = audit.id
           AND exact_reference.reference_kind = ?
           AND exact_reference.reference_id = ?
       )`,
    )
    parameters.push(query.reference.kind, query.reference.id)
  }
  if (query.after !== undefined) {
    clauses.push(
      `(julianday(audit.occurred_at) < julianday(?) OR
        (julianday(audit.occurred_at) = julianday(?) AND audit.occurred_at < ?) OR
        (audit.occurred_at = ? AND audit.id > ?))`,
    )
    parameters.push(
      query.after.occurredAt,
      query.after.occurredAt,
      query.after.occurredAt,
      query.after.occurredAt,
      query.after.id,
    )
  }
  try {
    database.exec('BEGIN')
  } catch {
    throw new AuditTimelineError('storage_error', 'The audit query could not start.')
  }
  try {
    const rows = database
      .prepare(
        `SELECT audit.id
         FROM audit_records audit
         WHERE ${clauses.join(' AND ')}
         ORDER BY julianday(audit.occurred_at) DESC, audit.occurred_at DESC, audit.id ASC
         LIMIT ?`,
      )
      .all(...parameters, query.limit + 1) as unknown as readonly { readonly id: unknown }[]
    const ids = rows.map((row) => {
      if (typeof row.id !== 'string') {
        throw new AuditTimelineError('stored_record_invalid', 'A stored audit identity is invalid.')
      }
      return row.id
    })
    const visibleIds = ids.slice(0, query.limit)
    const records = visibleIds.map((id) => {
      const record = readAuditInSnapshot(database, id)
      if (record === undefined) {
        throw new AuditTimelineError('stored_record_invalid', 'A stored audit record is missing.')
      }
      return record
    })
    const last = records.at(-1)
    const nextCursor =
      ids.length > query.limit && last !== undefined
        ? Object.freeze({ occurredAt: last.occurredAt, id: last.id })
        : undefined
    database.exec('COMMIT')
    return Object.freeze({
      records: Object.freeze(records),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof AuditTimelineError) throw error
    throw new AuditTimelineError('storage_error', 'The audit timeline could not be queried.')
  }
}
