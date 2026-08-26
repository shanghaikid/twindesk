import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseConnectorCursor, parseExternalEvent } from '../packages/domain/dist/index.js'
import {
  EventIngestionError,
  SyncCursorError,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ConnectorCursor} SourceCursor */
/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} SourceExternalEvent */

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-cursor-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

/**
 * @param {{
 *   id: string,
 *   idempotencyKey: string,
 *   occurredAt: string,
 *   connectorId?: string,
 *   accountId?: string,
 *   normalized?: import('../packages/domain/src/model.ts').JsonObject
 * }} values
 * @returns {SourceExternalEvent}
 */
function event(values) {
  const connectorId = values.connectorId ?? 'fixture'
  const accountId = values.accountId ?? 'synthetic-account'
  const parsed = parseExternalEvent({
    kind: 'external_event',
    schemaVersion: 1,
    id: values.id,
    idempotencyKey: values.idempotencyKey,
    source: {
      connectorId,
      accountId,
      objectType: 'message',
      externalId: values.id,
      sourceTimestamp: values.occurredAt,
    },
    eventType: 'message.received',
    occurredAt: values.occurredAt,
    receivedAt: values.occurredAt,
    context: { status: 'complete' },
    normalized: values.normalized ?? { text: 'Synthetic fixture' },
  })
  return /** @type {SourceExternalEvent} */ (/** @type {unknown} */ (parsed))
}

/**
 * @param {{
 *   id?: string,
 *   position: string,
 *   updatedAt: string,
 *   committedThrough?: string,
 *   connectorId?: string,
 *   accountId?: string,
 *   stream?: string
 * }} values
 * @returns {SourceCursor}
 */
function cursor(values) {
  const parsed = parseConnectorCursor({
    kind: 'connector_cursor',
    schemaVersion: 1,
    id: values.id ?? 'cursor-fixture-inbox',
    connectorId: values.connectorId ?? 'fixture',
    accountId: values.accountId ?? 'synthetic-account',
    stream: values.stream ?? 'inbox',
    position: values.position,
    ...(values.committedThrough === undefined ? {} : { committedThrough: values.committedThrough }),
    updatedAt: values.updatedAt,
  })
  return /** @type {SourceCursor} */ (/** @type {unknown} */ (parsed))
}

const key = Object.freeze({
  connectorId: 'fixture',
  accountId: 'synthetic-account',
  stream: 'inbox',
})

/** @param {DatabaseSync} database */
function counts(database) {
  const eventRow = database.prepare('SELECT count(*) AS count FROM external_events').get()
  const cursorRow = database.prepare('SELECT count(*) AS count FROM connector_cursors').get()
  assert.ok(eventRow)
  assert.ok(cursorRow)
  return { events: eventRow.count, cursors: cursorRow.count }
}

test('events and a candidate cursor commit atomically and resume after restart', async (context) => {
  const path = await temporaryDatabase(context)
  const older = event({
    id: 'event-older',
    idempotencyKey: 'fixture:older:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  const newer = event({
    id: 'event-newer',
    idempotencyKey: 'fixture:newer:v1',
    occurredAt: '2026-08-26T08:02:00Z',
  })
  const firstCursor = cursor({
    position: 'page-1',
    committedThrough: '2026-08-26T08:02:00Z',
    updatedAt: '2026-08-26T08:03:00Z',
  })

  const database = openTwinDeskDatabase(path)
  assert.equal(database.getConnectorCursor(key), undefined)
  const first = database.commitConnectorSyncBatch({
    ...key,
    events: [newer, older],
    candidateCursor: firstCursor,
  })
  assert.equal(first.ingestion.insertedCount, 2)
  assert.equal(first.cursor.disposition, 'inserted')
  assert.equal(Object.isFrozen(first), true)
  database.close()

  const restarted = openTwinDeskDatabase(path)
  const recovered = restarted.getConnectorCursor(key)
  assert.ok(recovered)
  assert.equal(recovered.position, 'page-1')
  assert.equal(Object.isFrozen(recovered), true)

  const replayCursor = cursor({
    position: 'page-1',
    committedThrough: '2026-08-26T08:02:00Z',
    updatedAt: '2026-08-26T08:04:00Z',
  })
  const replay = restarted.commitConnectorSyncBatch({
    ...key,
    events: [newer, older],
    candidateCursor: replayCursor,
  })
  assert.equal(replay.ingestion.duplicateCount, 2)
  assert.equal(replay.cursor.disposition, 'unchanged')
  assert.equal(restarted.getConnectorCursor(key)?.updatedAt, '2026-08-26T08:03:00Z')

  const nextCursor = cursor({
    position: 'page-2',
    committedThrough: '2026-08-26T08:04:00Z',
    updatedAt: '2026-08-26T08:05:00Z',
  })
  const emptyAdvance = restarted.commitConnectorSyncBatch({
    ...key,
    events: [],
    candidateCursor: nextCursor,
  })
  assert.equal(emptyAdvance.ingestion.insertedCount, 0)
  assert.equal(emptyAdvance.cursor.disposition, 'advanced')
  restarted.close()

  const secondRestart = openTwinDeskDatabase(path)
  assert.equal(secondRestart.getConnectorCursor(key)?.position, 'page-2')
  const withoutCandidate = secondRestart.commitConnectorSyncBatch({
    ...key,
    events: [
      event({
        id: 'event-without-cursor',
        idempotencyKey: 'fixture:without-cursor:v1',
        occurredAt: '2026-08-26T08:05:00Z',
      }),
    ],
  })
  assert.equal(withoutCandidate.cursor.disposition, 'not_provided')
  assert.equal(secondRestart.getConnectorCursor(key)?.position, 'page-2')
  secondRestart.close()
})

