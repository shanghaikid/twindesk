import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  ActionProposal,
  ActionProposalId,
  ActionProposalStateTransition,
  AuditRecord,
  AuditRecordId,
  ConnectorCursor,
  Draft,
  DraftId,
  DraftStateTransition,
  ExternalEvent,
  WorkItem,
  WorkItemId,
  WorkItemUserAction,
} from '@twindesk/domain'

import {
  AuditTimelineError,
  appendAuditRecords as storeAuditRecords,
  queryAuditTimeline as queryStoredAuditTimeline,
  readAuditRecord,
  type AuditAppendResult,
  type AuditTimelinePage,
  type AuditTimelineQuery,
} from './audit-timeline.ts'

import {
  DraftActionStateError,
  createActionProposal as storeActionProposal,
  createDraft as storeDraft,
  readActionProposal,
  readDraft,
  transitionActionProposal as storeActionProposalTransition,
  transitionDraft as storeDraftTransition,
  type ActionProposalTransitionWriteResult,
  type ActionProposalWriteResult,
  type DraftTransitionWriteResult,
  type DraftWriteResult,
} from './draft-action-state.ts'

import {
  EventIngestionError,
  ingestExternalEvents,
  type EventIngestionResult,
} from './event-ingestion.ts'
import {
  LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
  TWIN_DESK_SQLITE_APPLICATION_ID,
  type SqliteMigration,
} from './schema.ts'
import {
  SyncCursorError,
  commitConnectorSyncBatch,
  readConnectorCursor,
  type ConnectorCursorKey,
  type ConnectorSyncCommitRequest,
  type ConnectorSyncCommitResult,
} from './sync-cursor.ts'
import {
  ThreadLifecycleError,
  deleteThread as deleteStoredThread,
  exportThread as exportStoredThread,
  type ThreadDeletionRequest,
  type ThreadDeletionResult,
  type ThreadExportRequest,
  type ThreadExportResult,
} from './thread-lifecycle.ts'
import {
  WorkItemProjectionError,
  applyWorkItemUserAction as storeWorkItemUserAction,
  putWorkItemProjection as storeWorkItemProjection,
  queryInbox as queryStoredInbox,
  readWorkItem,
  rebuildWorkItemProjection as rebuildStoredWorkItemProjection,
  type InboxPage,
  type InboxQuery,
  type WorkItemProjectionInput,
  type WorkItemProjectionWriteResult,
  type WorkItemUserActionWriteResult,
} from './work-item-projection.ts'

export type StorageSchemaErrorCode =
  | 'foreign_database'
  | 'unsupported_schema_version'
  | 'migration_history_mismatch'
  | 'invalid_migration_plan'
  | 'migration_failed'

export class StorageSchemaError extends Error {
  readonly code: StorageSchemaErrorCode
  readonly currentVersion: number | undefined
  readonly targetVersion: number | undefined

  constructor(
    code: StorageSchemaErrorCode,
    message: string,
    versions: { readonly current?: number; readonly target?: number } = {},
  ) {
    super(message)
    this.name = 'StorageSchemaError'
    this.code = code
    this.currentVersion = versions.current
    this.targetVersion = versions.target
  }
}

export interface TwinDeskDatabaseOptions {
  /** SQLite lock wait in milliseconds. */
  readonly timeoutMs?: number
}

export interface TwinDeskDatabase {
  readonly schemaVersion: number
  readonly isOpen: boolean
  ingestExternalEvents(events: readonly ExternalEvent[]): EventIngestionResult
  getConnectorCursor(key: ConnectorCursorKey): ConnectorCursor | undefined
  commitConnectorSyncBatch(request: ConnectorSyncCommitRequest): ConnectorSyncCommitResult
  putWorkItemProjection(input: WorkItemProjectionInput): WorkItemProjectionWriteResult
  applyWorkItemUserAction(action: WorkItemUserAction): WorkItemUserActionWriteResult
  rebuildWorkItemProjection(id: WorkItemId): WorkItem
  getWorkItem(id: WorkItemId): WorkItem | undefined
  queryInbox(query?: InboxQuery): InboxPage
  createDraft(draft: Draft): DraftWriteResult
  transitionDraft(transition: DraftStateTransition): DraftTransitionWriteResult
  getDraft(id: DraftId): Draft | undefined
  createActionProposal(proposal: ActionProposal): ActionProposalWriteResult
  transitionActionProposal(
    transition: ActionProposalStateTransition,
  ): ActionProposalTransitionWriteResult
  getActionProposal(id: ActionProposalId): ActionProposal | undefined
  appendAuditRecords(records: readonly AuditRecord[]): AuditAppendResult
  getAuditRecord(id: AuditRecordId): AuditRecord | undefined
  queryAuditTimeline(query?: AuditTimelineQuery): AuditTimelinePage
  exportThread(request: ThreadExportRequest): ThreadExportResult
  deleteThread(request: ThreadDeletionRequest): ThreadDeletionResult
  close(): void
  [Symbol.dispose](): void
}

