import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseExternalEvent,
  parseExternalThread,
  parseWorkItem,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'
import {
  WorkItemProjectionError,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} SourceExternalEvent */
/** @typedef {import('../packages/domain/src/model.ts').ExternalThread} SourceExternalThread */
/** @typedef {import('../packages/domain/src/model.ts').WorkItem} SourceWorkItem */
/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} SourceWorkItemUserAction */

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-work-item-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

/**
 * @param {string} suffix
 * @param {string} timestamp
 * @returns {{ event: SourceExternalEvent, thread: SourceExternalThread, workItem: SourceWorkItem }}
 */
function fixture(suffix, timestamp) {
  const reference = {
    connectorId: 'fixture',
    accountId: 'synthetic-account',
    objectType: 'message',
    externalId: `synthetic-message-${suffix}`,
    sourceTimestamp: timestamp,
  }
  const event = /** @type {SourceExternalEvent} */ (
    /** @type {unknown} */ (
      parseExternalEvent({
        kind: 'external_event',
        schemaVersion: 1,
        id: `event-${suffix}`,
        idempotencyKey: `fixture:message:${suffix}:v1`,
        source: reference,
        eventType: 'message.received',
        occurredAt: timestamp,
        receivedAt: timestamp,
        context: { status: 'complete' },
        normalized: { text: `Synthetic message ${suffix}` },
      })
    )
  )
  const thread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        kind: 'external_thread',
        schemaVersion: 1,
        id: `thread-${suffix}`,
        subject: `Synthetic thread ${suffix}`,
        externalReferences: [reference],
        sourceEventIds: [event.id],
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    )
  )
  const workItem = /** @type {SourceWorkItem} */ (
    /** @type {unknown} */ (
      parseWorkItem({
        kind: 'work_item',
        schemaVersion: 1,
        id: `work-item-${suffix}`,
        threadId: thread.id,
        sourceEventIds: [event.id],
        inboxState: 'needs_reply',
        title: `Reply to synthetic message ${suffix}`,
        summary: `Synthetic summary ${suffix}`,
        attentionReason: 'A synthetic direct message needs a reply.',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    )
  )
  return { event, thread, workItem }
}

/**
 * @param {{
 *   id: string,
 *   workItemId: string,
 *   revision: number,
 *   action: 'set_inbox_state' | 'select_persona' | 'clear_persona',
 *   occurredAt: string,
 *   inboxState?: 'needs_reply' | 'needs_review' | 'waiting' | 'done',
 *   personaId?: string
 * }} values
 * @returns {SourceWorkItemUserAction}
 */
function action(values) {
  return /** @type {SourceWorkItemUserAction} */ (
    /** @type {unknown} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: values.id,
        workItemId: values.workItemId,
        revision: values.revision,
        action: values.action,
        ...(values.inboxState === undefined ? {} : { inboxState: values.inboxState }),
        ...(values.personaId === undefined ? {} : { personaId: values.personaId }),
        occurredAt: values.occurredAt,
      })
    )
  )
}

test('a projection is idempotent, queryable, and durable across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const records = fixture('restart', '2026-08-26T08:00:00Z')
  const database = openTwinDeskDatabase(path)
  database.ingestExternalEvents([records.event])
  const inserted = database.putWorkItemProjection({
    thread: records.thread,
    workItem: records.workItem,
  })
  assert.equal(inserted.disposition, 'inserted')
  assert.equal(inserted.workItem.id, records.workItem.id)
  assert.equal(Object.isFrozen(inserted.workItem), true)
  const replay = database.putWorkItemProjection({
    thread: /** @type {SourceExternalThread} */ (
      /** @type {unknown} */ (
        parseExternalThread({
          updatedAt: records.thread.updatedAt,
          sourceEventIds: records.thread.sourceEventIds,
          externalReferences: records.thread.externalReferences.map((reference) => ({
            externalId: reference.externalId,
            objectType: reference.objectType,
            accountId: reference.accountId,
            connectorId: reference.connectorId,
            sourceTimestamp: reference.sourceTimestamp,
          })),
          createdAt: records.thread.createdAt,
          subject: records.thread.subject,
          id: records.thread.id,
          schemaVersion: records.thread.schemaVersion,
          kind: records.thread.kind,
        })
      )
    ),
    workItem: /** @type {SourceWorkItem} */ (
      /** @type {unknown} */ (
        parseWorkItem({
          updatedAt: records.workItem.updatedAt,
          createdAt: records.workItem.createdAt,
          attentionReason: records.workItem.attentionReason,
          summary: records.workItem.summary,
          title: records.workItem.title,
          inboxState: records.workItem.inboxState,
          sourceEventIds: records.workItem.sourceEventIds,
          threadId: records.workItem.threadId,
          id: records.workItem.id,
          schemaVersion: records.workItem.schemaVersion,
          kind: records.workItem.kind,
        })
      )
    ),
  })
  assert.equal(replay.disposition, 'unchanged')
  assert.equal(database.getWorkItem(records.workItem.id)?.title, records.workItem.title)
  database.close()

  const restarted = openTwinDeskDatabase(path)
  const page = restarted.queryInbox()
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [records.workItem.id],
  )
  assert.equal(Object.isFrozen(page), true)
  assert.equal(Object.isFrozen(page.items), true)
  restarted.close()
})

