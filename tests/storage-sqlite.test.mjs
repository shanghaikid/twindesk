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
  'action_dispatches',
  'action_proposal_creation_records',
  'action_proposal_state_transitions',
  'action_proposals',
  'action_receipts',
  'approval_records',
  'audit_records',
  'audit_references',
  'connector_cursors',
  'connector_maintenance_operations',
  'draft_creation_records',
  'draft_state_transitions',
  'drafts',
  'external_events',
  'external_threads',
  'thread_deletion_receipts',
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
      { version: 3, name: 'local_draft_action_transitions' },
      { version: 4, name: 'local_audit_timeline' },
      { version: 5, name: 'thread_deletion_receipts' },
      { version: 6, name: 'action_dispatch_journal' },
      { version: 7, name: 'connector_audit_references' },
      { version: 8, name: 'connector_maintenance_audit' },
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

test('forward migrations backfill existing Work Item projection bases', async (context) => {
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
    INSERT INTO drafts (
      kind, schema_version, id, work_item_id, persona_id, revision, state,
      media_type, content_text, created_at, updated_at
    ) VALUES (
      'draft', 1, 'legacy-draft', 'legacy-work-item', 'communication', 1,
      'ready_for_review', 'text/plain', 'Synthetic legacy draft.',
      '2026-08-26T08:01:00Z', '2026-08-26T08:01:00Z'
    );
    INSERT INTO action_proposals (
      kind, schema_version, id, work_item_id, draft_id, action_type, risk,
      identity_connector_id, identity_account_id, identity_type, identity_display_name,
      target_connector_id, target_account_id, target_object_type, target_external_id,
      target_source_timestamp, media_type, content_text, content_digest, idempotency_key,
      state, created_at, updated_at
    ) VALUES (
      'action_proposal', 1, 'legacy-proposal', 'legacy-work-item', 'legacy-draft',
      'fixture.reply.preview', 'write', 'fixture', 'synthetic-account', 'user',
      'Synthetic User', 'fixture', 'synthetic-account', 'message', 'legacy-message',
      '2026-08-26T08:00:00Z', 'text/plain', 'Synthetic legacy draft.',
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'fixture:legacy:proposal:v1', 'proposed',
      '2026-08-26T08:02:00Z', '2026-08-26T08:02:00Z'
    );
  `)
  legacy.close()

  const upgraded = openTwinDeskDatabase(path)
  assert.equal(upgraded.schemaVersion, LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION)
  const page = upgraded.queryInbox({ states: ['needs_review'] })
  assert.equal(page.items.length, 1)
  const migrated = page.items[0]
  assert.ok(migrated)
  const rebuilt = upgraded.rebuildWorkItemProjection(migrated.id)
  assert.equal(rebuilt.title, 'Review synthetic legacy item')
  assert.deepEqual(rebuilt.sourceEventIds, ['legacy-event'])
  upgraded.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(
    {
      ...inspection
        .prepare(
          `SELECT kind, schema_version AS schemaVersion, initial_state AS initialState
           FROM draft_creation_records WHERE draft_id = 'legacy-draft'`,
        )
        .get(),
    },
    { kind: 'draft_creation_record', schemaVersion: 1, initialState: 'ready_for_review' },
  )
  assert.deepEqual(
    {
      ...inspection
        .prepare(
          `SELECT kind, schema_version AS schemaVersion, initial_state AS initialState
           FROM action_proposal_creation_records WHERE proposal_id = 'legacy-proposal'`,
        )
        .get(),
    },
    { kind: 'action_proposal_creation_record', schemaVersion: 1, initialState: 'proposed' },
  )
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

test('the Connector Audit migration rejects unknown pre-existing reference kinds', async (context) => {
  const path = await temporaryDatabase(context)
  const legacy = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  const legacyMigrations = SQLITE_MIGRATIONS.filter(({ version }) => version <= 6)
  for (const migration of legacyMigrations) {
    legacy.exec('BEGIN IMMEDIATE')
    legacy.exec(migration.sql)
    legacy
      .prepare(
        `INSERT INTO twindesk_schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        migration.version,
        migration.name,
        createHash('sha256').update(migration.sql, 'utf8').digest('hex'),
        '2026-08-26T08:00:00Z',
      )
    legacy.exec(`PRAGMA application_id = ${TWIN_DESK_SQLITE_APPLICATION_ID}`)
    legacy.exec(`PRAGMA user_version = ${migration.version}`)
    legacy.exec('COMMIT')
  }
  legacy.exec(`
    INSERT INTO audit_records (
      kind, schema_version, id, category, outcome, actor_type, summary,
      details_json, occurred_at
    ) VALUES (
      'audit_record', 1, 'legacy-unknown-reference-audit', 'system', 'success',
      'system', 'Synthetic legacy Audit record.', '{}', '2026-08-26T08:01:00Z'
    );
    INSERT INTO audit_references (
      audit_record_id, ordinal, reference_kind, reference_id
    ) VALUES (
      'legacy-unknown-reference-audit', 0, 'newer-build-reference', 'synthetic-reference'
    );
  `)
  legacy.close()

  assert.throws(
    () => openTwinDeskDatabase(path),
    (error) => {
      assert.ok(error instanceof StorageSchemaError)
      assert.equal(error.code, 'migration_failed')
      assert.equal(error.currentVersion, 6)
      assert.equal(error.targetVersion, 7)
      return true
    },
  )

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(readNumberPragma(inspection, 'user_version'), 6)
  assert.equal(
    inspection
      .prepare(
        `SELECT count(*) AS count FROM sqlite_schema
         WHERE name IN ('audit_reference_kind_migration_guard', 'audit_references_valid_kind')`,
      )
      .get()?.count,
    0,
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