class TwinDeskDatabaseHandle implements TwinDeskDatabase {
  readonly schemaVersion = LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION
  #database: DatabaseSync | undefined

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  get isOpen(): boolean {
    return this.#database !== undefined
  }

  ingestExternalEvents(events: readonly ExternalEvent[]): EventIngestionResult {
    const database = this.#database
    if (database === undefined) {
      throw new EventIngestionError('database_closed', 'The TwinDesk database is closed.')
    }
    return ingestExternalEvents(database, events)
  }

  getConnectorCursor(key: ConnectorCursorKey): ConnectorCursor | undefined {
    const database = this.#database
    if (database === undefined) {
      throw new SyncCursorError('database_closed', 'The TwinDesk database is closed.')
    }
    return readConnectorCursor(database, key)
  }

  commitConnectorSyncBatch(request: ConnectorSyncCommitRequest): ConnectorSyncCommitResult {
    const database = this.#database
    if (database === undefined) {
      throw new SyncCursorError('database_closed', 'The TwinDesk database is closed.')
    }
    return commitConnectorSyncBatch(database, request)
  }

  putWorkItemProjection(input: WorkItemProjectionInput): WorkItemProjectionWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new WorkItemProjectionError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeWorkItemProjection(database, input)
  }

  applyWorkItemUserAction(action: WorkItemUserAction): WorkItemUserActionWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new WorkItemProjectionError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeWorkItemUserAction(database, action)
  }

  rebuildWorkItemProjection(id: WorkItemId): WorkItem {
    const database = this.#database
    if (database === undefined) {
      throw new WorkItemProjectionError('database_closed', 'The TwinDesk database is closed.')
    }
    return rebuildStoredWorkItemProjection(database, id)
  }

  getWorkItem(id: WorkItemId): WorkItem | undefined {
    const database = this.#database
    if (database === undefined) {
      throw new WorkItemProjectionError('database_closed', 'The TwinDesk database is closed.')
    }
    return readWorkItem(database, id)
  }

  queryInbox(query: InboxQuery = {}): InboxPage {
    const database = this.#database
    if (database === undefined) {
      throw new WorkItemProjectionError('database_closed', 'The TwinDesk database is closed.')
    }
    return queryStoredInbox(database, query)
  }

  createDraft(draft: Draft): DraftWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeDraft(database, draft)
  }

  transitionDraft(transition: DraftStateTransition): DraftTransitionWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeDraftTransition(database, transition)
  }

  getDraft(id: DraftId): Draft | undefined {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return readDraft(database, id)
  }

  createActionProposal(proposal: ActionProposal): ActionProposalWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeActionProposal(database, proposal)
  }

  transitionActionProposal(
    transition: ActionProposalStateTransition,
  ): ActionProposalTransitionWriteResult {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeActionProposalTransition(database, transition)
  }

  getActionProposal(id: ActionProposalId): ActionProposal | undefined {
    const database = this.#database
    if (database === undefined) {
      throw new DraftActionStateError('database_closed', 'The TwinDesk database is closed.')
    }
    return readActionProposal(database, id)
  }

  appendAuditRecords(records: readonly AuditRecord[]): AuditAppendResult {
    const database = this.#database
    if (database === undefined) {
      throw new AuditTimelineError('database_closed', 'The TwinDesk database is closed.')
    }
    return storeAuditRecords(database, records)
  }

  getAuditRecord(id: AuditRecordId): AuditRecord | undefined {
    const database = this.#database
    if (database === undefined) {
      throw new AuditTimelineError('database_closed', 'The TwinDesk database is closed.')
    }
    return readAuditRecord(database, id)
  }

  queryAuditTimeline(query: AuditTimelineQuery = {}): AuditTimelinePage {
    const database = this.#database
    if (database === undefined) {
      throw new AuditTimelineError('database_closed', 'The TwinDesk database is closed.')
    }
    return queryStoredAuditTimeline(database, query)
  }

  exportThread(request: ThreadExportRequest): ThreadExportResult {
    const database = this.#database
    if (database === undefined) {
      throw new ThreadLifecycleError('database_closed', 'The TwinDesk database is closed.')
    }
    return exportStoredThread(database, request)
  }

  deleteThread(request: ThreadDeletionRequest): ThreadDeletionResult {
    const database = this.#database
    if (database === undefined) {
      throw new ThreadLifecycleError('database_closed', 'The TwinDesk database is closed.')
    }
    return deleteStoredThread(database, request)
  }

  close(): void {
    const database = this.#database
    this.#database = undefined
    database?.close()
  }

  [Symbol.dispose](): void {
    this.close()
  }
}

interface MigrationHistoryRow {
  readonly version: number
  readonly name: string
  readonly checksum: string
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new StorageSchemaError('foreign_database', `SQLite ${pragma} is not a valid integer.`)
  }
  return value
}

function listApplicationTables(database: DatabaseSync): readonly string[] {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as unknown as readonly { readonly name: string }[]
  return rows.map((row) => row.name)
}

