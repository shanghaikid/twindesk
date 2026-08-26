import type { DatabaseSync } from 'node:sqlite'

import {
  parseExternalThread,
  parseIsoTimestamp,
  parseWorkItem,
  parseWorkItemUserAction,
  type ExternalEventId,
  type ExternalReference,
  type ExternalThread,
  type InboxState,
  type IsoTimestamp,
  type WorkItem,
  type WorkItemId,
  type WorkItemUserAction,
} from '@twindesk/domain'

export type WorkItemProjectionErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'identity_conflict'
  | 'stale_projection'
  | 'missing_event'
  | 'source_mismatch'
  | 'missing_projection'
  | 'action_conflict'
  | 'action_sequence'
  | 'action_chronology'
  | 'stored_projection_invalid'
  | 'storage_error'

export class WorkItemProjectionError extends Error {
  readonly code: WorkItemProjectionErrorCode

  constructor(code: WorkItemProjectionErrorCode, message: string) {
    super(message)
    this.name = 'WorkItemProjectionError'
    this.code = code
  }
}

export interface WorkItemProjectionInput {
  readonly thread: ExternalThread
  readonly workItem: WorkItem
}

export interface WorkItemProjectionWriteResult {
  readonly disposition: 'inserted' | 'updated' | 'unchanged'
  readonly workItem: WorkItem
}

export interface WorkItemUserActionWriteResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly workItem: WorkItem
}

export interface InboxCursor {
  readonly updatedAt: IsoTimestamp
  readonly id: WorkItemId
}

export interface InboxQuery {
  readonly states?: readonly InboxState[]
  readonly limit?: number
  readonly after?: InboxCursor
}

export interface InboxPage {
  readonly items: readonly WorkItem[]
  readonly nextCursor?: InboxCursor
}

interface ThreadRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly subject: unknown
  readonly created_at: unknown
  readonly updated_at: unknown
}

interface ReferenceRow {
  readonly connector_id: unknown
  readonly account_id: unknown
  readonly object_type: unknown
  readonly external_id: unknown
  readonly source_timestamp: unknown
}

interface EventIdRow {
  readonly event_id: unknown
}

interface EventSourceRow {
  readonly connector_id: unknown
  readonly account_id: unknown
  readonly object_type: unknown
  readonly external_id: unknown
  readonly source_timestamp: unknown
}

interface WorkItemRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly thread_id: unknown
  readonly inbox_state: unknown
  readonly title: unknown
  readonly summary: unknown
  readonly attention_reason: unknown
  readonly selected_persona_id: unknown
  readonly created_at: unknown
  readonly updated_at: unknown
}

interface ActionRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly work_item_id: unknown
  readonly revision: unknown
  readonly action_type: unknown
  readonly inbox_state: unknown
  readonly persona_id: unknown
  readonly occurred_at: unknown
}

interface ParsedProjectionInput {
  readonly thread: ExternalThread
  readonly workItem: WorkItem
}

const ALL_INBOX_STATES = Object.freeze(['needs_reply', 'needs_review', 'waiting', 'done'] as const)

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkItemProjectionError('invalid_request', 'The request must be an object.')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkItemProjectionError('invalid_request', 'The request must be a plain data object.')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new WorkItemProjectionError('invalid_request', 'The request has unsupported fields.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new WorkItemProjectionError(
        'invalid_request',
        'The request must not contain accessors.',
      )
    }
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const keys = Object.keys(descriptors)
  if (
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new WorkItemProjectionError(
      'invalid_request',
      'The request has missing or unsupported fields.',
    )
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkItemProjectionError('invalid_request', 'The identifier must be non-empty.')
  }
  return value
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed projection failure if SQLite already rolled back.
  }
}

