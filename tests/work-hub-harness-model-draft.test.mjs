import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import { createFixtureInboxServiceFromDatabase } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  createWorkHubHarnessModelDraftOperation,
  WorkHubHarnessModelDraftError,
} from '../packages/plugin-work-hub/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

const COMPLETED_AT = '2026-08-26T10:00:00.000Z'
const OUTPUT = 'Synthetic stakeholder draft retained locally for user review.'
const PRIVATE_PROMPT = 'synthetic-private-model-prompt'

function request(changes = {}) {
  return /** @type {any} */ ({
    kind: 'work_hub_harness_model_draft_request',
    schemaVersion: 1,
    draftId: 'draft-harness-linked-synthetic',
    workItemId: 'fixture-work-item-release-risk-question',
    personaId: 'communication',
    revision: 1,
    sessionId: 'session-harness-linked-synthetic',
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    prompt: PRIVATE_PROMPT,
    rationale: 'User-visible synthetic decision summary.',
    ...changes,
  })
}

function result(disposition = 'completed', changes = {}) {
  return /** @type {any} */ (
    Object.freeze({
      kind: 'harness_model_draft_run_result',
      schemaVersion: 1,
      disposition,
      sessionId: 'session-harness-linked-synthetic',
      runId: 'session-harness-linked-synthetic:turn-1',
      presetId: 'twindesk-communication',
      text: OUTPUT,
      completedAt: COMPLETED_AT,
      ...changes,
    })
  )
}

function database() {
  const value = openTwinDeskDatabase(':memory:')
  createFixtureInboxServiceFromDatabase(value).close()
  return value
}

test('Work Hub composes the installed Persona, durable Harness result, Draft, and Audit', async () => {
  const storage = database()
  /** @type {import('../packages/harness-adapter/dist/index.js').HarnessModelDraftRunRequest[]} */
  const runtimeRequests = []
  let disposition = 'completed'
  const operation = createWorkHubHarnessModelDraftOperation({
    database: storage,
    runner: {
      async run(runtimeRequest) {
        runtimeRequests.push(runtimeRequest)
        return result(disposition)
      },
    },
  })

  const created = await operation.create(request())
  assert.equal(created.disposition, 'inserted')
  assert.equal(created.runtimeDisposition, 'completed')
  assert.equal(created.draft.state, 'editing')
  assert.equal(created.draft.content.text, OUTPUT)
  assert.equal(created.draft.sessionId, 'session-harness-linked-synthetic')
  assert.equal(created.draft.runId, 'session-harness-linked-synthetic:turn-1')
  assert.deepEqual(runtimeRequests, [
    {
      kind: 'harness_model_draft_run_request',
      schemaVersion: 1,
      sessionId: 'session-harness-linked-synthetic',
      presetId: 'twindesk-communication',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      prompt: PRIVATE_PROMPT,
      mode: 'create_or_recover',
    },
  ])
  assert.equal(JSON.stringify(created.audit).includes(OUTPUT), false)
  assert.equal(JSON.stringify(created.audit).includes(PRIVATE_PROMPT), false)

  storage.applyWorkItemUserAction(
    /** @type {any} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'select-technical-after-model-draft',
        workItemId: 'fixture-work-item-release-risk-question',
        revision: 1,
        action: 'select_persona',
        personaId: 'technical-lead',
        occurredAt: '2026-08-26T10:01:00.000Z',
      })
    ),
  )
  disposition = 'recovered'
  const replay = await operation.create(request())
  assert.equal(replay.disposition, 'duplicate')
  assert.equal(replay.runtimeDisposition, 'recovered')
  assert.equal(runtimeRequests[1]?.mode, 'recover_only')
  assert.equal(storage.queryAuditTimeline({ limit: 100 }).records.length, 1)
  storage.close()
})

test('Work Hub cancellation and malformed runtime results create no Draft or Audit', async () => {
  const storage = database()
  const cancelled = new AbortController()
  cancelled.abort()
  const cancelledOperation = createWorkHubHarnessModelDraftOperation({
    database: storage,
    runner: {
      async run() {
        throw new Error(PRIVATE_PROMPT)
      },
    },
  })
  await assert.rejects(
    cancelledOperation.create(request(), cancelled.signal),
    (error) =>
      error instanceof WorkHubHarnessModelDraftError &&
      error.code === 'cancelled' &&
      !error.message.includes(PRIVATE_PROMPT),
  )

  const malformedOperation = createWorkHubHarnessModelDraftOperation({
    database: storage,
    runner: {
      async run() {
        return result('completed', { presetId: 'twindesk-technical-lead' })
      },
    },
  })
  await assert.rejects(
    malformedOperation.create(request()),
    (error) =>
      error instanceof WorkHubHarnessModelDraftError && error.code === 'runtime_unavailable',
  )
  assert.equal(storage.getDraft(/** @type {any} */ ('draft-harness-linked-synthetic')), undefined)
  assert.equal(storage.queryAuditTimeline({ limit: 100 }).records.length, 0)
  storage.close()
})

test('Work Hub rejects hostile model Draft requests before invoking Harness', async () => {
  const storage = database()
  let calls = 0
  const operation = createWorkHubHarnessModelDraftOperation({
    database: storage,
    runner: {
      async run() {
        calls += 1
        return result()
      },
    },
  })
  let accessed = false
  const hostile = Object.defineProperty({}, 'prompt', {
    enumerable: true,
    get() {
      accessed = true
      throw new Error(PRIVATE_PROMPT)
    },
  })
  await assert.rejects(
    operation.create(/** @type {any} */ (hostile)),
    (error) =>
      error instanceof WorkHubHarnessModelDraftError &&
      error.code === 'invalid_request' &&
      !error.message.includes(PRIVATE_PROMPT),
  )
  assert.equal(accessed, false)
  assert.equal(calls, 0)
  await assert.rejects(
    operation.create(request({ workItemId: 'missing-work-item' })),
    (error) => error instanceof WorkHubHarnessModelDraftError && error.code === 'invalid_request',
  )
  await assert.rejects(
    operation.create(request({ personaId: 'technical-lead' })),
    (error) => error instanceof WorkHubHarnessModelDraftError && error.code === 'invalid_request',
  )
  await assert.rejects(
    operation.create(request(), /** @type {any} */ ({})),
    (error) => error instanceof WorkHubHarnessModelDraftError && error.code === 'invalid_request',
  )
  assert.equal(calls, 0)
  storage.close()
})
