import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import {
  createFixtureInboxService,
  FIXTURE_INBOX_STATES,
} from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} SourceWorkItemUserAction */

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
})