function referenceIdentity(reference: ExternalReference): string {
  return `${reference.connectorId}\u0000${reference.accountId}\u0000${reference.objectType}\u0000${reference.externalId}`
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(',')}}`
}

function sameValues(left: unknown, right: unknown): boolean {
  return canonicalValue(left) === canonicalValue(right)
}

function parseProjectionInput(input: WorkItemProjectionInput): ParsedProjectionInput {
  const record = dataRecord(input, ['thread', 'workItem'])
  const thread = parseExternalThread(record.thread)
  const workItem = parseWorkItem(record.workItem)
  if (workItem.threadId !== thread.id) {
    throw new WorkItemProjectionError(
      'identity_conflict',
      'The Work Item does not belong to the supplied Thread.',
    )
  }
  const threadEvents = new Set<string>(thread.sourceEventIds)
  if (workItem.sourceEventIds.some((eventId) => !threadEvents.has(eventId))) {
    throw new WorkItemProjectionError(
      'source_mismatch',
      'The Work Item references an event outside its Thread.',
    )
  }
  return Object.freeze({ thread, workItem })
}

function parseStoredReference(row: ReferenceRow): ExternalReference {
  const reference = {
    connectorId: row.connector_id,
    accountId: row.account_id,
    objectType: row.object_type,
    externalId: row.external_id,
    ...(row.source_timestamp === null ? {} : { sourceTimestamp: row.source_timestamp }),
  }
  try {
    return parseExternalThread({
      kind: 'external_thread',
      schemaVersion: 1,
      id: 'stored-reference-probe',
      subject: 'Stored reference probe',
      externalReferences: [reference],
      sourceEventIds: ['stored-event-probe'],
      createdAt: '2000-01-01T00:00:00Z',
      updatedAt: '2000-01-01T00:00:00Z',
    }).externalReferences[0] as ExternalReference
  } catch {
    throw new WorkItemProjectionError(
      'stored_projection_invalid',
      'A stored Thread reference is invalid.',
    )
  }
}

function stringEventIds(rows: readonly EventIdRow[]): readonly ExternalEventId[] {
  const ids = rows.map((row) => {
    if (typeof row.event_id !== 'string' || row.event_id.length === 0) {
      throw new WorkItemProjectionError(
        'stored_projection_invalid',
        'A stored projection event reference is invalid.',
      )
    }
    return row.event_id as ExternalEventId
  })
  return Object.freeze(ids)
}

function readThread(database: DatabaseSync, id: string): ExternalThread | undefined {
  const row = database
    .prepare(
      `SELECT kind, schema_version, id, subject, created_at, updated_at
       FROM external_threads WHERE id = ?`,
    )
    .get(id) as ThreadRow | undefined
  if (row === undefined) return undefined
  const references = (
    database
      .prepare(
        `SELECT connector_id, account_id, object_type, external_id, source_timestamp
         FROM thread_external_references WHERE thread_id = ? ORDER BY ordinal`,
      )
      .all(id) as unknown as ReferenceRow[]
  ).map(parseStoredReference)
  const eventIds = stringEventIds(
    database
      .prepare(`SELECT event_id FROM thread_events WHERE thread_id = ? ORDER BY ordinal`)
      .all(id) as unknown as EventIdRow[],
  )
  try {
    return parseExternalThread({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      subject: row.subject,
      externalReferences: references,
      sourceEventIds: eventIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch {
    throw new WorkItemProjectionError(
      'stored_projection_invalid',
      'A stored Thread projection is invalid.',
    )
  }
}

function readBase(database: DatabaseSync, id: string): WorkItem | undefined {
  const row = database
    .prepare(
      `SELECT 'work_item' AS kind, schema_version, work_item_id AS id, thread_id,
              inbox_state, title, summary, attention_reason, selected_persona_id,
              created_at, updated_at
       FROM work_item_projection_bases WHERE work_item_id = ?`,
    )
    .get(id) as WorkItemRow | undefined
  if (row === undefined) return undefined
  const eventIds = stringEventIds(
    database
      .prepare(
        `SELECT event_id FROM work_item_projection_base_events
         WHERE work_item_id = ? ORDER BY ordinal`,
      )
      .all(id) as unknown as EventIdRow[],
  )
  return parseStoredWorkItem(row, eventIds)
}

function parseStoredWorkItem(
  row: WorkItemRow,
  sourceEventIds: readonly ExternalEventId[],
): WorkItem {
  try {
    return parseWorkItem({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      threadId: row.thread_id,
      sourceEventIds,
      inboxState: row.inbox_state,
      title: row.title,
      summary: row.summary,
      attentionReason: row.attention_reason,
      ...(row.selected_persona_id === null ? {} : { selectedPersonaId: row.selected_persona_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch {
    throw new WorkItemProjectionError(
      'stored_projection_invalid',
      'A stored Work Item projection is invalid.',
    )
  }
}

function parseStoredAction(row: ActionRow): WorkItemUserAction {
  const actionSpecific =
    row.action_type === 'set_inbox_state'
      ? { inboxState: row.inbox_state }
      : row.action_type === 'select_persona'
        ? { personaId: row.persona_id }
        : {}
  try {
    return parseWorkItemUserAction({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      workItemId: row.work_item_id,
      revision: row.revision,
      action: row.action_type,
      ...actionSpecific,
      occurredAt: row.occurred_at,
    })
  } catch {
    throw new WorkItemProjectionError(
      'stored_projection_invalid',
      'A stored Work Item user action is invalid.',
    )
  }
}

function readActions(database: DatabaseSync, workItemId: string): readonly WorkItemUserAction[] {
  const rows = database
    .prepare(
      `SELECT kind, schema_version, id, work_item_id, revision, action_type,
              inbox_state, persona_id, occurred_at
       FROM work_item_user_actions WHERE work_item_id = ? ORDER BY revision`,
    )
    .all(workItemId) as unknown as ActionRow[]
  return Object.freeze(rows.map(parseStoredAction))
}

function validateSourceEvents(database: DatabaseSync, thread: ExternalThread): void {
  const references = new Map(
    thread.externalReferences.map((reference) => [referenceIdentity(reference), reference]),
  )
  const findEvent = database.prepare(
    `SELECT connector_id, account_id, object_type, external_id, source_timestamp
     FROM external_events WHERE id = ?`,
  )
  for (const eventId of thread.sourceEventIds) {
    const row = findEvent.get(eventId) as EventSourceRow | undefined
    if (row === undefined) {
      throw new WorkItemProjectionError(
        'missing_event',
        'A projection source event is not durable.',
      )
    }
    const identity =
      typeof row.connector_id === 'string' &&
      typeof row.account_id === 'string' &&
      typeof row.object_type === 'string' &&
      typeof row.external_id === 'string'
        ? `${row.connector_id}\u0000${row.account_id}\u0000${row.object_type}\u0000${row.external_id}`
        : undefined
    const reference = identity === undefined ? undefined : references.get(identity)
    if (
      typeof row.connector_id !== 'string' ||
      typeof row.account_id !== 'string' ||
      typeof row.object_type !== 'string' ||
      typeof row.external_id !== 'string' ||
      (row.source_timestamp !== null &&
        (typeof row.source_timestamp !== 'string' ||
          !Number.isFinite(Date.parse(row.source_timestamp))))
    ) {
      throw new WorkItemProjectionError(
        'stored_projection_invalid',
        'A durable projection event reference is invalid.',
      )
    }
    if (
      reference === undefined ||
      (typeof row.source_timestamp === 'string' &&
        (reference.sourceTimestamp === undefined ||
          Date.parse(reference.sourceTimestamp) < Date.parse(row.source_timestamp)))
    ) {
      throw new WorkItemProjectionError(
        'source_mismatch',
        'A projection event does not match a Thread reference.',
      )
    }
  }
}

function assertThreadCanAdvance(existing: ExternalThread, candidate: ExternalThread): void {
  if (existing.createdAt !== candidate.createdAt) {
    throw new WorkItemProjectionError(
      'identity_conflict',
      'The Thread stable identity conflicts with its durable projection.',
    )
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new WorkItemProjectionError('stale_projection', 'The Thread projection is stale.')
  }
  const candidateEvents = new Set<string>(candidate.sourceEventIds)
  const candidateReferences = new Map(
    candidate.externalReferences.map((reference) => [referenceIdentity(reference), reference]),
  )
  if (
    existing.sourceEventIds.some((id) => !candidateEvents.has(id)) ||
    existing.externalReferences.some((reference) => {
      const candidateReference = candidateReferences.get(referenceIdentity(reference))
      return (
        candidateReference === undefined ||
        (reference.sourceTimestamp !== undefined &&
          (candidateReference.sourceTimestamp === undefined ||
            Date.parse(candidateReference.sourceTimestamp) < Date.parse(reference.sourceTimestamp)))
      )
    })
  ) {
    throw new WorkItemProjectionError(
      'stale_projection',
      'The Thread projection would remove durable source associations.',
    )
  }
  if (candidate.updatedAt === existing.updatedAt && !sameValues(existing, candidate)) {
    throw new WorkItemProjectionError(
      'identity_conflict',
      'The Thread projection conflicts at the same revision timestamp.',
    )
  }
}

function assertBaseCanAdvance(existing: WorkItem, candidate: WorkItem): void {
  if (existing.threadId !== candidate.threadId || existing.createdAt !== candidate.createdAt) {
    throw new WorkItemProjectionError(
      'identity_conflict',
      'The Work Item stable identity conflicts with its durable projection base.',
    )
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new WorkItemProjectionError('stale_projection', 'The Work Item projection is stale.')
  }
  const candidateEvents = new Set<string>(candidate.sourceEventIds)
  if (existing.sourceEventIds.some((id) => !candidateEvents.has(id))) {
    throw new WorkItemProjectionError(
      'stale_projection',
      'The Work Item projection would remove durable source associations.',
    )
  }
  if (candidate.updatedAt === existing.updatedAt && !sameValues(existing, candidate)) {
    throw new WorkItemProjectionError(
      'identity_conflict',
      'The Work Item projection conflicts at the same revision timestamp.',
    )
  }
}

function replaceThreadLinks(database: DatabaseSync, thread: ExternalThread): void {
  database.prepare(`DELETE FROM thread_external_references WHERE thread_id = ?`).run(thread.id)
  database.prepare(`DELETE FROM thread_events WHERE thread_id = ?`).run(thread.id)
  const insertReference = database.prepare(
    `INSERT INTO thread_external_references (
       thread_id, ordinal, connector_id, account_id, object_type, external_id, source_timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  thread.externalReferences.forEach((reference, ordinal) => {
    insertReference.run(
      thread.id,
      ordinal,
      reference.connectorId,
      reference.accountId,
      reference.objectType,
      reference.externalId,
      reference.sourceTimestamp ?? null,
    )
  })
  const insertEvent = database.prepare(
    `INSERT INTO thread_events (thread_id, event_id, ordinal) VALUES (?, ?, ?)`,
  )
  thread.sourceEventIds.forEach((eventId, ordinal) => insertEvent.run(thread.id, eventId, ordinal))
}