function listApplicationObjects(database: DatabaseSync): readonly string[] {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as unknown as readonly { readonly name: string }[]
  return rows.map((row) => row.name)
}

function migrationChecksum(migration: SqliteMigration): string {
  return createHash('sha256').update(migration.sql, 'utf8').digest('hex')
}

function validateMigrationPlan(): void {
  for (let index = 0; index < SQLITE_MIGRATIONS.length; index += 1) {
    const migration = SQLITE_MIGRATIONS[index]
    if (
      migration === undefined ||
      migration.version !== index + 1 ||
      migration.name.length === 0 ||
      migration.sql.length === 0
    ) {
      throw new StorageSchemaError(
        'invalid_migration_plan',
        'TwinDesk SQLite migrations must be non-empty and consecutively numbered from 1.',
        { target: LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION },
      )
    }
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed migration failure. SQLite already rolls back some
    // fatal transaction failures automatically.
  }
}

function applyMigration(database: DatabaseSync, migration: SqliteMigration): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(migration.sql)
    database
      .prepare(
        `INSERT INTO twindesk_schema_migrations
           (version, name, checksum, applied_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run(migration.version, migration.name, migrationChecksum(migration))
    database.exec(`PRAGMA application_id = ${TWIN_DESK_SQLITE_APPLICATION_ID}`)
    database.exec(`PRAGMA user_version = ${migration.version}`)
    database.exec('COMMIT')
  } catch {
    rollback(database)
    throw new StorageSchemaError(
      'migration_failed',
      `SQLite migration ${migration.version} failed.`,
      {
        current: migration.version - 1,
        target: migration.version,
      },
    )
  }
}

function verifyMigrationHistory(database: DatabaseSync, currentVersion: number): void {
  if (currentVersion === 0) return

  const tables = listApplicationTables(database)
  if (!tables.includes('twindesk_schema_migrations')) {
    throw new StorageSchemaError(
      'migration_history_mismatch',
      'The TwinDesk migration history table is missing.',
      { current: currentVersion, target: LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION },
    )
  }

  const rows = database
    .prepare(
      `SELECT version, name, checksum
       FROM twindesk_schema_migrations
       ORDER BY version`,
    )
    .all() as unknown as readonly MigrationHistoryRow[]
  const expected = SQLITE_MIGRATIONS.filter((migration) => migration.version <= currentVersion)

  if (rows.length !== expected.length) {
    throw new StorageSchemaError(
      'migration_history_mismatch',
      'The TwinDesk migration history is incomplete.',
      { current: currentVersion, target: LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION },
    )
  }

  for (let index = 0; index < expected.length; index += 1) {
    const migration = expected[index]
    const row = rows[index]
    if (
      migration === undefined ||
      row === undefined ||
      row.version !== migration.version ||
      row.name !== migration.name ||
      row.checksum !== migrationChecksum(migration)
    ) {
      throw new StorageSchemaError(
        'migration_history_mismatch',
        'The TwinDesk migration history does not match this build.',
        { current: currentVersion, target: LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION },
      )
    }
  }
}

function migrate(database: DatabaseSync): void {
  validateMigrationPlan()
  const applicationId = readPragmaNumber(database, 'application_id')
  const currentVersion = readPragmaNumber(database, 'user_version')
  const applicationObjects = listApplicationObjects(database)

  if (applicationId !== 0 && applicationId !== TWIN_DESK_SQLITE_APPLICATION_ID) {
    throw new StorageSchemaError(
      'foreign_database',
      'The selected SQLite file belongs to another application.',
    )
  }

  if (applicationId === 0 && (currentVersion !== 0 || applicationObjects.length > 0)) {
    throw new StorageSchemaError(
      'foreign_database',
      'The selected SQLite file is not an empty TwinDesk database.',
    )
  }

  if (currentVersion > LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION) {
    throw new StorageSchemaError(
      'unsupported_schema_version',
      'The TwinDesk database was created by a newer build.',
      { current: currentVersion, target: LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION },
    )
  }

  if (applicationId === TWIN_DESK_SQLITE_APPLICATION_ID) {
    verifyMigrationHistory(database, currentVersion)
  }

  for (const migration of SQLITE_MIGRATIONS) {
    if (migration.version > currentVersion) applyMigration(database, migration)
  }
}

export function openTwinDeskDatabase(
  path: string,
  options: TwinDeskDatabaseOptions = {},
): TwinDeskDatabase {
  if (path.length === 0) throw new TypeError('SQLite path must not be empty.')
  const timeout = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new TypeError('SQLite timeoutMs must be a non-negative safe integer.')
  }

  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout,
  })

  try {
    database.exec('PRAGMA trusted_schema = OFF')
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    database.exec('PRAGMA journal_mode = WAL')
    return new TwinDeskDatabaseHandle(database)
  } catch (error) {
    try {
      database.close()
    } catch {
      // Do not mask a typed schema or migration failure with cleanup failure.
    }
    throw error
  }
}
