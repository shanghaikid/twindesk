import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
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
  'work_item_projection_base_events',
  'work_item_projection_bases',
  'work_item_user_actions',
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
  assert.equal(database.schemaVersion, LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION)
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

  const migrations = inspection
    .prepare(
      `SELECT version, name, checksum, applied_at
       FROM twindesk_schema_migrations ORDER BY version`,
    )
    .all()
  assert.deepEqual(
    migrations.map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: 'initial_business_schema' },
      { version: 2, name: 'work_item_projection_inputs' },
    ],
  )
  for (const { checksum, applied_at: appliedAt } of migrations) {
    if (typeof checksum !== 'string' || typeof appliedAt !== 'string') {
      throw new TypeError('Migration metadata must contain string values.')
    }
    assert.match(checksum, /^[a-f0-9]{64}$/u)
    assert.match(appliedAt, /^\d{4}-\d{2}-\d{2}T/u)
  }
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
  assert.equal(migrationCount.count, LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION)
})

test('version 2 forward migration backfills existing Work Item projection bases', async (context) => {
  const path = await temporaryDatabase(context)
  const legacy = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  const initialMigration = SQLITE_MIGRATIONS[0]
  assert.ok(initialMigration)
  legacy.exec('BEGIN IMMEDIATE')
  legacy.exec(initialMigration.sql)
  legacy
    .prepare(
      `INSERT INTO twindesk_schema_migrations (version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      initialMigration.version,
      initialMigration.name,
      createHash('sha256').update(initialMigration.sql, 'utf8').digest('hex'),
      '2026-08-26T08:00:00Z',
    )
  legacy.exec(`PRAGMA application_id = ${TWIN_DESK_SQLITE_APPLICATION_ID}`)
  legacy.exec('PRAGMA user_version = 1')
  legacy.exec('COMMIT')
  legacy.exec(`
    INSERT INTO external_events (
      kind, schema_version, id, idempotency_key, connector_id, account_id,
      object_type, external_id, source_timestamp, event_type, occurred_at,
      received_at, context_status, normalized_json
    ) VALUES (
      'external_event', 1, 'legacy-event', 'fixture:legacy:v1', 'fixture',
      'synthetic-account', 'message', 'legacy-message', '2026-08-26T08:00:00Z',
      'message.received', '2026-08-26T08:00:00Z', '2026-08-26T08:00:00Z',
      'complete', '{"text":"Synthetic legacy fixture"}'
    );
    INSERT INTO external_threads (
      kind, schema_version, id, subject, created_at, updated_at
    ) VALUES (
      'external_thread', 1, 'legacy-thread', 'Synthetic legacy thread',
      '2026-08-26T08:00:00Z', '2026-08-26T08:00:00Z'
    );
    INSERT INTO thread_external_references (
      thread_id, ordinal, connector_id, account_id, object_type, external_id, source_timestamp
    ) VALUES (
      'legacy-thread', 0, 'fixture', 'synthetic-account', 'message', 'legacy-message',
      '2026-08-26T08:00:00Z'
    );
    INSERT INTO thread_events (thread_id, event_id, ordinal)
    VALUES ('legacy-thread', 'legacy-event', 0);
    INSERT INTO work_items (
      kind, schema_version, id, thread_id, inbox_state, title, summary,
      attention_reason, created_at, updated_at
    ) VALUES (
      'work_item', 1, 'legacy-work-item', 'legacy-thread', 'needs_review',
      'Review synthetic legacy item', 'Synthetic legacy summary',
      'Synthetic migration verification', '2026-08-26T08:00:00Z',
      '2026-08-26T08:00:00Z'
    );
    INSERT INTO work_item_events (work_item_id, event_id, ordinal)
    VALUES ('legacy-work-item', 'legacy-event', 0);
  `)
  legacy.close()

  const upgraded = openTwinDeskDatabase(path)
  assert.equal(upgraded.schemaVersion, 2)
  const page = upgraded.queryInbox({ states: ['needs_review'] })
  assert.equal(page.items.length, 1)
  const migrated = page.items[0]
  assert.ok(migrated)
  const rebuilt = upgraded.rebuildWorkItemProjection(migrated.id)
  assert.equal(rebuilt.title, 'Review synthetic legacy item')
  assert.deepEqual(rebuilt.sourceEventIds, ['legacy-event'])
  upgraded.close()
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
      assert.equal(error.currentVersion, LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION + 1)
      assert.equal(error.targetVersion, LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION)
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
