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
  createFixtureInboxService,
  createFixtureInboxServiceFromDatabase,
  FIXTURE_INBOX_STATES,
} from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} SourceWorkItemUserAction */
/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} SourceExternalEvent */
/** @typedef {import('../packages/domain/src/model.ts').ExternalThread} SourceExternalThread */
/** @typedef {import('../packages/domain/src/model.ts').WorkItem} SourceWorkItem */

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-fixture-inbox-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

test('the fixture Inbox seeds all four states through durable projections', async (context) => {
  const path = await temporaryDatabase(context)
  const service = createFixtureInboxService(path, { includeAudit: true })
  const snapshot = service.read()
  const audit = service.readAudit()

  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.fixture, true)
  assert.deepEqual(snapshot.counts, {
    needs_reply: 1,
    needs_review: 1,
    waiting: 1,
    done: 1,
  })
  assert.deepEqual(
    new Set(snapshot.items.map(({ inboxState }) => inboxState)),
    new Set(FIXTURE_INBOX_STATES),
  )
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.items), true)
  assert.equal(
    snapshot.items.every(({ source }) => source.label === 'Synthetic fixture'),
    true,
  )
  assert.equal(
    snapshot.items.some(({ context }) => context.status === 'partial'),
    true,
  )
  assert.equal(audit.version, 1)
  assert.equal(audit.fixture, true)
  assert.equal(audit.items.length, 4)
  assert.deepEqual(service.readDraftFlow(), {
    version: 1,
    fixture: true,
    complete: false,
    items: [],
  })
  assert.equal(
    audit.items.every(
      (item) =>
        item.actorLabel === 'TwinDesk' &&
        item.referenceKinds.includes('work_item') &&
        !Object.hasOwn(item, 'details') &&
        !Object.hasOwn(item, 'id'),
    ),
    true,
  )
  service.close()

  const database = openTwinDeskDatabase(path)
  const selectCustomPersona = /** @type {SourceWorkItemUserAction} */ (
    /** @type {unknown} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'fixture-action-select-custom-persona',
        workItemId: 'fixture-work-item-release-risk-question',
        revision: 1,
        action: 'select_persona',
        personaId: 'custom-persona',
        occurredAt: '2026-08-26T09:16:00Z',
      })
    )
  )
  database.applyWorkItemUserAction(selectCustomPersona)
  database.close()

  const restarted = createFixtureInboxService(path, { includeAudit: true })
  assert.deepEqual(restarted.read().counts, snapshot.counts)
  assert.deepEqual(restarted.readAudit(), audit)
  for (const state of FIXTURE_INBOX_STATES) {
    const filtered = restarted.read(state)
    assert.equal(filtered.items.length, 1)
    assert.equal(filtered.items[0]?.inboxState, state)
    assert.deepEqual(filtered.counts, snapshot.counts)
  }
  const selected = restarted.read('needs_reply').items[0]
  assert.equal(selected?.personaId, 'custom-persona')
  assert.equal(selected?.personaLabel, undefined)
  restarted.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM external_events').get()?.count, 4)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM work_items').get()?.count, 4)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 4)
})

test('the fixture Inbox closes explicitly and rejects invalid runtime state', () => {
  const service = createFixtureInboxService()
  assert.throws(
    // @ts-expect-error runtime boundary check
    () => service.read('unexpected'),
    /state is not supported/u,
  )
  service.close()
  service.close()
  assert.throws(() => service.read(), /service is closed/u)
  assert.throws(() => service.readAudit(), /service is closed/u)
  assert.throws(() => service.readDraftFlow(), /service is closed/u)
})

test('the fixture Inbox can share a caller-owned database without closing it', () => {
  const database = openTwinDeskDatabase(':memory:')
  const service = createFixtureInboxServiceFromDatabase(database, { includeAudit: true })
  assert.equal(service.read().items.length, 4)
  service.close()
  assert.equal(database.isOpen, true)
  assert.equal(database.queryAuditTimeline({ limit: 10 }).records.length, 4)
  database.close()
})

test('the shared Inbox includes durable non-fixture Feishu Work Items', () => {
  const database = openTwinDeskDatabase(':memory:')
  const timestamp = '2026-09-03T08:00:00.000Z'
  const source = {
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic',
    objectType: 'message',
    externalId: 'om_synthetic_external_message',
    sourceTimestamp: timestamp,
  }
  const event = /** @type {SourceExternalEvent} */ (
    /** @type {unknown} */ (
      parseExternalEvent({
        kind: 'external_event',
        schemaVersion: 1,
        id: 'feishu-event-shared-inbox',
        idempotencyKey: 'feishu:synthetic:shared-inbox:v1',
        source,
        eventType: 'message.received',
        occurredAt: timestamp,
        receivedAt: timestamp,
        context: { status: 'complete' },
        normalized: { text: 'Synthetic Feishu message for a local projection.' },
      })
    )
  )
  const thread = /** @type {SourceExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        kind: 'external_thread',
        schemaVersion: 1,
        id: 'feishu-thread-shared-inbox',
        subject: 'Synthetic Feishu thread',
        externalReferences: [source],
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
        id: 'feishu-work-item-shared-inbox',
        threadId: thread.id,
        sourceEventIds: [event.id],
        inboxState: 'needs_reply',
        title: 'Reply to the Feishu message',
        summary: 'A synthetic external message needs a reply.',
        attentionReason: 'The sender asked a direct question.',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    )
  )
  database.ingestExternalEvents([event])
  database.putWorkItemProjection({ thread, workItem })

  const service = createFixtureInboxServiceFromDatabase(database)
  const snapshot = service.read('needs_reply')
  const projected = snapshot.items.find(({ id }) => id === workItem.id)

  assert.equal(snapshot.counts.needs_reply, 2)
  assert.equal(projected?.source.label, 'Feishu')
  assert.deepEqual(projected?.context, {
    status: 'partial',
    missing: ['Context details are not projected in this Inbox view.'],
  })
  service.close()
  database.close()
})