test('revisioned user actions survive restart and rebuild a damaged projection', async (context) => {
  const path = await temporaryDatabase(context)
  const records = fixture('actions', '2026-08-26T08:00:00Z')
  const database = openTwinDeskDatabase(path)
  database.ingestExternalEvents([records.event])
  database.putWorkItemProjection({ thread: records.thread, workItem: records.workItem })

  const waiting = action({
    id: 'action-actions-1',
    workItemId: records.workItem.id,
    revision: 1,
    action: 'set_inbox_state',
    inboxState: 'waiting',
    occurredAt: '2026-08-26T08:01:00Z',
  })
  const selected = action({
    id: 'action-actions-2',
    workItemId: records.workItem.id,
    revision: 2,
    action: 'select_persona',
    personaId: 'technical-lead',
    occurredAt: '2026-08-26T08:02:00Z',
  })
  assert.equal(database.applyWorkItemUserAction(waiting).workItem.inboxState, 'waiting')
  const selectedResult = database.applyWorkItemUserAction(selected)
  assert.equal(selectedResult.workItem.selectedPersonaId, 'technical-lead')
  assert.equal(database.applyWorkItemUserAction(selected).disposition, 'duplicate')
  assert.throws(
    () =>
      database.applyWorkItemUserAction(
        action({
          id: 'action-actions-conflict',
          workItemId: records.workItem.id,
          revision: 2,
          action: 'clear_persona',
          occurredAt: '2026-08-26T08:02:00Z',
        }),
      ),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'action_conflict')
      return true
    },
  )
  assert.throws(
    () =>
      database.applyWorkItemUserAction(
        action({
          id: selected.id,
          workItemId: records.workItem.id,
          revision: 3,
          action: 'clear_persona',
          occurredAt: '2026-08-26T08:03:00Z',
        }),
      ),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'action_conflict')
      return true
    },
  )
  database.close()

  const damage = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  damage
    .prepare(
      `UPDATE work_items
       SET inbox_state = 'done', title = 'Damaged synthetic projection', selected_persona_id = NULL
       WHERE id = ?`,
    )
    .run(records.workItem.id)
  damage.prepare(`DELETE FROM work_item_events WHERE work_item_id = ?`).run(records.workItem.id)
  assert.throws(
    () =>
      damage
        .prepare(`UPDATE work_item_user_actions SET action_type = 'clear_persona' WHERE id = ?`)
        .run(selected.id),
    /immutable/u,
  )
  damage.close()

  const restarted = openTwinDeskDatabase(path)
  const rebuilt = restarted.rebuildWorkItemProjection(records.workItem.id)
  assert.equal(rebuilt.inboxState, 'waiting')
  assert.equal(rebuilt.selectedPersonaId, 'technical-lead')
  assert.equal(rebuilt.title, records.workItem.title)
  assert.deepEqual(rebuilt.sourceEventIds, [records.event.id])
  restarted.close()
})

