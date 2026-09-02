import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseActionProposal,
  parseActionProposalStateTransition,
  parseDraft,
  parseDraftStateTransition,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'
import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  DraftActionStateError,
  computeDraftContentDigest,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ActionProposal} SourceActionProposal */
/** @typedef {import('../packages/domain/src/model.ts').ActionProposalStateTransition} SourceActionProposalStateTransition */
/** @typedef {import('../packages/domain/src/model.ts').Draft} SourceDraft */
/** @typedef {import('../packages/domain/src/model.ts').DraftStateTransition} SourceDraftStateTransition */
/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} SourceWorkItemUserAction */

const WORK_ITEM_ID = 'fixture-work-item-release-risk-question'
const CONTENT = Object.freeze({
  mediaType: 'text/markdown',
  text: 'The staged rollout can proceed after the synthetic health check passes.',
})

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-draft-action-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'twindesk.sqlite3')
  createFixtureInboxService(path).close()
  return path
}

/** @param {string} id @param {number} revision @param {string} createdAt @returns {SourceDraft} */
function draft(id, revision = 1, createdAt = '2026-08-26T09:16:00Z') {
  return /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id,
        workItemId: WORK_ITEM_ID,
        personaId: 'communication',
        sessionId: 'synthetic-session',
        runId: `synthetic-run-${revision}`,
        revision,
        state: 'editing',
        content: CONTENT,
        rationale: 'Uses only complete synthetic fixture context.',
        createdAt,
        updatedAt: createdAt,
      })
    )
  )
}

/**
 * @param {string} id
 * @param {string} draftId
 * @param {'editing' | 'ready_for_review'} fromState
 * @param {'ready_for_review' | 'superseded' | 'cancelled'} toState
 * @param {string} occurredAt
 * @returns {SourceDraftStateTransition}
 */
function draftTransition(id, draftId, fromState, toState, occurredAt) {
  return /** @type {SourceDraftStateTransition} */ (
    /** @type {unknown} */ (
      parseDraftStateTransition({
        kind: 'draft_state_transition',
        schemaVersion: 1,
        id,
        draftId,
        fromState,
        toState,
        occurredAt,
      })
    )
  )
}

/** @param {string} draftId @returns {SourceActionProposal} */
function proposal(draftId) {
  return /** @type {SourceActionProposal} */ (
    /** @type {unknown} */ (
      parseActionProposal({
        kind: 'action_proposal',
        schemaVersion: 1,
        id: 'proposal-release-reply-1',
        workItemId: WORK_ITEM_ID,
        draftId,
        actionType: 'fixture.reply.preview',
        risk: 'write',
        identity: {
          connectorId: 'fixture',
          accountId: 'synthetic-account',
          identityType: 'user',
          displayName: 'Synthetic User',
        },
        target: {
          connectorId: 'fixture',
          accountId: 'synthetic-account',
          objectType: 'message',
          externalId: 'synthetic-message-release-risk-question',
          sourceTimestamp: '2026-08-26T09:15:00Z',
        },
        content: CONTENT,
        contentDigest: computeDraftContentDigest(CONTENT),
        idempotencyKey: 'fixture:reply:release-risk-question:v1',
        state: 'proposed',
        createdAt: '2026-08-26T09:18:00Z',
        updatedAt: '2026-08-26T09:18:00Z',
      })
    )
  )
}

/**
 * @param {string} id
 * @param {'proposed' | 'awaiting_approval'} fromState
 * @param {'awaiting_approval' | 'rejected' | 'cancelled'} toState
 * @param {string} occurredAt
 * @returns {SourceActionProposalStateTransition}
 */
function proposalTransition(id, fromState, toState, occurredAt) {
  return /** @type {SourceActionProposalStateTransition} */ (
    /** @type {unknown} */ (
      parseActionProposalStateTransition({
        kind: 'action_proposal_state_transition',
        schemaVersion: 1,
        id,
        proposalId: 'proposal-release-reply-1',
        fromState,
        toState,
        occurredAt,
      })
    )
  )
}

