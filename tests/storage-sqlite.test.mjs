import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION,
  StorageSchemaError,
  TWIN_DESK_SQLITE_APPLICATION_ID,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

const expectedTables = [
  'action_proposals',
  'action_receipts',
  'approval_records',
  'audit_records',
  'audit_references',
  'connector_cursors',
  'drafts',
  'external_events',
  'external_threads',
  'thread_events',
  'thread_external_references',
  'twindesk_schema_migrations',
  'work_item_events',
  'work_items',
]

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-storage-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

/**
 * @param {DatabaseSync} database
 * @param {string} pragma
 * @returns {number}
 */
function readNumberPragma(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get()
  const value = Object.values(row ?? {})[0]
  if (typeof value !== 'number') throw new TypeError(`PRAGMA ${pragma} did not return a number.`)
  return value
}

/**
 * @param {DatabaseSync} database
 * @returns {string[]}
 */
function listTables(database) {
  return database
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map(({ name }) => {
      if (typeof name !== 'string') throw new TypeError('SQLite table name must be a string.')
      return name
    })
}

test('a new database receives the isolated TwinDesk schema and durable settings', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  assert.equal(database.schemaVersion, 1)
  assert.equal(database.isOpen, true)
  database.close()
  assert.equal(database.isOpen, false)
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(readNumberPragma(inspection, 'application_id'), TWIN_DESK_SQLITE_APPLICATION_ID)
  assert.equal(readNumberPragma(inspection, 'user_version'), LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION)
  assert.equal(readNumberPragma(inspection, 'foreign_keys'), 1)
  const journalMode = inspection.prepare('PRAGMA journal_mode').get()
  const integrityCheck = inspection.prepare('PRAGMA integrity_check').get()
  assert.ok(journalMode)
  assert.ok(integrityCheck)
  assert.equal(journalMode.journal_mode, 'wal')
  assert.equal(integrityCheck.integrity_check, 'ok')
  assert.deepEqual(listTables(inspection), expectedTables)
  assert.equal(
    listTables(inspection).some((name) => /^(sessions?|messages?|session_events)$/u.test(name)),
    false,
  )

  const migration = inspection
    .prepare(
      `SELECT version, name, checksum, applied_at
       FROM twindesk_schema_migrations`,
    )
    .get()
  assert.ok(migration)
  assert.equal(migration.version, 1)
  assert.equal(migration.name, 'initial_business_schema')
  const { checksum, applied_at: appliedAt } = migration
  if (typeof checksum !== 'string' || typeof appliedAt !== 'string') {
    throw new TypeError('Migration metadata must contain string values.')
  }
  assert.match(checksum, /^[a-f0-9]{64}$/u)
  assert.match(appliedAt, /^\d{4}-\d{2}-\d{2}T/u)
})

