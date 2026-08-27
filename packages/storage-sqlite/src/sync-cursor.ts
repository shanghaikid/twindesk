import type { DatabaseSync } from 'node:sqlite'

import {
  parseConnectorCursor,
  type ConnectorCursor,
  type ConnectorCursorId,
  type ExternalEvent,
} from '@twindesk/domain'

import {
  EventIngestionError,
  ingestExternalEventsInTransaction,
  parseExternalEventBatch,
  type EventIngestionResult,
} from './event-ingestion.ts'
import {
  WorkItemProjectionError,
  parseWorkItemProjectionBatch,
  putWorkItemProjectionInTransaction,
  type ParsedWorkItemProjectionInput,
  type WorkItemProjectionInput,
  type WorkItemProjectionWriteResult,
} from './work-item-projection.ts'

export type SyncCursorErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'identity_mismatch'
  | 'cursor_conflict'
  | 'cursor_regression'
  | 'stored_cursor_invalid'
  | 'storage_error'

export type SyncIdentityMismatch =
  'cursor_connector' | 'cursor_account' | 'cursor_stream' | 'event_connector' | 'event_account'

export class SyncCursorError extends Error {
  readonly code: SyncCursorErrorCode
  readonly inputIndex: number | undefined
  readonly mismatch: SyncIdentityMismatch | undefined

  constructor(
    code: SyncCursorErrorCode,
    message: string,
    details: {
      readonly inputIndex?: number
      readonly mismatch?: SyncIdentityMismatch
    } = {},
  ) {
    super(message)
    this.name = 'SyncCursorError'
    this.code = code
    this.inputIndex = details.inputIndex
    this.mismatch = details.mismatch
  }
}

export interface ConnectorCursorKey {
  readonly connectorId: string
  readonly accountId: string
  readonly stream: string
}

export interface ConnectorSyncCommitRequest extends ConnectorCursorKey {
  readonly events: readonly ExternalEvent[]
  readonly candidateCursor?: ConnectorCursor
  readonly projections?: readonly WorkItemProjectionInput[]
}

export type CursorCommitResult =
  | { readonly disposition: 'not_provided' }
  | {
      readonly disposition: 'inserted' | 'advanced' | 'unchanged'
      readonly cursorId: ConnectorCursorId
    }

export interface ConnectorSyncCommitResult {
  readonly ingestion: EventIngestionResult
  readonly projections: readonly WorkItemProjectionWriteResult[]
  readonly cursor: CursorCommitResult
}

interface ConnectorCursorRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly connector_id: unknown
  readonly account_id: unknown
  readonly stream: unknown
  readonly position: unknown
  readonly committed_through: unknown
  readonly updated_at: unknown
}

interface ParsedCommitRequest extends ConnectorCursorKey {
  readonly events: readonly ExternalEvent[]
  readonly candidateCursor: ConnectorCursor | undefined
  readonly projections: readonly ParsedWorkItemProjectionInput[]
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncCursorError('invalid_request', 'The synchronization request must be an object.')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SyncCursorError(
      'invalid_request',
      'The synchronization request must be a plain data object.',
    )
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new SyncCursorError(
      'invalid_request',
      'The synchronization request must not contain symbol fields.',
    )
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new SyncCursorError(
        'invalid_request',
        'The synchronization request must not contain accessors.',
      )
    }
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const keys = Object.keys(descriptors)
  if (
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new SyncCursorError(
      'invalid_request',
      'The synchronization request has missing or unsupported fields.',
    )
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SyncCursorError(
      'invalid_request',
      'Synchronization identity fields must be non-empty strings.',
    )
  }
  return value
}

function parseCursorKey(value: unknown): ConnectorCursorKey {
  const record = dataRecord(value, ['connectorId', 'accountId', 'stream'])
  return Object.freeze({
    connectorId: nonEmptyString(record.connectorId),
    accountId: nonEmptyString(record.accountId),
    stream: nonEmptyString(record.stream),
  })
}

