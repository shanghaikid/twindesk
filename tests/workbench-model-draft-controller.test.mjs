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
} from '../packages/domain/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'
import {
  createWorkbenchModelDraftController,
  WorkbenchModelDraftError,
} from '../packages/bundle-workbench/dist/index.js'

const WORK_ITEM_ID = 'model-entry-work-item-synthetic'
const TOKEN = 'synthetic-bearer-token-that-must-not-reach-the-model'

/** @param {import('node:test').TestContext} context */
async function databaseWithWorkItem(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-model-entry-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'twindesk.sqlite3')
  const database = openTwinDeskDatabase(path)
  context.after(() => database.isOpen && database.close())
  const source = {
    connectorId: 'fixture',
    accountId: 'synthetic-account',
    objectType: 'message',
    externalId: 'synthetic-model-entry-message',
    sourceTimestamp: '2026-09-02T09:00:00.000Z',
  }
  const event = parseExternalEvent({
    kind: 'external_event',
    schemaVersion: 1,
    id: 'model-entry-event-synthetic',
    idempotencyKey: 'model-entry-event-synthetic:v1',
    source,
    eventType: 'message.received',
    occurredAt: source.sourceTimestamp,
    receivedAt: source.sourceTimestamp,
    context: { status: 'complete' },
    normalized: { fixture: true },
  })
  const thread = parseExternalThread({
    kind: 'external_thread',
    schemaVersion: 1,
    id: 'model-entry-thread-synthetic',
    subject: 'Synthetic model entry',
    externalReferences: [source],
    sourceEventIds: [event.id],
    createdAt: source.sourceTimestamp,
    updatedAt: source.sourceTimestamp,
  })
  const workItem = parseWorkItem({
    kind: 'work_item',
    schemaVersion: 1,
    id: WORK_ITEM_ID,
    threadId: thread.id,
    sourceEventIds: [event.id],
    inboxState: 'needs_reply',
    title: 'Draft a synthetic update',
    summary: `Authorization: Bearer ${TOKEN}`,
    attentionReason: 'A synthetic response is requested.',
    selectedPersonaId: 'communication',
    createdAt: source.sourceTimestamp,
    updatedAt: source.sourceTimestamp,
  })
  database.ingestExternalEvents(/** @type {any} */ ([event]))
  database.putWorkItemProjection(/** @type {any} */ ({ thread, workItem }))
  return { database, path }
}

test('Workbench model Draft controller owns provider, prompt, identities, persistence, and replay', async (context) => {
  const { database, path } = await databaseWithWorkItem(context)
  /** @type {any[]} */
  const requests = []
  /** @type {import('../packages/harness-adapter/dist/index.js').HarnessModelDraftRunner} */
  const runner = {
    async run(request, signal) {
      signal?.throwIfAborted()
      requests.push(request)
      return {
        kind: 'harness_model_draft_run_result',
        schemaVersion: 1,
        disposition: requests.length === 1 ? 'completed' : 'recovered',
        sessionId: request.sessionId,
        runId: `${request.sessionId}:turn-1`,
        presetId: request.presetId,
        text: 'Synthetic local Draft for user review.',
        completedAt: '2026-09-02T09:01:00.000Z',
      }
    },
  }
  const controller = createWorkbenchModelDraftController({
    database,
    runner,
    provider: 'host-provider',
    model: 'host-model',
    now: () => Date.parse('2026-09-02T09:02:00.000Z'),
  })
  assert.deepEqual(await controller.read(), {
    version: 1,
    capability: 'ready',
    autonomy: 'draft_only',
  })
  const first = /** @type {any} */ (
    await controller.create(WORK_ITEM_ID, new AbortController().signal)
  )
  const replay = /** @type {any} */ (
    await controller.create(WORK_ITEM_ID, new AbortController().signal)
  )
  assert.equal(first.disposition, 'created')
  assert.equal(replay.disposition, 'recovered')
  assert.equal(first.externalWritesAvailable, false)
  assert.equal(first.draft.state, 'editing')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].provider, 'host-provider')
  assert.equal(requests[0].model, 'host-model')
  assert.equal(requests[0].mode, 'create_or_recover')
  assert.equal(requests[1].mode, 'recover_only')
  assert.match(requests[0].prompt, /Draft a synthetic update/u)
  assert.doesNotMatch(requests[0].prompt, new RegExp(TOKEN, 'u'))
  assert.match(requests[0].prompt, /\[REDACTED\]/u)

  const edited = /** @type {any} */ (
    await controller.edit(
      {
        version: 1,
        workItemId: WORK_ITEM_ID,
        sourceRevision: 1,
        content: { mediaType: 'text/plain', text: 'A user-edited local Draft.' },
        submitForReview: false,
      },
      new AbortController().signal,
    )
  )
  assert.equal(edited.disposition, 'saved')
  assert.equal(edited.draft.revision, 2)
  assert.equal(edited.draft.state, 'editing')
  assert.equal(database.getDraft(requests[0].sessionId)?.state, 'superseded')
  const submitted = /** @type {any} */ (
    await controller.edit(
      {
        version: 1,
        workItemId: WORK_ITEM_ID,
        sourceRevision: 2,
        content: edited.draft.content,
        submitForReview: true,
      },
      new AbortController().signal,
    )
  )
  assert.equal(submitted.disposition, 'submitted')
  assert.equal(submitted.draft.revision, 2)
  assert.equal(submitted.draft.state, 'ready_for_review')
  const invalidClockController = createWorkbenchModelDraftController({
    database,
    runner,
    provider: 'host-provider',
    model: 'host-model',
    now: () => 9_000_000_000_000_000,
  })
  await assert.rejects(
    invalidClockController.edit(
      {
        version: 1,
        workItemId: WORK_ITEM_ID,
        sourceRevision: 2,
        content: { mediaType: 'text/plain', text: 'This invalid-clock edit must not persist.' },
        submitForReview: false,
      },
      new AbortController().signal,
    ),
    (error) => error instanceof WorkbenchModelDraftError && error.code === 'runtime_unavailable',
  )
  const refreshed = /** @type {any} */ (
    await controller.create(WORK_ITEM_ID, new AbortController().signal)
  )
  assert.equal(refreshed.disposition, 'recovered')
  assert.equal(refreshed.draft.revision, 2)
  assert.equal(refreshed.draft.state, 'ready_for_review')
  assert.equal(requests.at(-1).mode, 'recover_only')

  const audit = JSON.stringify(database.queryAuditTimeline({ limit: 20 }).records)
  assert.doesNotMatch(audit, /host-provider|host-model|Create one concise|synthetic-bearer/u)
  database.close()

  const restarted = openTwinDeskDatabase(path)
  try {
    assert.equal(restarted.getDraft(requests[0].sessionId)?.state, 'superseded')
    assert.equal(
      restarted.getDraft(/** @type {any} */ (`${requests[0].sessionId}-revision-2`))?.state,
      'ready_for_review',
    )
    const records = restarted.queryAuditTimeline({ limit: 20 }).records
    assert.equal(records.length, 3)
    assert.equal(records.filter(({ actor }) => actor.type === 'user').length, 2)
    assert.doesNotMatch(JSON.stringify(records), /A user-edited local Draft/u)
  } finally {
    restarted.close()
  }
})

