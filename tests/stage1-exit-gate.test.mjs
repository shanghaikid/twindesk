import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseDraftStateTransition,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'
import { FixtureStage1FlowError } from '../packages/plugin-work-hub/dist/fixture-stage1-flow.js'
import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryDatabase(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-${suffix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

test('fixture events complete Inbox → Persona → Draft → Audit across restart', async (context) => {
  const path = await temporaryDatabase(context, 'stage1-exit')
  const service = createFixtureInboxService(path, {
    includeAudit: true,
    includeDraftFlow: true,
  })
  const inbox = service.read()
  const flow = service.readDraftFlow()
  const audit = service.readAudit()

  assert.equal(inbox.items.length, 4)
  assert.deepEqual(flow.items.map(({ personaId }) => personaId).sort(), [
    'communication',
    'technical-lead',
  ])
  assert.equal(flow.version, 1)
  assert.equal(flow.fixture, true)
  assert.equal(flow.complete, true)
  assert.equal(flow.items.length, 2)
  assert.equal(new Set(flow.items.map(({ content }) => content.text)).size, 2)
  assert.equal(
    flow.items.every(
      (item) =>
        item.state === 'ready_for_review' &&
        item.autonomy === 'draft_only' &&
        item.authorityEffect === 'none' &&
        item.externalWritesAvailable === false,
    ),
    true,
  )
  assert.match(
    flow.items.find(({ personaId }) => personaId === 'technical-lead')?.content.text ?? '',
    /Context is partial/u,
  )
  const draftAudit = audit.items.filter(({ category }) => category === 'draft')
  assert.equal(audit.items.length, 6)
  assert.equal(draftAudit.length, 2)
  assert.equal(
    draftAudit.every(
      (item) =>
        item.actorType === 'persona' &&
        item.actorLabel === 'Persona' &&
        item.referenceKinds.includes('work_item') &&
        item.referenceKinds.includes('external_event') &&
        item.referenceKinds.includes('draft'),
    ),
    true,
  )
  assert.equal(Object.isFrozen(flow), true)
  assert.equal(Object.isFrozen(flow.items), true)
  service.close()

  const restarted = createFixtureInboxService(path, {
    includeAudit: true,
    includeDraftFlow: true,
  })
  assert.deepEqual(restarted.read(), inbox)
  assert.deepEqual(restarted.readDraftFlow(), flow)
  assert.deepEqual(restarted.readAudit(), audit)
  restarted.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM external_events`).get()?.count, 4)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM work_items`).get()?.count, 4)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 2)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM audit_records`).get()?.count, 6)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM action_proposals`).get()?.count, 0)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM approval_records`).get()?.count, 0)
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM action_receipts`).get()?.count, 0)
  inspection.close()
})

test('an interrupted Audit append repairs on restart without duplicate Drafts', async (context) => {
  const path = await temporaryDatabase(context, 'stage1-repair')
  createFixtureInboxService(path, { includeAudit: true }).close()
  const trigger = new DatabaseSync(path)
  trigger.exec(`
    CREATE TRIGGER interrupt_fixture_draft_audit
    BEFORE INSERT ON audit_records
    WHEN NEW.category = 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic fixture Audit interruption');
    END;
  `)
  trigger.close()

  assert.throws(
    () =>
      createFixtureInboxService(path, {
        includeAudit: true,
        includeDraftFlow: true,
      }),
    /audit batch could not be stored/u,
  )
  const partial = new DatabaseSync(path)
  assert.equal(partial.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 2)
  assert.equal(
    partial.prepare(`SELECT count(*) AS count FROM audit_records WHERE category = 'draft'`).get()
      ?.count,
    0,
  )
  partial.exec(`DROP TRIGGER interrupt_fixture_draft_audit`)
  partial.close()

  const repaired = createFixtureInboxService(path, {
    includeAudit: true,
    includeDraftFlow: true,
  })
  assert.equal(repaired.readDraftFlow().complete, true)
  assert.equal(repaired.readAudit().items.length, 6)
  repaired.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 2)
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM audit_records WHERE category = 'draft'`).get()
      ?.count,
    2,
  )
  inspection.close()
})

test('an interrupted Draft sequence resumes without duplicating the first Draft', async (context) => {
  const path = await temporaryDatabase(context, 'stage1-draft-repair')
  createFixtureInboxService(path).close()
  const trigger = new DatabaseSync(path)
  trigger.exec(`
    CREATE TRIGGER interrupt_second_fixture_draft
    BEFORE INSERT ON drafts
    WHEN NEW.id = 'fixture-draft-deployment-update-review'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic fixture Draft interruption');
    END;
  `)
  trigger.close()

  assert.throws(
    () => createFixtureInboxService(path, { includeDraftFlow: true }),
    /Draft could not be stored/u,
  )
  const partial = new DatabaseSync(path)
  assert.equal(partial.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 1)
  assert.equal(
    partial.prepare(`SELECT count(*) AS count FROM audit_records WHERE category = 'draft'`).get()
      ?.count,
    0,
  )
  partial.exec(`DROP TRIGGER interrupt_second_fixture_draft`)
  partial.close()

  const repaired = createFixtureInboxService(path, { includeDraftFlow: true })
  assert.equal(repaired.readDraftFlow().complete, true)
  assert.equal(repaired.readAudit().items.length, 2)
  repaired.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 2)
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM audit_records WHERE category = 'draft'`).get()
      ?.count,
    2,
  )
  inspection.close()
})

test('the fixture flow never overrides an explicit Persona change', async (context) => {
  const path = await temporaryDatabase(context, 'stage1-persona')
  createFixtureInboxService(path).close()
  const database = openTwinDeskDatabase(path)
  database.applyWorkItemUserAction(
    /** @type {any} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'fixture-stage1-clear-persona',
        workItemId: 'fixture-work-item-deployment-update-review',
        revision: 1,
        action: 'clear_persona',
        occurredAt: '2026-08-26T08:41:00Z',
      })
    ),
  )
  database.close()

  assert.throws(
    () => createFixtureInboxService(path, { includeDraftFlow: true }),
    (error) => error instanceof FixtureStage1FlowError && error.code === 'persona_mismatch',
  )
  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 0)
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM audit_records WHERE category = 'draft'`).get()
      ?.count,
    0,
  )
  inspection.close()
})

test('the fixture flow never overrides a changed durable Draft', async (context) => {
  const path = await temporaryDatabase(context, 'stage1-draft')
  createFixtureInboxService(path, { includeDraftFlow: true }).close()
  const database = openTwinDeskDatabase(path)
  database.transitionDraft(
    /** @type {any} */ (
      parseDraftStateTransition({
        kind: 'draft_state_transition',
        schemaVersion: 1,
        id: 'fixture-stage1-cancel-draft',
        draftId: 'fixture-draft-release-risk-question',
        fromState: 'ready_for_review',
        toState: 'cancelled',
        occurredAt: '2026-08-26T09:17:00Z',
      })
    ),
  )
  database.close()

  assert.throws(
    () => createFixtureInboxService(path, { includeDraftFlow: true }),
    (error) => error instanceof FixtureStage1FlowError && error.code === 'draft_mismatch',
  )
  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(
    inspection
      .prepare(`SELECT state FROM drafts WHERE id = 'fixture-draft-release-risk-question'`)
      .get()?.state,
    'cancelled',
  )
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM drafts`).get()?.count, 2)
  inspection.close()
})
