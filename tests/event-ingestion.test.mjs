import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseExternalEvent } from '../packages/domain/dist/index.js'
import { EventIngestionError, openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} SourceExternalEvent */

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-ingestion-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

/**
 * @param {{
 *   id: string,
 *   idempotencyKey: string,
 *   occurredAt: string,
 *   receivedAt?: string,
 *   externalId?: string,
 *   normalized?: import('../packages/domain/src/model.ts').JsonObject,
 *   context?: { status: 'complete' } | { status: 'partial', missing: string[] }
 * }} values
 */
function event(values) {
  const parsed = parseExternalEvent({
    kind: 'external_event',
    schemaVersion: 1,
    id: values.id,
    idempotencyKey: values.idempotencyKey,
    source: {
      connectorId: 'fixture',
      accountId: 'synthetic-account',
      objectType: 'message',
      externalId: values.externalId ?? values.id,
      sourceTimestamp: values.occurredAt,
    },
    eventType: 'message.received',
    occurredAt: values.occurredAt,
    receivedAt: values.receivedAt ?? values.occurredAt,
    context: values.context ?? { status: 'complete' },
    normalized: values.normalized ?? { text: 'Synthetic fixture' },
  })
  return /** @type {SourceExternalEvent} */ (/** @type {unknown} */ (parsed))
}

/** @param {DatabaseSync} database */
function eventCount(database) {
  const row = database.prepare('SELECT count(*) AS count FROM external_events').get()
  assert.ok(row)
  assert.equal(typeof row.count, 'number')
  return row.count
}

test('duplicates, out-of-order events, and restart replay are idempotent', async (context) => {
  const path = await temporaryDatabase(context)
  const newer = event({
    id: 'event-newer',
    idempotencyKey: 'fixture:message:newer:v1',
    occurredAt: '2026-08-26T08:02:00Z',
    normalized: { zebra: 2, nested: { beta: true, alpha: 'x' } },
    context: { status: 'partial', missing: ['jira', 'thread history'] },
  })
  const older = event({
    id: 'event-older',
    idempotencyKey: 'fixture:message:older:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })

  const database = openTwinDeskDatabase(path)
  const first = database.ingestExternalEvents([newer, older, newer])
  assert.equal(first.insertedCount, 2)
  assert.equal(first.duplicateCount, 1)
  assert.deepEqual(
    first.items.map(({ disposition }) => disposition),
    ['inserted', 'inserted', 'duplicate'],
  )
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.items), true)
  database.close()

  const reorderedNewer = event({
    id: 'event-newer',
    idempotencyKey: 'fixture:message:newer:v1',
    occurredAt: '2026-08-26T08:02:00Z',
    receivedAt: '2026-08-26T08:03:00Z',
    normalized: { nested: { alpha: 'x', beta: true }, zebra: 2 },
    context: { status: 'partial', missing: ['thread history', 'jira'] },
  })
  const restarted = openTwinDeskDatabase(path)
  const replay = restarted.ingestExternalEvents([reorderedNewer, older])
  assert.equal(replay.insertedCount, 0)
  assert.equal(replay.duplicateCount, 2)
  restarted.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(eventCount(inspection), 2)
  assert.deepEqual(
    inspection
      .prepare('SELECT id FROM external_events ORDER BY julianday(occurred_at), id')
      .all()
      .map(({ id }) => id),
    ['event-older', 'event-newer'],
  )
  const stored = inspection
    .prepare('SELECT normalized_json, received_at FROM external_events WHERE id = ?')
    .get('event-newer')
  assert.ok(stored)
  assert.equal(stored.normalized_json, '{"nested":{"alpha":"x","beta":true},"zebra":2}')
  assert.equal(stored.received_at, '2026-08-26T08:02:00Z')
})

test('an idempotency conflict rolls back the entire batch without echoing content', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const original = event({
    id: 'event-original',
    idempotencyKey: 'fixture:message:stable:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  database.ingestExternalEvents([original])

  const precedingNewEvent = event({
    id: 'event-preceding',
    idempotencyKey: 'fixture:message:preceding:v1',
    occurredAt: '2026-08-26T08:01:00Z',
  })
  const sensitiveMarker = 'synthetic-private-marker'
  const conflictingKey = event({
    id: 'event-conflict',
    idempotencyKey: original.idempotencyKey,
    occurredAt: '2026-08-26T08:02:00Z',
    normalized: { text: sensitiveMarker },
  })
  assert.throws(
    () => database.ingestExternalEvents([precedingNewEvent, conflictingKey]),
    (error) => {
      assert.ok(error instanceof EventIngestionError)
      assert.equal(error.code, 'idempotency_conflict')
      assert.equal(error.inputIndex, 1)
      assert.equal(error.conflictKey, 'idempotency_key')
      assert.equal(error.message.includes(sensitiveMarker), false)
      assert.equal(error.message.includes(original.idempotencyKey), false)
      return true
    },
  )

  const conflictingId = event({
    id: original.id,
    idempotencyKey: 'fixture:message:different:v1',
    occurredAt: original.occurredAt,
  })
  assert.throws(
    () => database.ingestExternalEvents([conflictingId]),
    (error) => {
      assert.ok(error instanceof EventIngestionError)
      assert.equal(error.code, 'idempotency_conflict')
      assert.equal(error.conflictKey, 'id')
      return true
    },
  )
  const conflictingContent = event({
    id: original.id,
    idempotencyKey: original.idempotencyKey,
    occurredAt: original.occurredAt,
    normalized: { text: 'Different synthetic content' },
  })
  assert.throws(
    () => database.ingestExternalEvents([conflictingContent]),
    (error) => {
      assert.ok(error instanceof EventIngestionError)
      assert.equal(error.code, 'idempotency_conflict')
      assert.equal(error.conflictKey, 'both')
      return true
    },
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(eventCount(inspection), 1)
  assert.equal(
    inspection
      .prepare('SELECT count(*) AS count FROM external_events WHERE id = ?')
      .get('event-preceding')?.count,
    0,
  )
})

test('runtime validation happens before a batch starts and a closed handle fails safely', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const valid = event({
    id: 'event-valid',
    idempotencyKey: 'fixture:message:valid:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  /** @type {any} */
  const malformed = { ...valid, receivedAt: '2026-08-26T07:59:00Z' }
  assert.throws(
    () => database.ingestExternalEvents([valid, malformed]),
    /receivedAt must not be earlier/u,
  )
  database.close()
  assert.throws(
    () => database.ingestExternalEvents([valid]),
    (error) => {
      assert.ok(error instanceof EventIngestionError)
      assert.equal(error.code, 'database_closed')
      return true
    },
  )

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(eventCount(inspection), 0)
})

test('an interrupted SQLite write returns a typed error and rolls back earlier items', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()
  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_ingestion_failure
    BEFORE INSERT ON external_events
    WHEN NEW.id = 'event-fail'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic write interruption');
    END;
  `)
  faultInjector.close()

  const database = openTwinDeskDatabase(path)
  const preceding = event({
    id: 'event-before-failure',
    idempotencyKey: 'fixture:message:before-failure:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  const failing = event({
    id: 'event-fail',
    idempotencyKey: 'fixture:message:failure:v1',
    occurredAt: '2026-08-26T08:01:00Z',
  })
  assert.throws(
    () => database.ingestExternalEvents([preceding, failing]),
    (error) => {
      assert.ok(error instanceof EventIngestionError)
      assert.equal(error.code, 'write_failed')
      assert.equal(error.inputIndex, 1)
      assert.equal(error.message.includes('synthetic write interruption'), false)
      return true
    },
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(eventCount(inspection), 0)
})