test('newer event-derived bases supersede older actions and retain source history', async (context) => {
  const path = await temporaryDatabase(context)
  const first = fixture('advance', '2026-08-26T08:00:00Z')
  const database = openTwinDeskDatabase(path)
  database.ingestExternalEvents([first.event])
  database.putWorkItemProjection({ thread: first.thread, workItem: first.workItem })
  database.applyWorkItemUserAction(
    action({
      id: 'action-advance-1',
      workItemId: first.workItem.id,
      revision: 1,
      action: 'set_inbox_state',
      inboxState: 'done',
      occurredAt: '2026-08-26T08:01:00Z',
    }),
  )

  const secondEvent = /** @type {SourceExternalEvent} */ (
    /** @type {unknown} */ (
      parseExternalEvent({
        ...first.event,
        id: 'event-advance-2',
        idempotencyKey: 'fixture:message:advance:v2',
        eventType: 'message.updated',
        occurredAt: '2026-08-26T08:02:00Z',
        receivedAt: '2026-08-26T08:02:00Z',
        normalized: { text: 'Synthetic follow-up' },
      })
    )
  )
  database.ingestExternalEvents([secondEvent])
  const advancedThread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        ...first.thread,
        sourceEventIds: [first.event.id, secondEvent.id],
        updatedAt: '2026-08-26T08:02:00Z',
      })
    )
  )
  const advancedWorkItem = /** @type {SourceWorkItem} */ (
    /** @type {unknown} */ (
      parseWorkItem({
        ...first.workItem,
        sourceEventIds: [first.event.id, secondEvent.id],
        inboxState: 'needs_reply',
        summary: 'A newer synthetic follow-up needs attention.',
        updatedAt: '2026-08-26T08:02:00Z',
      })
    )
  )
  const advanced = database.putWorkItemProjection({
    thread: advancedThread,
    workItem: advancedWorkItem,
  })
  assert.equal(advanced.disposition, 'updated')
  assert.equal(advanced.workItem.inboxState, 'needs_reply')
  assert.deepEqual(advanced.workItem.sourceEventIds, [first.event.id, secondEvent.id])

  const staleThread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({ ...advancedThread, sourceEventIds: [secondEvent.id] })
    )
  )
  const staleWorkItem = /** @type {SourceWorkItem} */ (
    /** @type {unknown} */ (
      parseWorkItem({ ...advancedWorkItem, sourceEventIds: [secondEvent.id] })
    )
  )
  assert.throws(
    () => database.putWorkItemProjection({ thread: staleThread, workItem: staleWorkItem }),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'stale_projection')
      return true
    },
  )
  assert.deepEqual(database.getWorkItem(first.workItem.id)?.sourceEventIds, [
    first.event.id,
    secondEvent.id,
  ])
  database.close()
})

test('missing sources and invalid action histories fail without partial state', async (context) => {
  const path = await temporaryDatabase(context)
  const records = fixture('failures', '2026-08-26T08:00:00Z')
  const database = openTwinDeskDatabase(path)
  assert.throws(
    () => database.putWorkItemProjection({ thread: records.thread, workItem: records.workItem }),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'missing_event')
      return true
    },
  )
  assert.equal(database.getWorkItem(records.workItem.id), undefined)

  database.ingestExternalEvents([records.event])
  const durableReference = records.thread.externalReferences[0]
  assert.ok(durableReference)
  const mismatchedThread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        ...records.thread,
        externalReferences: [{ ...durableReference, externalId: 'different-message' }],
      })
    )
  )
  assert.throws(
    () =>
      database.putWorkItemProjection({
        thread: mismatchedThread,
        workItem: records.workItem,
      }),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'source_mismatch')
      return true
    },
  )
  assert.equal(database.getWorkItem(records.workItem.id), undefined)
  const missingTimestampThread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        ...records.thread,
        externalReferences: [
          {
            connectorId: durableReference.connectorId,
            accountId: durableReference.accountId,
            objectType: durableReference.objectType,
            externalId: durableReference.externalId,
          },
        ],
      })
    )
  )
  assert.throws(
    () =>
      database.putWorkItemProjection({
        thread: missingTimestampThread,
        workItem: records.workItem,
      }),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'source_mismatch')
      return true
    },
  )
  assert.equal(database.getWorkItem(records.workItem.id), undefined)
  database.putWorkItemProjection({ thread: records.thread, workItem: records.workItem })
  const skippedRevision = action({
    id: 'action-failures-2',
    workItemId: records.workItem.id,
    revision: 2,
    action: 'set_inbox_state',
    inboxState: 'done',
    occurredAt: '2026-08-26T08:01:00Z',
  })
  assert.throws(
    () => database.applyWorkItemUserAction(skippedRevision),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'action_sequence')
      return true
    },
  )
  const beforeBase = action({
    id: 'action-failures-1',
    workItemId: records.workItem.id,
    revision: 1,
    action: 'set_inbox_state',
    inboxState: 'done',
    occurredAt: '2026-08-26T07:59:00Z',
  })
  assert.throws(
    () => database.applyWorkItemUserAction(beforeBase),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'action_chronology')
      return true
    },
  )
  assert.equal(database.getWorkItem(records.workItem.id)?.inboxState, 'needs_reply')
  database.close()
})