function writeThread(
  database: DatabaseSync,
  thread: ExternalThread,
): 'inserted' | 'updated' | 'unchanged' {
  const existing = readThread(database, thread.id)
  if (existing !== undefined) {
    assertThreadCanAdvance(existing, thread)
    if (sameValues(existing, thread)) return 'unchanged'
    database
      .prepare(`UPDATE external_threads SET subject = ?, updated_at = ? WHERE id = ?`)
      .run(thread.subject, thread.updatedAt, thread.id)
    replaceThreadLinks(database, thread)
    return 'updated'
  }
  database
    .prepare(
      `INSERT INTO external_threads (
         kind, schema_version, id, subject, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      thread.kind,
      thread.schemaVersion,
      thread.id,
      thread.subject,
      thread.createdAt,
      thread.updatedAt,
    )
  replaceThreadLinks(database, thread)
  return 'inserted'
}

function replaceBaseEvents(database: DatabaseSync, workItem: WorkItem): void {
  database
    .prepare(`DELETE FROM work_item_projection_base_events WHERE work_item_id = ?`)
    .run(workItem.id)
  const insert = database.prepare(
    `INSERT INTO work_item_projection_base_events (work_item_id, event_id, ordinal)
     VALUES (?, ?, ?)`,
  )
  workItem.sourceEventIds.forEach((eventId, ordinal) => insert.run(workItem.id, eventId, ordinal))
}

function writeBase(
  database: DatabaseSync,
  workItem: WorkItem,
): 'inserted' | 'updated' | 'unchanged' {
  const existing = readBase(database, workItem.id)
  if (existing !== undefined) {
    assertBaseCanAdvance(existing, workItem)
    if (sameValues(existing, workItem)) return 'unchanged'
    database
      .prepare(
        `UPDATE work_item_projection_bases
         SET inbox_state = ?, title = ?, summary = ?, attention_reason = ?,
             selected_persona_id = ?, updated_at = ?
         WHERE work_item_id = ?`,
      )
      .run(
        workItem.inboxState,
        workItem.title,
        workItem.summary,
        workItem.attentionReason,
        workItem.selectedPersonaId ?? null,
        workItem.updatedAt,
        workItem.id,
      )
    replaceBaseEvents(database, workItem)
    return 'updated'
  }
  database
    .prepare(
      `INSERT INTO work_item_projection_bases (
         kind, schema_version, work_item_id, thread_id, inbox_state, title, summary,
         attention_reason, selected_persona_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'work_item_projection_base',
      workItem.schemaVersion,
      workItem.id,
      workItem.threadId,
      workItem.inboxState,
      workItem.title,
      workItem.summary,
      workItem.attentionReason,
      workItem.selectedPersonaId ?? null,
      workItem.createdAt,
      workItem.updatedAt,
    )
  replaceBaseEvents(database, workItem)
  return 'inserted'
}

function materializeWorkItem(database: DatabaseSync, base: WorkItem): WorkItem {
  let inboxState = base.inboxState
  let selectedPersonaId = base.selectedPersonaId
  let updatedAt = base.updatedAt
  for (const action of readActions(database, base.id)) {
    if (Date.parse(action.occurredAt) < Date.parse(base.updatedAt)) continue
    if (action.action === 'set_inbox_state') inboxState = action.inboxState
    if (action.action === 'select_persona') selectedPersonaId = action.personaId
    if (action.action === 'clear_persona') selectedPersonaId = undefined
    if (Date.parse(action.occurredAt) > Date.parse(updatedAt)) updatedAt = action.occurredAt
  }
  const { selectedPersonaId: _basePersona, ...baseWithoutPersona } = base
  return parseWorkItem({
    ...baseWithoutPersona,
    inboxState,
    ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
    updatedAt,
  })
}

function writeCurrentProjection(database: DatabaseSync, workItem: WorkItem): void {
  database
    .prepare(
      `INSERT INTO work_items (
         kind, schema_version, id, thread_id, inbox_state, title, summary,
         attention_reason, selected_persona_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         schema_version = excluded.schema_version,
         thread_id = excluded.thread_id,
         inbox_state = excluded.inbox_state,
         title = excluded.title,
         summary = excluded.summary,
         attention_reason = excluded.attention_reason,
         selected_persona_id = excluded.selected_persona_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      workItem.kind,
      workItem.schemaVersion,
      workItem.id,
      workItem.threadId,
      workItem.inboxState,
      workItem.title,
      workItem.summary,
      workItem.attentionReason,
      workItem.selectedPersonaId ?? null,
      workItem.createdAt,
      workItem.updatedAt,
    )
  database.prepare(`DELETE FROM work_item_events WHERE work_item_id = ?`).run(workItem.id)
  const insertEvent = database.prepare(
    `INSERT INTO work_item_events (work_item_id, event_id, ordinal) VALUES (?, ?, ?)`,
  )
  workItem.sourceEventIds.forEach((eventId, ordinal) =>
    insertEvent.run(workItem.id, eventId, ordinal),
  )
}

function rebuildInTransaction(database: DatabaseSync, workItemId: string): WorkItem {
  const base = readBase(database, workItemId)
  if (base === undefined) {
    throw new WorkItemProjectionError('missing_projection', 'The Work Item projection is missing.')
  }
  const projection = materializeWorkItem(database, base)
  writeCurrentProjection(database, projection)
  return projection
}

function wrapStorageError(error: unknown, message: string): never {
  if (error instanceof WorkItemProjectionError) throw error
  throw new WorkItemProjectionError('storage_error', message)
}

export function putWorkItemProjection(
  database: DatabaseSync,
  input: WorkItemProjectionInput,
): WorkItemProjectionWriteResult {
  const projection = parseProjectionInput(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new WorkItemProjectionError(
      'storage_error',
      'The projection transaction could not start.',
    )
  }
  try {
    validateSourceEvents(database, projection.thread)
    const threadDisposition = writeThread(database, projection.thread)
    const baseDisposition = writeBase(database, projection.workItem)
    const workItem = rebuildInTransaction(database, projection.workItem.id)
    database.exec('COMMIT')
    const disposition =
      threadDisposition === 'inserted' || baseDisposition === 'inserted'
        ? 'inserted'
        : threadDisposition === 'updated' || baseDisposition === 'updated'
          ? 'updated'
          : 'unchanged'
    return Object.freeze({ disposition, workItem })
  } catch (error) {
    rollback(database)
    return wrapStorageError(error, 'The Work Item projection could not be stored.')
  }
}

export function applyWorkItemUserAction(
  database: DatabaseSync,
  input: WorkItemUserAction,
): WorkItemUserActionWriteResult {
  const action = parseWorkItemUserAction(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new WorkItemProjectionError('storage_error', 'The action transaction could not start.')
  }
  try {
    const base = readBase(database, action.workItemId)
    if (base === undefined) {
      throw new WorkItemProjectionError(
        'missing_projection',
        'The Work Item action has no projection base.',
      )
    }
    const rows = database
      .prepare(
        `SELECT kind, schema_version, id, work_item_id, revision, action_type,
                inbox_state, persona_id, occurred_at
         FROM work_item_user_actions
         WHERE id = ? OR (work_item_id = ? AND revision = ?)`,
      )
      .all(action.id, action.workItemId, action.revision) as unknown as ActionRow[]
    if (rows.length > 0) {
      const duplicate =
        rows.length === 1 && sameValues(parseStoredAction(rows[0] as ActionRow), action)
      if (!duplicate) {
        throw new WorkItemProjectionError(
          'action_conflict',
          'The Work Item action conflicts with a durable identity.',
        )
      }
      const workItem = rebuildInTransaction(database, action.workItemId)
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', workItem })
    }
    const previous = database
      .prepare(
        `SELECT revision, occurred_at
         FROM work_item_user_actions WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(action.workItemId) as
      { readonly revision: unknown; readonly occurred_at: unknown } | undefined
    const expectedRevision = previous === undefined ? 1 : Number(previous.revision) + 1
    if (action.revision !== expectedRevision) {
      throw new WorkItemProjectionError(
        'action_sequence',
        'The Work Item action revision is not the next durable revision.',
      )
    }
    const previousOccurredAt = previous?.occurred_at
    if (previousOccurredAt !== undefined && typeof previousOccurredAt !== 'string') {
      throw new WorkItemProjectionError(
        'stored_projection_invalid',
        'A stored Work Item action timestamp is invalid.',
      )
    }
    const previousTime =
      previousOccurredAt === undefined ||
      Date.parse(base.updatedAt) > Date.parse(previousOccurredAt)
        ? base.updatedAt
        : previousOccurredAt
    if (
      typeof previousTime !== 'string' ||
      Date.parse(action.occurredAt) < Date.parse(previousTime)
    ) {
      throw new WorkItemProjectionError(
        'action_chronology',
        'The Work Item action precedes its durable history.',
      )
    }
    database
      .prepare(
        `INSERT INTO work_item_user_actions (
           kind, schema_version, id, work_item_id, revision, action_type,
           inbox_state, persona_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.kind,
        action.schemaVersion,
        action.id,
        action.workItemId,
        action.revision,
        action.action,
        action.action === 'set_inbox_state' ? action.inboxState : null,
        action.action === 'select_persona' ? action.personaId : null,
        action.occurredAt,
      )
    const workItem = rebuildInTransaction(database, action.workItemId)
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', workItem })
  } catch (error) {
    rollback(database)
    return wrapStorageError(error, 'The Work Item action could not be stored.')
  }
}

export function rebuildWorkItemProjection(database: DatabaseSync, id: WorkItemId): WorkItem {
  const workItemId = nonEmptyString(id)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new WorkItemProjectionError('storage_error', 'The rebuild transaction could not start.')
  }
  try {
    const projection = rebuildInTransaction(database, workItemId)
    database.exec('COMMIT')
    return projection
  } catch (error) {
    rollback(database)
    return wrapStorageError(error, 'The Work Item projection could not be rebuilt.')
  }
}

function readWorkItemInSnapshot(database: DatabaseSync, workItemId: string): WorkItem | undefined {
  const row = database
    .prepare(
      `SELECT kind, schema_version, id, thread_id, inbox_state, title, summary,
              attention_reason, selected_persona_id, created_at, updated_at
       FROM work_items WHERE id = ?`,
    )
    .get(workItemId) as WorkItemRow | undefined
  if (row === undefined) return undefined
  const eventIds = stringEventIds(
    database
      .prepare(`SELECT event_id FROM work_item_events WHERE work_item_id = ? ORDER BY ordinal`)
      .all(workItemId) as unknown as EventIdRow[],
  )
  return parseStoredWorkItem(row, eventIds)
}

export function readWorkItem(database: DatabaseSync, id: WorkItemId): WorkItem | undefined {
  const workItemId = nonEmptyString(id)
  try {
    database.exec('BEGIN')
  } catch {
    throw new WorkItemProjectionError('storage_error', 'The Work Item read could not start.')
  }
  try {
    const workItem = readWorkItemInSnapshot(database, workItemId)
    database.exec('COMMIT')
    return workItem
  } catch (error) {
    rollback(database)
    return wrapStorageError(error, 'The Work Item projection could not be read.')
  }
}

function parseInboxQuery(input: InboxQuery): {
  readonly states: readonly InboxState[]
  readonly limit: number
  readonly after: InboxCursor | undefined
} {
  const record = dataRecord(input, [], ['states', 'limit', 'after'])
  const statesValue = Object.hasOwn(record, 'states') ? record.states : ALL_INBOX_STATES
  if (!Array.isArray(statesValue) || statesValue.length === 0) {
    throw new WorkItemProjectionError('invalid_request', 'Inbox states must be a non-empty array.')
  }
  const states = statesValue.map((state) => {
    if (typeof state !== 'string' || !ALL_INBOX_STATES.includes(state as InboxState)) {
      throw new WorkItemProjectionError('invalid_request', 'The Inbox state is unsupported.')
    }
    return state as InboxState
  })
  if (new Set(states).size !== states.length) {
    throw new WorkItemProjectionError(
      'invalid_request',
      'Inbox states must not contain duplicates.',
    )
  }
  const limit = Object.hasOwn(record, 'limit') ? record.limit : 50
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new WorkItemProjectionError(
      'invalid_request',
      'The Inbox limit must be between 1 and 100.',
    )
  }
  let after: InboxCursor | undefined
  if (Object.hasOwn(record, 'after')) {
    const cursor = dataRecord(record.after, ['updatedAt', 'id'])
    after = Object.freeze({
      updatedAt: parseIsoTimestamp(cursor.updatedAt),
      id: nonEmptyString(cursor.id) as WorkItemId,
    })
  }
  return Object.freeze({ states: Object.freeze(states), limit: limit as number, after })
}

export function queryInbox(database: DatabaseSync, input: InboxQuery = {}): InboxPage {
  const query = parseInboxQuery(input)
  const statePlaceholders = query.states.map(() => '?').join(', ')
  const afterClause =
    query.after === undefined
      ? ''
      : `AND (
           julianday(updated_at) < julianday(?) OR
           (julianday(updated_at) = julianday(?) AND id > ?)
         )`
  const parameters: Array<string | number> = [...query.states]
  if (query.after !== undefined) {
    parameters.push(query.after.updatedAt, query.after.updatedAt, query.after.id)
  }
  parameters.push(query.limit + 1)
  try {
    database.exec('BEGIN')
  } catch {
    throw new WorkItemProjectionError('storage_error', 'The Inbox read could not start.')
  }
  try {
    const rows = database
      .prepare(
        `SELECT id
         FROM work_items
         WHERE inbox_state IN (${statePlaceholders})
         ${afterClause}
         ORDER BY julianday(updated_at) DESC, id ASC
         LIMIT ?`,
      )
      .all(...parameters) as unknown as { readonly id: unknown }[]
    const hasMore = rows.length > query.limit
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows
    const items = pageRows.map((row) => {
      if (typeof row.id !== 'string') {
        throw new WorkItemProjectionError(
          'stored_projection_invalid',
          'A stored Inbox identity is invalid.',
        )
      }
      const item = readWorkItemInSnapshot(database, row.id)
      if (item === undefined) {
        throw new WorkItemProjectionError(
          'stored_projection_invalid',
          'A stored Inbox projection is missing.',
        )
      }
      return item
    })
    const last = items.at(-1)
    const nextCursor =
      hasMore && last !== undefined
        ? Object.freeze({ updatedAt: last.updatedAt, id: last.id })
        : undefined
    const page = Object.freeze({
      items: Object.freeze(items),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    })
    database.exec('COMMIT')
    return page
  } catch (error) {
    rollback(database)
    return wrapStorageError(error, 'The Inbox could not be queried.')
  }
}