function assertCursorIdentity(cursor: ConnectorCursor, key: ConnectorCursorKey): void {
  if (cursor.connectorId !== key.connectorId) {
    throw new SyncCursorError(
      'identity_mismatch',
      'The candidate cursor connector does not match the synchronization request.',
      { mismatch: 'cursor_connector' },
    )
  }
  if (cursor.accountId !== key.accountId) {
    throw new SyncCursorError(
      'identity_mismatch',
      'The candidate cursor account does not match the synchronization request.',
      { mismatch: 'cursor_account' },
    )
  }
  if (cursor.stream !== key.stream) {
    throw new SyncCursorError(
      'identity_mismatch',
      'The candidate cursor stream does not match the synchronization request.',
      { mismatch: 'cursor_stream' },
    )
  }
}

function assertEventIdentities(events: readonly ExternalEvent[], key: ConnectorCursorKey): void {
  for (let inputIndex = 0; inputIndex < events.length; inputIndex += 1) {
    const event = events[inputIndex]
    if (event === undefined) continue
    if (event.source.connectorId !== key.connectorId) {
      throw new SyncCursorError(
        'identity_mismatch',
        'An event connector does not match the synchronization request.',
        { inputIndex, mismatch: 'event_connector' },
      )
    }
    if (event.source.accountId !== key.accountId) {
      throw new SyncCursorError(
        'identity_mismatch',
        'An event account does not match the synchronization request.',
        { inputIndex, mismatch: 'event_account' },
      )
    }
  }
}

function parseCommitRequest(value: ConnectorSyncCommitRequest): ParsedCommitRequest {
  const record = dataRecord(
    value,
    ['connectorId', 'accountId', 'stream', 'events'],
    ['candidateCursor', 'projections'],
  )
  const key = {
    connectorId: nonEmptyString(record.connectorId),
    accountId: nonEmptyString(record.accountId),
    stream: nonEmptyString(record.stream),
  }
  const events = parseExternalEventBatch(record.events as readonly ExternalEvent[])
  const candidateCursor = Object.hasOwn(record, 'candidateCursor')
    ? parseConnectorCursor(record.candidateCursor)
    : undefined
  const projections = Object.hasOwn(record, 'projections')
    ? parseWorkItemProjectionBatch(record.projections)
    : Object.freeze([])
  if (candidateCursor !== undefined) assertCursorIdentity(candidateCursor, key)
  assertEventIdentities(events, key)
  return Object.freeze({ ...key, events, candidateCursor, projections })
}

function parseStoredCursor(row: ConnectorCursorRow): ConnectorCursor {
  try {
    return parseConnectorCursor({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      connectorId: row.connector_id,
      accountId: row.account_id,
      stream: row.stream,
      position: row.position,
      ...(row.committed_through === null ? {} : { committedThrough: row.committed_through }),
      updatedAt: row.updated_at,
    })
  } catch {
    throw new SyncCursorError(
      'stored_cursor_invalid',
      'A stored synchronization cursor does not match the supported schema.',
    )
  }
}