test('an interrupted projection write rolls back Thread and Work Item state together', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()
  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_projection_failure
    BEFORE INSERT ON work_item_projection_bases
    BEGIN
      SELECT RAISE(ABORT, 'synthetic projection interruption');
    END;
  `)
  faultInjector.close()

  const records = fixture('interrupted', '2026-08-26T08:00:00Z')
  const database = openTwinDeskDatabase(path)
  database.ingestExternalEvents([records.event])
  assert.throws(
    () => database.putWorkItemProjection({ thread: records.thread, workItem: records.workItem }),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic projection interruption'), false)
      return true
    },
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  const threadCount = inspection.prepare(`SELECT count(*) AS count FROM external_threads`).get()
  const baseCount = inspection
    .prepare(`SELECT count(*) AS count FROM work_item_projection_bases`)
    .get()
  const itemCount = inspection.prepare(`SELECT count(*) AS count FROM work_items`).get()
  assert.equal(threadCount?.count, 0)
  assert.equal(baseCount?.count, 0)
  assert.equal(itemCount?.count, 0)
})

test('Inbox queries use chronological keyset pagination and strict filters', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const fixtures = [
    fixture('whole-second', '2026-08-26T08:00:00Z'),
    fixture('ninety-ms', '2026-08-26T08:00:00.090Z'),
    fixture('hundred-ms', '2026-08-26T08:00:00.100Z'),
  ]
  for (const records of fixtures) {
    database.ingestExternalEvents([records.event])
    database.putWorkItemProjection({ thread: records.thread, workItem: records.workItem })
  }
  const firstPage = database.queryInbox({ states: ['needs_reply'], limit: 2 })
  assert.deepEqual(
    firstPage.items.map(({ id }) => id),
    ['work-item-hundred-ms', 'work-item-ninety-ms'],
  )
  assert.ok(firstPage.nextCursor)
  const secondPage = database.queryInbox({
    states: ['needs_reply'],
    limit: 2,
    after: firstPage.nextCursor,
  })
  assert.deepEqual(
    secondPage.items.map(({ id }) => id),
    ['work-item-whole-second'],
  )
  assert.equal(secondPage.nextCursor, undefined)
  assert.deepEqual(database.queryInbox({ states: ['done'] }).items, [])

  let accessorRead = false
  const query = { states: ['needs_reply'] }
  Object.defineProperty(query, 'limit', {
    enumerable: true,
    get() {
      accessorRead = true
      return 1
    },
  })
  assert.throws(
    // @ts-expect-error runtime boundary test
    () => database.queryInbox(query),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'invalid_request')
      return true
    },
  )
  assert.equal(accessorRead, false)
  database.close()
  assert.throws(
    () => database.queryInbox(),
    (error) => {
      assert.ok(error instanceof WorkItemProjectionError)
      assert.equal(error.code, 'database_closed')
      return true
    },
  )
})