test('Draft and ActionProposal transitions are idempotent and recover across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const firstDraft = draft('draft-release-reply-1')
  assert.equal(database.createDraft(firstDraft).disposition, 'inserted')
  assert.throws(
    () => database.createDraft(draft('draft-release-reply-2', 2, '2026-08-26T09:17:00Z')),
    (error) => error instanceof DraftActionStateError && error.code === 'active_draft',
  )

  const ready = draftTransition(
    'draft-transition-ready-1',
    firstDraft.id,
    'editing',
    'ready_for_review',
    '2026-08-26T09:17:00Z',
  )
  assert.equal(database.transitionDraft(ready).draft.state, 'ready_for_review')
  assert.equal(database.transitionDraft(ready).disposition, 'duplicate')
  assert.throws(
    () =>
      database.transitionDraft(
        draftTransition(ready.id, firstDraft.id, 'editing', 'cancelled', '2026-08-26T09:17:00Z'),
      ),
    (error) => error instanceof DraftActionStateError && error.code === 'transition_conflict',
  )
  const draftReplay = database.createDraft(firstDraft)
  assert.equal(draftReplay.disposition, 'duplicate')
  assert.equal(draftReplay.draft.state, 'ready_for_review')

  const action = proposal(firstDraft.id)
  assert.equal(database.createActionProposal(action).disposition, 'inserted')
  const awaiting = proposalTransition(
    'proposal-transition-awaiting-1',
    'proposed',
    'awaiting_approval',
    '2026-08-26T09:19:00Z',
  )
  assert.equal(database.transitionActionProposal(awaiting).proposal.state, 'awaiting_approval')
  assert.throws(
    () =>
      database.transitionActionProposal(
        proposalTransition(awaiting.id, 'proposed', 'cancelled', '2026-08-26T09:19:00Z'),
      ),
    (error) => error instanceof DraftActionStateError && error.code === 'transition_conflict',
  )
  const proposalReplay = database.createActionProposal(action)
  assert.equal(proposalReplay.disposition, 'duplicate')
  assert.equal(proposalReplay.proposal.state, 'awaiting_approval')
  const rejected = proposalTransition(
    'proposal-transition-rejected-1',
    'awaiting_approval',
    'rejected',
    '2026-08-26T09:20:00Z',
  )
  assert.equal(database.transitionActionProposal(rejected).proposal.state, 'rejected')

  const superseded = draftTransition(
    'draft-transition-superseded-1',
    firstDraft.id,
    'ready_for_review',
    'superseded',
    '2026-08-26T09:21:00Z',
  )
  database.transitionDraft(superseded)
  const secondDraft = draft('draft-release-reply-2', 2, '2026-08-26T09:22:00Z')
  assert.equal(database.createDraft(secondDraft).disposition, 'inserted')
  database.close()

  const restarted = openTwinDeskDatabase(path)
  assert.equal(restarted.getDraft(firstDraft.id)?.state, 'superseded')
  assert.equal(restarted.getDraft(secondDraft.id)?.revision, 2)
  assert.equal(restarted.getActionProposal(action.id)?.state, 'rejected')
  assert.equal(restarted.transitionDraft(superseded).disposition, 'duplicate')
  assert.equal(restarted.transitionActionProposal(rejected).disposition, 'duplicate')
  restarted.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 0)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  assert.deepEqual(
    inspection
      .prepare(
        `SELECT kind, schema_version AS schemaVersion
         FROM draft_creation_records ORDER BY draft_id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { kind: 'draft_creation_record', schemaVersion: 1 },
      { kind: 'draft_creation_record', schemaVersion: 1 },
    ],
  )
  assert.deepEqual(
    inspection
      .prepare(
        `SELECT kind, schema_version AS schemaVersion
         FROM action_proposal_creation_records`,
      )
      .all()
      .map((row) => ({ ...row })),
    [{ kind: 'action_proposal_creation_record', schemaVersion: 1 }],
  )
})

test('a Draft revision atomically supersedes its source and replays across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const source = draft('draft-atomic-revision-1')
  database.createDraft(source)
  const occurredAt = '2026-08-26T09:17:00Z'
  const revision = /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-atomic-revision-2',
        workItemId: source.workItemId,
        personaId: source.personaId,
        revision: 2,
        state: 'ready_for_review',
        content: { mediaType: 'text/plain', text: 'A locally edited synthetic Draft.' },
        rationale: 'Edited locally by the user.',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
    )
  )
  const transition = draftTransition(
    'draft-atomic-revision-transition-1',
    source.id,
    'editing',
    'superseded',
    occurredAt,
  )
  assert.deepEqual(database.reviseDraft({ transition, draft: revision }), {
    disposition: 'inserted',
    source: { ...source, state: 'superseded', updatedAt: occurredAt },
    draft: revision,
  })
  assert.equal(database.reviseDraft({ transition, draft: revision }).disposition, 'duplicate')
  let accessed = false
  const hostile = Object.defineProperty({ draft: revision }, 'transition', {
    enumerable: true,
    get() {
      accessed = true
      return transition
    },
  })
  assert.throws(
    () => database.reviseDraft(/** @type {any} */ (hostile)),
    (error) => error instanceof DraftActionStateError && error.code === 'invalid_request',
  )
  assert.equal(accessed, false)
  database.close()

  const restarted = openTwinDeskDatabase(path)
  assert.equal(restarted.getDraft(source.id)?.state, 'superseded')
  assert.deepEqual(restarted.getDraft(revision.id), revision)
  assert.equal(restarted.reviseDraft({ transition, draft: revision }).disposition, 'duplicate')
  restarted.close()
})

test('an interrupted atomic Draft revision rolls back source, history, and child', async (context) => {
  const path = await temporaryDatabase(context)
  const source = draft('draft-atomic-interrupted-1')
  const setup = openTwinDeskDatabase(path)
  setup.createDraft(source)
  setup.close()
  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER interrupt_atomic_draft_revision
    BEFORE INSERT ON draft_creation_records
    WHEN NEW.draft_id = 'draft-atomic-interrupted-2'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic private revision interruption');
    END;
  `)
  faultInjector.close()
  const occurredAt = '2026-08-26T09:17:00Z'
  const revision = /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-atomic-interrupted-2',
        workItemId: source.workItemId,
        personaId: source.personaId,
        revision: 2,
        state: 'editing',
        content: { mediaType: 'text/plain', text: 'An interrupted local edit.' },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
    )
  )
  const database = openTwinDeskDatabase(path)
  assert.throws(
    () =>
      database.reviseDraft({
        transition: draftTransition(
          'draft-atomic-interrupted-transition',
          source.id,
          'editing',
          'superseded',
          occurredAt,
        ),
        draft: revision,
      }),
    (error) =>
      error instanceof DraftActionStateError &&
      error.code === 'storage_error' &&
      !error.message.includes('synthetic private'),
  )
  assert.equal(database.getDraft(source.id)?.state, 'editing')
  assert.equal(database.getDraft(revision.id), undefined)
  database.close()
  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(
    inspection.prepare('SELECT count(*) AS count FROM draft_state_transitions').get()?.count,
    0,
  )
})