function prepareCursorStatements(database: DatabaseSync) {
  try {
    return {
      findByIdentity: database.prepare(
        `SELECT kind, schema_version, id, connector_id, account_id, stream,
                position, committed_through, updated_at
         FROM connector_cursors
         WHERE id = ? OR (connector_id = ? AND account_id = ? AND stream = ?)`,
      ),
      insert: database.prepare(
        `INSERT INTO connector_cursors (
           kind, schema_version, id, connector_id, account_id, stream,
           position, committed_through, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      update: database.prepare(
        `UPDATE connector_cursors
         SET position = ?, committed_through = ?, updated_at = ?
         WHERE id = ?`,
      ),
    }
  } catch {
    throw new SyncCursorError('storage_error', 'Synchronization cursor storage is unavailable.')
  }
}

function sameCheckpoint(left: ConnectorCursor, right: ConnectorCursor): boolean {
  return left.position === right.position && left.committedThrough === right.committedThrough
}

function assertForwardCursor(existing: ConnectorCursor, candidate: ConnectorCursor): void {
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new SyncCursorError(
      'cursor_regression',
      'The candidate cursor is older than the durable cursor.',
    )
  }
  if (
    existing.committedThrough !== undefined &&
    (candidate.committedThrough === undefined ||
      Date.parse(candidate.committedThrough) < Date.parse(existing.committedThrough))
  ) {
    throw new SyncCursorError(
      'cursor_regression',
      'The candidate cursor would regress the durable source watermark.',
    )
  }
}

function writeCursorInTransaction(
  database: DatabaseSync,
  candidate: ConnectorCursor,
): CursorCommitResult {
  const statements = prepareCursorStatements(database)
  const rows = statements.findByIdentity.all(
    candidate.id,
    candidate.connectorId,
    candidate.accountId,
    candidate.stream,
  ) as unknown as ConnectorCursorRow[]

  if (rows.length === 0) {
    const result = statements.insert.run(
      candidate.kind,
      candidate.schemaVersion,
      candidate.id,
      candidate.connectorId,
      candidate.accountId,
      candidate.stream,
      candidate.position,
      candidate.committedThrough ?? null,
      candidate.updatedAt,
    )
    if (result.changes !== 1) {
      throw new SyncCursorError('storage_error', 'The synchronization cursor was not stored.')
    }
    return Object.freeze({ disposition: 'inserted', cursorId: candidate.id })
  }

  if (rows.length !== 1) {
    throw new SyncCursorError(
      'cursor_conflict',
      'The candidate cursor conflicts with multiple durable identities.',
    )
  }
  const existing = parseStoredCursor(rows[0] as ConnectorCursorRow)
  if (
    existing.id !== candidate.id ||
    existing.connectorId !== candidate.connectorId ||
    existing.accountId !== candidate.accountId ||
    existing.stream !== candidate.stream
  ) {
    throw new SyncCursorError(
      'cursor_conflict',
      'The candidate cursor conflicts with a durable identity.',
    )
  }
  if (sameCheckpoint(existing, candidate)) {
    return Object.freeze({ disposition: 'unchanged', cursorId: existing.id })
  }

  assertForwardCursor(existing, candidate)
  const result = statements.update.run(
    candidate.position,
    candidate.committedThrough ?? null,
    candidate.updatedAt,
    candidate.id,
  )
  if (result.changes !== 1) {
    throw new SyncCursorError('storage_error', 'The synchronization cursor was not advanced.')
  }
  return Object.freeze({ disposition: 'advanced', cursorId: candidate.id })
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed synchronization failure if SQLite already rolled back.
  }
}

export function readConnectorCursor(
  database: DatabaseSync,
  input: ConnectorCursorKey,
): ConnectorCursor | undefined {
  const key = parseCursorKey(input)
  try {
    const row = database
      .prepare(
        `SELECT kind, schema_version, id, connector_id, account_id, stream,
                position, committed_through, updated_at
         FROM connector_cursors
         WHERE connector_id = ? AND account_id = ? AND stream = ?`,
      )
      .get(key.connectorId, key.accountId, key.stream) as ConnectorCursorRow | undefined
    return row === undefined ? undefined : parseStoredCursor(row)
  } catch (error) {
    if (error instanceof SyncCursorError) throw error
    throw new SyncCursorError('storage_error', 'The synchronization cursor could not be read.')
  }
}

export function commitConnectorSyncBatch(
  database: DatabaseSync,
  input: ConnectorSyncCommitRequest,
): ConnectorSyncCommitResult {
  const request = parseCommitRequest(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new SyncCursorError('storage_error', 'The synchronization transaction could not start.')
  }

  try {
    const ingestion = ingestExternalEventsInTransaction(database, request.events)
    const projections = Object.freeze(
      request.projections.map((projection) =>
        putWorkItemProjectionInTransaction(database, projection),
      ),
    )
    const cursor =
      request.candidateCursor === undefined
        ? Object.freeze({ disposition: 'not_provided' as const })
        : writeCursorInTransaction(database, request.candidateCursor)
    database.exec('COMMIT')
    return Object.freeze({ ingestion, projections, cursor })
  } catch (error) {
    rollback(database)
    if (
      error instanceof EventIngestionError ||
      error instanceof SyncCursorError ||
      error instanceof WorkItemProjectionError
    ) {
      throw error
    }
    throw new SyncCursorError('storage_error', 'The synchronization batch could not be committed.')
  }
}