test('identity mismatches and accessor requests fail before any transaction starts', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const validEvent = event({
    id: 'event-valid',
    idempotencyKey: 'fixture:valid:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  const wrongCursor = cursor({
    position: 'wrong',
    connectorId: 'different-connector',
    updatedAt: '2026-08-26T08:01:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [validEvent],
        candidateCursor: wrongCursor,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'identity_mismatch')
      assert.equal(error.mismatch, 'cursor_connector')
      return true
    },
  )

  for (const mismatchCase of [
    {
      mismatch: 'cursor_account',
      candidateCursor: cursor({
        position: 'wrong-account',
        accountId: 'different-account',
        updatedAt: '2026-08-26T08:01:00Z',
      }),
    },
    {
      mismatch: 'cursor_stream',
      candidateCursor: cursor({
        position: 'wrong-stream',
        stream: 'different-stream',
        updatedAt: '2026-08-26T08:01:00Z',
      }),
    },
  ]) {
    assert.throws(
      () =>
        database.commitConnectorSyncBatch({
          ...key,
          events: [],
          candidateCursor: mismatchCase.candidateCursor,
        }),
      (error) => {
        assert.ok(error instanceof SyncCursorError)
        assert.equal(error.code, 'identity_mismatch')
        assert.equal(error.mismatch, mismatchCase.mismatch)
        return true
      },
    )
  }

  const wrongAccountEvent = event({
    id: 'event-wrong-account',
    idempotencyKey: 'fixture:wrong-account:v1',
    occurredAt: '2026-08-26T08:00:00Z',
    accountId: 'different-account',
  })
  assert.throws(
    () => database.commitConnectorSyncBatch({ ...key, events: [wrongAccountEvent] }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'identity_mismatch')
      assert.equal(error.inputIndex, 0)
      assert.equal(error.mismatch, 'event_account')
      return true
    },
  )

  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [
          event({
            id: 'event-wrong-connector',
            idempotencyKey: 'fixture:wrong-connector:v1',
            occurredAt: '2026-08-26T08:00:00Z',
            connectorId: 'different-connector',
          }),
        ],
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'identity_mismatch')
      assert.equal(error.inputIndex, 0)
      assert.equal(error.mismatch, 'event_connector')
      return true
    },
  )

  let accessorRead = false
  const accessorRequest = {
    accountId: key.accountId,
    stream: key.stream,
    events: [validEvent],
  }
  Object.defineProperty(accessorRequest, 'connectorId', {
    enumerable: true,
    get() {
      accessorRead = true
      return key.connectorId
    },
  })
  assert.throws(
    // @ts-expect-error runtime boundary test
    () => database.commitConnectorSyncBatch(accessorRequest),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'invalid_request')
      return true
    },
  )
  assert.equal(accessorRead, false)

  const symbolRequest = { ...key, events: [] }
  Object.defineProperty(symbolRequest, Symbol('unsupported'), { value: true })
  assert.throws(
    () => database.commitConnectorSyncBatch(symbolRequest),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'invalid_request')
      return true
    },
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(counts(inspection), { events: 0, cursors: 0 })
})