test('local transitions fail closed on identity, content, chronology, and unsafe states', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const firstDraft = draft('draft-boundary-1')
  const reaffirmPersona = /** @type {SourceWorkItemUserAction} */ (
    /** @type {unknown} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'fixture-action-reaffirm-persona',
        workItemId: WORK_ITEM_ID,
        revision: 1,
        action: 'select_persona',
        personaId: 'communication',
        occurredAt: '2026-08-26T09:16:00Z',
      })
    )
  )
  database.applyWorkItemUserAction(reaffirmPersona)
  const wrongPersona = /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({ ...draft('draft-boundary-2'), personaId: 'technical-lead' })
    )
  )
  assert.throws(
    () => database.createDraft(wrongPersona),
    (error) => error instanceof DraftActionStateError && error.code === 'persona_mismatch',
  )
  assert.throws(
    () => database.createDraft(draft('draft-before-persona', 1, '2026-08-26T09:15:30Z')),
    (error) => error instanceof DraftActionStateError && error.code === 'invalid_request',
  )
  database.createDraft(firstDraft)
  assert.throws(
    () =>
      database.transitionDraft(
        draftTransition(
          'draft-transition-early',
          firstDraft.id,
          'editing',
          'ready_for_review',
          '2026-08-26T09:15:30Z',
        ),
      ),
    (error) => error instanceof DraftActionStateError && error.code === 'stale_state',
  )
  assert.throws(
    () =>
      parseActionProposalStateTransition({
        kind: 'action_proposal_state_transition',
        schemaVersion: 1,
        id: 'unsafe-approval',
        proposalId: 'proposal-release-reply-1',
        fromState: 'awaiting_approval',
        toState: 'approved',
        occurredAt: '2026-08-26T09:20:00Z',
      }),
    /not available without the required approval or execution evidence/u,
  )

  let getterCalls = 0
  const accessorContent = Object.defineProperty({}, 'mediaType', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'text/plain'
    },
  })
  Object.defineProperty(accessorContent, 'text', {
    enumerable: true,
    value: 'sensitive synthetic content',
  })
  assert.throws(
    // @ts-expect-error runtime boundary test
    () => computeDraftContentDigest(accessorContent),
    (error) => {
      assert.ok(error instanceof DraftActionStateError)
      assert.equal(error.code, 'invalid_request')
      assert.equal(error.message.includes('sensitive synthetic content'), false)
      return true
    },
  )
  assert.equal(getterCalls, 0)

  database.transitionDraft(
    draftTransition(
      'draft-transition-boundary-ready',
      firstDraft.id,
      'editing',
      'ready_for_review',
      '2026-08-26T09:17:00Z',
    ),
  )
  const mismatched = /** @type {SourceActionProposal} */ (
    /** @type {unknown} */ (
      parseActionProposal({
        ...proposal(firstDraft.id),
        contentDigest: `sha256:${'0'.repeat(64)}`,
      })
    )
  )
  assert.throws(
    () => database.createActionProposal(mismatched),
    (error) => error instanceof DraftActionStateError && error.code === 'digest_mismatch',
  )
  const sourceProposal = proposal(firstDraft.id)
  const wrongTarget = /** @type {SourceActionProposal} */ (
    /** @type {unknown} */ (
      parseActionProposal({
        ...sourceProposal,
        target: {
          ...sourceProposal.target,
          externalId: 'different-synthetic-message',
        },
      })
    )
  )
  assert.throws(
    () => database.createActionProposal(wrongTarget),
    (error) => error instanceof DraftActionStateError && error.code === 'target_mismatch',
  )

  const changedWorkItem = /** @type {SourceWorkItemUserAction} */ (
    /** @type {unknown} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'fixture-action-change-after-draft',
        workItemId: WORK_ITEM_ID,
        revision: 2,
        action: 'set_inbox_state',
        inboxState: 'needs_review',
        occurredAt: '2026-08-26T09:17:30Z',
      })
    )
  )
  database.applyWorkItemUserAction(changedWorkItem)
  assert.throws(
    () => database.createActionProposal(sourceProposal),
    (error) => error instanceof DraftActionStateError && error.code === 'draft_conflict',
  )
  database.close()
})

test('an interrupted Draft transition rolls back history and current state together', async (context) => {
  const path = await temporaryDatabase(context)
  const firstDraft = draft('draft-interrupted-1')
  const setup = openTwinDeskDatabase(path)
  setup.createDraft(firstDraft)
  setup.close()

  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_draft_transition_failure
    BEFORE UPDATE ON drafts
    BEGIN
      SELECT RAISE(ABORT, 'synthetic transition interruption');
    END;
  `)
  faultInjector.close()

  const database = openTwinDeskDatabase(path)
  assert.throws(
    () =>
      database.transitionDraft(
        draftTransition(
          'draft-transition-interrupted-1',
          firstDraft.id,
          'editing',
          'ready_for_review',
          '2026-08-26T09:17:00Z',
        ),
      ),
    (error) => {
      assert.ok(error instanceof DraftActionStateError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic transition interruption'), false)
      return true
    },
  )
  assert.equal(database.getDraft(firstDraft.id)?.state, 'editing')
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(
    inspection.prepare('SELECT count(*) AS count FROM draft_state_transitions').get()?.count,
    0,
  )
})

test('an interrupted ActionProposal transition rolls back history and current state together', async (context) => {
  const path = await temporaryDatabase(context)
  const firstDraft = draft('draft-proposal-interrupted-1')
  const ready = draftTransition(
    'draft-transition-proposal-ready',
    firstDraft.id,
    'editing',
    'ready_for_review',
    '2026-08-26T09:17:00Z',
  )
  const action = proposal(firstDraft.id)
  const setup = openTwinDeskDatabase(path)
  setup.createDraft(firstDraft)
  setup.transitionDraft(ready)
  setup.createActionProposal(action)
  setup.close()

  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_proposal_transition_failure
    BEFORE UPDATE ON action_proposals
    BEGIN
      SELECT RAISE(ABORT, 'synthetic proposal transition interruption');
    END;
  `)
  faultInjector.close()

  const database = openTwinDeskDatabase(path)
  assert.throws(
    () =>
      database.transitionActionProposal(
        proposalTransition(
          'proposal-transition-interrupted-1',
          'proposed',
          'awaiting_approval',
          '2026-08-26T09:19:00Z',
        ),
      ),
    (error) => {
      assert.ok(error instanceof DraftActionStateError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic proposal transition interruption'), false)
      return true
    },
  )
  assert.equal(database.getActionProposal(action.id)?.state, 'proposed')
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(
    inspection.prepare('SELECT count(*) AS count FROM action_proposal_state_transitions').get()
      ?.count,
    0,
  )
})

test('closed database handles reject every Draft and ActionProposal operation', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const firstDraft = draft('draft-closed-1')
  const action = proposal(firstDraft.id)
  database.close()
  const operations = [
    () => database.createDraft(firstDraft),
    () => database.getDraft(firstDraft.id),
    () => database.getDraftByWorkItemRevision(firstDraft.workItemId, firstDraft.revision),
    () =>
      database.transitionDraft(
        draftTransition(
          'draft-transition-closed',
          firstDraft.id,
          'editing',
          'cancelled',
          '2026-08-26T09:17:00Z',
        ),
      ),
    () => database.createActionProposal(action),
    () => database.getActionProposal(action.id),
    () =>
      database.transitionActionProposal(
        proposalTransition(
          'proposal-transition-closed',
          'proposed',
          'cancelled',
          '2026-08-26T09:19:00Z',
        ),
      ),
  ]
  for (const operation of operations) {
    assert.throws(
      operation,
      (error) => error instanceof DraftActionStateError && error.code === 'database_closed',
    )
  }
})