test('restart preserves business data without reapplying migration history', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()

  const writer = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  assert.throws(() =>
    writer
      .prepare(
        `INSERT INTO external_events (
           kind, schema_version, id, idempotency_key, connector_id, account_id,
           object_type, external_id, event_type, occurred_at, received_at,
           context_status, normalized_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'external_event',
        1,
        'invalid-event',
        'fixture:invalid',
        'fixture',
        'synthetic-account',
        'message',
        'invalid-message',
        'message.received',
        '2026-08-26T08:00:00Z',
        '2026-08-26T08:00:00Z',
        'complete',
        JSON.stringify(['not', 'an', 'object']),
      ),
  )
  writer
    .prepare(
      `INSERT INTO external_events (
         kind, schema_version, id, idempotency_key, connector_id, account_id,
         object_type, external_id, source_timestamp, event_type, occurred_at,
         received_at, context_status, context_missing_json, normalized_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'external_event',
      1,
      'synthetic-event-1',
      'fixture:account:message:1:v1',
      'fixture',
      'synthetic-account',
      'message',
      'synthetic-message-1',
      '2026-08-26T08:00:00Z',
      'message.received',
      '2026-08-26T08:00:00Z',
      '2026-08-26T08:00:00.100Z',
      'complete',
      null,
      JSON.stringify({ text: 'Synthetic fixture' }),
    )
  assert.throws(
    () =>
      writer
        .prepare(`UPDATE external_events SET normalized_json = '{}' WHERE id = ?`)
        .run('synthetic-event-1'),
    /external events are immutable/u,
  )
  writer.close()

  openTwinDeskDatabase(path).close()
  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  const eventCount = inspection.prepare('SELECT count(*) AS count FROM external_events').get()
  const migrationCount = inspection
    .prepare('SELECT count(*) AS count FROM twindesk_schema_migrations')
    .get()
  assert.ok(eventCount)
  assert.ok(migrationCount)
  assert.equal(eventCount.count, 1)
  assert.equal(migrationCount.count, 1)
})

test('opening an unowned SQLite database fails closed without changing it', async (context) => {
  const path = await temporaryDatabase(context)
  const foreign = new DatabaseSync(path)
  foreign.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY) STRICT')
  const originalJournalMode = foreign.prepare('PRAGMA journal_mode').get()?.journal_mode
  foreign.close()

  assert.throws(
    () => openTwinDeskDatabase(path),
    (error) => {
      assert.ok(error instanceof StorageSchemaError)
      assert.equal(error.code, 'foreign_database')
      assert.equal(error.message.includes(path), false)
      return true
    },
  )

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(listTables(inspection), ['sessions'])
  assert.equal(inspection.prepare('PRAGMA journal_mode').get()?.journal_mode, originalJournalMode)
  assert.equal(readNumberPragma(inspection, 'application_id'), 0)
  assert.equal(readNumberPragma(inspection, 'user_version'), 0)
})

test('a database from a newer TwinDesk build is rejected rather than downgraded', async (context) => {
  const path = await temporaryDatabase(context)
  const future = new DatabaseSync(path)
  future.exec(`PRAGMA application_id = ${TWIN_DESK_SQLITE_APPLICATION_ID}`)
  future.exec(`PRAGMA user_version = ${LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION + 1}`)
  future.close()

  assert.throws(
    () => openTwinDeskDatabase(path),
    (error) => {
      assert.ok(error instanceof StorageSchemaError)
      assert.equal(error.code, 'unsupported_schema_version')
      assert.equal(error.currentVersion, 2)
      assert.equal(error.targetVersion, 1)
      return true
    },
  )
})

test('migration history tampering is detected before the database is used', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()
  const tamper = new DatabaseSync(path)
  tamper.exec(`UPDATE twindesk_schema_migrations SET checksum = '${'0'.repeat(64)}'`)
  tamper.close()

  assert.throws(
    () => openTwinDeskDatabase(path),
    (error) => {
      assert.ok(error instanceof StorageSchemaError)
      assert.equal(error.code, 'migration_history_mismatch')
      return true
    },
  )
})

test('a failed migration rolls back all changes and leaves the version unchanged', async (context) => {
  const path = await temporaryDatabase(context)
  const interrupted = new DatabaseSync(path)
  interrupted.exec(`PRAGMA application_id = ${TWIN_DESK_SQLITE_APPLICATION_ID}`)
  interrupted.exec('CREATE TABLE external_events (id TEXT PRIMARY KEY) STRICT')
  interrupted.close()

  assert.throws(
    () => openTwinDeskDatabase(path),
    (error) => {
      assert.ok(error instanceof StorageSchemaError)
      assert.equal(error.code, 'migration_failed')
      assert.equal(error.currentVersion, 0)
      assert.equal(error.targetVersion, 1)
      return true
    },
  )

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(listTables(inspection), ['external_events'])
  assert.equal(readNumberPragma(inspection, 'user_version'), 0)
  assert.equal(readNumberPragma(inspection, 'application_id'), TWIN_DESK_SQLITE_APPLICATION_ID)
})

test('open options reject unsafe timeout values before creating a database', async (context) => {
  const path = await temporaryDatabase(context)
  assert.throws(() => openTwinDeskDatabase(path, { timeoutMs: -1 }), /timeoutMs/u)
  assert.throws(() => openTwinDeskDatabase('', { timeoutMs: 1 }), /path/u)
})