test('event conflicts, cursor conflicts, and cursor regressions never advance state', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const original = event({
    id: 'event-original',
    idempotencyKey: 'fixture:stable:v1',
    occurredAt: '2026-08-26T08:00:00Z',
  })
  const durableCursor = cursor({
    position: 'page-1',
    committedThrough: '2026-08-26T08:00:00Z',
    updatedAt: '2026-08-26T08:01:00Z',
  })
  database.commitConnectorSyncBatch({
    ...key,
    events: [original],
    candidateCursor: durableCursor,
  })

  const conflictingEvent = event({
    id: 'event-conflict',
    idempotencyKey: original.idempotencyKey,
    occurredAt: '2026-08-26T08:02:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [
          event({
            id: 'event-before-conflict',
            idempotencyKey: 'fixture:before-conflict:v1',
            occurredAt: '2026-08-26T08:01:00Z',
          }),
          conflictingEvent,
        ],
        candidateCursor: cursor({
          position: 'page-2',
          committedThrough: '2026-08-26T08:02:00Z',
          updatedAt: '2026-08-26T08:03:00Z',
        }),
      }),
    EventIngestionError,
  )
  assert.equal(database.getConnectorCursor(key)?.position, 'page-1')

  const conflictingCursorId = cursor({
    id: 'different-cursor-id',
    position: 'page-2',
    committedThrough: '2026-08-26T08:02:00Z',
    updatedAt: '2026-08-26T08:03:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [
          event({
            id: 'event-before-cursor-conflict',
            idempotencyKey: 'fixture:before-cursor-conflict:v1',
            occurredAt: '2026-08-26T08:02:00Z',
          }),
        ],
        candidateCursor: conflictingCursorId,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'cursor_conflict')
      return true
    },
  )

  const reboundKey = { ...key, stream: 'other-stream' }
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...reboundKey,
        events: [],
        candidateCursor: cursor({
          position: 'other-stream-page',
          stream: reboundKey.stream,
          updatedAt: '2026-08-26T08:03:00Z',
        }),
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'cursor_conflict')
      return true
    },
  )

  const olderTimestampCursor = cursor({
    position: 'newer-page-with-old-timestamp',
    committedThrough: '2026-08-26T08:01:00Z',
    updatedAt: '2026-08-26T08:00:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [],
        candidateCursor: olderTimestampCursor,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'cursor_regression')
      return true
    },
  )

  const removedWatermarkCursor = cursor({
    position: 'page-without-watermark',
    updatedAt: '2026-08-26T08:04:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [],
        candidateCursor: removedWatermarkCursor,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'cursor_regression')
      return true
    },
  )

  const regressingCursor = cursor({
    position: 'older-page',
    committedThrough: '2026-08-26T07:59:00Z',
    updatedAt: '2026-08-26T08:04:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [
          event({
            id: 'event-before-regression',
            idempotencyKey: 'fixture:before-regression:v1',
            occurredAt: '2026-08-26T08:03:00Z',
          }),
        ],
        candidateCursor: regressingCursor,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'cursor_regression')
      return true
    },
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(counts(inspection), { events: 1, cursors: 1 })
})

test('a cursor write interruption rolls back events and closed handles fail safely', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()
  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_cursor_failure
    BEFORE INSERT ON connector_cursors
    WHEN NEW.position = 'fail-position'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic cursor interruption');
    END;
  `)
  faultInjector.close()

  const database = openTwinDeskDatabase(path)
  const failingCursor = cursor({
    position: 'fail-position',
    updatedAt: '2026-08-26T08:01:00Z',
  })
  assert.throws(
    () =>
      database.commitConnectorSyncBatch({
        ...key,
        events: [
          event({
            id: 'event-before-cursor-failure',
            idempotencyKey: 'fixture:before-cursor-failure:v1',
            occurredAt: '2026-08-26T08:00:00Z',
          }),
        ],
        candidateCursor: failingCursor,
      }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic cursor interruption'), false)
      return true
    },
  )
  database.close()
  assert.throws(
    () => database.getConnectorCursor(key),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'database_closed')
      return true
    },
  )
  assert.throws(
    () => database.commitConnectorSyncBatch({ ...key, events: [] }),
    (error) => {
      assert.ok(error instanceof SyncCursorError)
      assert.equal(error.code, 'database_closed')
      return true
    },
  )

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.deepEqual(counts(inspection), { events: 0, cursors: 0 })
})