test('Workbench model Draft controller fails closed without a selected installed Persona', async (context) => {
  const { database } = await databaseWithWorkItem(context)
  database.applyWorkItemUserAction(
    /** @type {any} */ ({
      kind: 'work_item_user_action',
      schemaVersion: 1,
      id: 'model-entry-clear-persona',
      workItemId: WORK_ITEM_ID,
      revision: 1,
      action: 'clear_persona',
      occurredAt: '2026-09-02T09:00:30.000Z',
    }),
  )
  let calls = 0
  const controller = createWorkbenchModelDraftController({
    database,
    runner: /** @type {any} */ ({
      run() {
        calls += 1
      },
    }),
    provider: 'host-provider',
    model: 'host-model',
  })
  await assert.rejects(
    controller.create(WORK_ITEM_ID, new AbortController().signal),
    (error) => error instanceof WorkbenchModelDraftError && error.code === 'target_unavailable',
  )
  assert.equal(calls, 0)
})

test('Workbench model Draft editing repairs interrupted Audit without another model run', async (context) => {
  const { database, path } = await databaseWithWorkItem(context)
  let modelCalls = 0
  const controller = createWorkbenchModelDraftController({
    database,
    runner: /** @type {any} */ ({
      async run(/** @type {any} */ request) {
        modelCalls += 1
        return {
          kind: 'harness_model_draft_run_result',
          schemaVersion: 1,
          disposition: 'completed',
          sessionId: request.sessionId,
          runId: `${request.sessionId}:turn-1`,
          presetId: request.presetId,
          text: 'Synthetic Draft before a local edit.',
          completedAt: '2026-09-02T09:01:00.000Z',
        }
      },
    }),
    provider: 'host-provider',
    model: 'host-model',
    now: () => Date.parse('2026-09-02T09:02:00.000Z'),
  })
  const created = /** @type {any} */ (
    await controller.create(WORK_ITEM_ID, new AbortController().signal)
  )
  const inspection = new DatabaseSync(path)
  context.after(() => inspection.close())
  inspection.exec(`
    CREATE TRIGGER interrupt_user_draft_audit
    BEFORE INSERT ON audit_records
    WHEN NEW.category = 'draft' AND NEW.actor_type = 'user'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic private audit interruption');
    END;
  `)
  const request = {
    version: 1,
    workItemId: WORK_ITEM_ID,
    sourceRevision: 1,
    content: { mediaType: 'text/plain', text: 'A recovered user edit.' },
    submitForReview: true,
  }
  await assert.rejects(
    controller.edit(/** @type {any} */ (request), new AbortController().signal),
    (error) =>
      error instanceof WorkbenchModelDraftError &&
      error.code === 'runtime_unavailable' &&
      !error.message.includes('synthetic private'),
  )
  assert.equal(created.draft.revision, 1)
  assert.deepEqual(
    inspection
      .prepare('SELECT revision, state FROM drafts ORDER BY revision')
      .all()
      .map((row) => ({ ...row })),
    [
      { revision: 1, state: 'superseded' },
      { revision: 2, state: 'ready_for_review' },
    ],
  )
  inspection.exec('DROP TRIGGER interrupt_user_draft_audit')

  const recovered = /** @type {any} */ (
    await controller.edit(/** @type {any} */ (request), new AbortController().signal)
  )
  assert.equal(recovered.disposition, 'recovered')
  assert.equal(recovered.draft.revision, 2)
  assert.equal(recovered.draft.state, 'ready_for_review')
  assert.equal(modelCalls, 1)
  assert.equal(
    database
      .queryAuditTimeline({ workItemId: /** @type {any} */ (WORK_ITEM_ID), limit: 20 })
      .records.filter(({ actor }) => actor.type === 'user').length,
    1,
  )
})
