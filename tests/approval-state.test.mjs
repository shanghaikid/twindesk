import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseDraft, parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FeishuMessageNormalizer,
  FeishuReplyProposer,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'
import {
  APPROVAL_POLICY_VERSION,
  ApprovalStateError,
  computeActionApprovalBindings,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ActionProposal} ActionProposal */
/** @typedef {import('../packages/domain/src/model.ts').ApprovalRecord} ApprovalRecord */
/** @typedef {import('../packages/domain/src/model.ts').ContentDigest} ContentDigest */
/** @typedef {import('../packages/domain/src/model.ts').Draft} Draft */
/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} WorkItemUserAction */
/** @typedef {import('../packages/plugin-feishu/src/bot-event-consumer.ts').FeishuBotMessageEvent} FeishuBotMessageEvent */
/** @typedef {import('../packages/storage-sqlite/src/approval-state.ts').ActionApprovalDecision} ActionApprovalDecision */
/** @typedef {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} TwinDeskDatabase */

const ACCOUNT_ID = 'feishu-account:synthetic'
const APP_ID = 'cli_synthetic_twindesk'
const TENANT_KEY = 'tenant_synthetic'
const BOT_PRINCIPAL = 'ou_synthetic_bot'
const USER_PRINCIPAL = 'ou_synthetic_user'
const CREATE_MS = Date.parse('2026-08-27T08:00:00.000Z')
const REQUESTED_AT = '2026-08-27T08:05:00.000Z'
const EXPIRES_AT = '2026-08-27T08:15:00.000Z'

/** @param {string} [initial] */
function policyClock(initial = REQUESTED_AT) {
  let nowMs = Date.parse(initial)
  return {
    options: { now: () => nowMs },
    /** @param {string} value */
    set(value) {
      nowMs = Date.parse(value)
    },
  }
}

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-approval-state-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Bot',
      principalId: BOT_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-approval-bot',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    user: {
      identityType: 'user',
      displayName: 'Synthetic User',
      principalId: USER_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-approval-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {string} suffix @returns {FeishuBotMessageEvent} */
function botEvent(suffix) {
  return /** @type {FeishuBotMessageEvent} */ ({
    kind: 'feishu_bot_message_event',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    botPrincipalId: BOT_PRINCIPAL,
    deliveryEventId: `evt_synthetic_approval_${suffix}`,
    messageId: `om_synthetic_approval_${suffix}`,
    chatId: `oc_synthetic_approval_${suffix}`,
    chatType: 'p2p',
    visibility: 'direct_message',
    senderPrincipalId: 'ou_synthetic_sender',
    messageType: 'text',
    sourceCreateTime: String(CREATE_MS),
    content: { text: `Synthetic approval question ${suffix}` },
    mentions: [],
  })
}

/** @param {TwinDeskDatabase} database @param {string} suffix */
async function seedProposal(database, suffix) {
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const batch = normalizer.normalizeBotMessage(
    botEvent(suffix),
    '2026-08-27T08:01:00.000Z',
    database,
  )
  database.commitConnectorSyncBatch({
    connectorId: batch.connectorId,
    accountId: batch.accountId,
    stream: batch.stream,
    events: batch.events,
    projections: batch.projections,
  })
  const workItem = batch.projections[0]?.workItem
  const event = batch.events[0]
  assert.ok(workItem)
  assert.ok(event)
  database.applyWorkItemUserAction(
    /** @type {WorkItemUserAction} */ (
      /** @type {unknown} */ (
        parseWorkItemUserAction({
          kind: 'work_item_user_action',
          schemaVersion: 1,
          id: `work-item-action-approval-${suffix}`,
          workItemId: workItem.id,
          revision: 1,
          action: 'select_persona',
          personaId: 'communication',
          occurredAt: '2026-08-27T08:02:00.000Z',
        })
      )
    ),
  )
  const content = Object.freeze({
    mediaType: /** @type {const} */ ('text/plain'),
    text: `Synthetic approved reply ${suffix}.`,
  })
  const draft = /** @type {Draft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: `draft-synthetic-approval-${suffix}`,
        workItemId: workItem.id,
        personaId: 'communication',
        revision: 1,
        state: 'ready_for_review',
        content,
        rationale: 'Uses only synthetic approval context.',
        createdAt: '2026-08-27T08:03:00.000Z',
        updatedAt: '2026-08-27T08:03:00.000Z',
      })
    )
  )
  database.createDraft(draft)
  const proposal = await new FeishuReplyProposer(configuration(), {
    now: () => Date.parse('2026-08-27T08:04:00.000Z'),
    createNonce: () => `synthetic-approval-proposal-${suffix}`,
  }).propose(
    {
      workItemId: workItem.id,
      draftId: draft.id,
      actionType: FEISHU_REPLY_ACTION_TYPE,
      identity: toFeishuActionIdentity(configuration(), 'user'),
      target: event.source,
      content,
    },
    new AbortController().signal,
  )
  database.createActionProposal(proposal)
  return proposal
}

/** @param {ActionProposal} proposal @param {string} [suffix] */
function approvalRequest(proposal, suffix = 'main') {
  return {
    kind: /** @type {const} */ ('action_approval_request'),
    schemaVersion: /** @type {const} */ (1),
    id: /** @type {import('../packages/domain/src/model.ts').ApprovalRecordId} */ (
      `approval-synthetic-${suffix}`
    ),
    proposalId: proposal.id,
    requestedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
      REQUESTED_AT
    ),
    expiresAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (EXPIRES_AT),
  }
}

/**
 * @param {ApprovalRecord} approval
 * @param {ActionProposal} proposal
 * @param {'approved' | 'rejected' | 'cancelled' | 'expired'} decision
 * @param {string} decidedAt
 * @returns {ActionApprovalDecision}
 */
function approvalDecision(approval, proposal, decision, decidedAt) {
  const bindings = computeActionApprovalBindings(proposal)
  return /** @type {ActionApprovalDecision} */ ({
    kind: 'action_approval_decision',
    schemaVersion: 1,
    approvalId: approval.id,
    proposalId: proposal.id,
    decision,
    ...bindings,
    decidedAt,
    ...(decision === 'expired' ? {} : { responderUserId: 'user:synthetic-owner' }),
  })
}

test('approval binds an exact proposal, survives restart, and yields one resumable execution attempt', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const proposal = await seedProposal(database, 'approved')
  const requested = database.requestActionApproval(approvalRequest(proposal, 'approved'))
  assert.equal(APPROVAL_POLICY_VERSION, 1)
  assert.equal(requested.disposition, 'inserted')
  assert.equal(requested.approval.decision, 'pending')
  assert.equal(requested.proposal.state, 'awaiting_approval')
  assert.deepEqual(
    {
      identityDigest: requested.approval.identityDigest,
      targetDigest: requested.approval.targetDigest,
      contentDigest: requested.approval.contentDigest,
    },
    computeActionApprovalBindings(proposal),
  )
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  assert.equal(
    database.requestActionApproval(approvalRequest(proposal, 'approved')).disposition,
    'duplicate',
  )
  clock.set('2026-08-27T08:06:00.000Z')
  const approved = database.decideActionApproval(
    approvalDecision(requested.approval, proposal, 'approved', '2026-08-27T08:06:00.000Z'),
  )
  assert.equal(approved.approval.decision, 'approved')
  assert.equal(approved.proposal.state, 'approved')
  const bindings = computeActionApprovalBindings(proposal)
  const consumption = {
    kind: /** @type {const} */ ('action_approval_consumption'),
    schemaVersion: /** @type {const} */ (1),
    approvalId: approved.approval.id,
    proposalId: proposal.id,
    ...bindings,
    consumedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
      '2026-08-27T08:07:00.000Z'
    ),
  }
  clock.set('2026-08-27T08:07:00.000Z')
  const consumed = database.consumeActionApproval(consumption)
  assert.equal(consumed.disposition, 'consumed')
  assert.equal(consumed.approval.consumedAt, '2026-08-27T08:07:00.000Z')
  assert.equal(consumed.action.proposal.id, proposal.id)
  assert.equal(consumed.action.approval.decision, 'approved')
  assert.equal(consumed.action.approval.consumedAt, undefined)
  assert.match(consumed.action.executionAttemptId, /^execution-approval-[a-f0-9]{32}$/u)
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  clock.set('2026-08-27T08:08:00.000Z')
  const replay = database.consumeActionApproval({
    ...consumption,
    consumedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
      '2026-08-27T08:08:00.000Z'
    ),
  })
  assert.equal(replay.disposition, 'duplicate')
  assert.equal(replay.action.executionAttemptId, consumed.action.executionAttemptId)
  assert.equal(replay.action.proposal.idempotencyKey, proposal.idempotencyKey)
  clock.set('2026-08-27T08:16:00.000Z')
  assert.throws(
    () =>
      database.consumeActionApproval({
        ...consumption,
        consumedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
          '2026-08-27T08:08:00.000Z'
        ),
      }),
    (error) => error instanceof ApprovalStateError && error.code === 'approval_expired',
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  inspection.close()
})

test('rejection, cancellation, and expiry are terminal and never yield an approved action', async (context) => {
  const terminalCases = /** @type {const} */ ([
    ['rejected', '2026-08-27T08:06:00.000Z'],
    ['cancelled', '2026-08-27T08:06:00.000Z'],
    ['expired', EXPIRES_AT],
  ])
  for (const [decision, decidedAt] of terminalCases) {
    await context.test(decision, async () => {
      const path = await temporaryDatabase(context)
      const clock = policyClock()
      const database = openTwinDeskDatabase(path, clock.options)
      const proposal = await seedProposal(database, decision)
      const pending = database.requestActionApproval(approvalRequest(proposal, decision))
      clock.set(decidedAt)
      const result = database.decideActionApproval(
        approvalDecision(
          pending.approval,
          proposal,
          /** @type {'rejected' | 'cancelled' | 'expired'} */ (decision),
          decidedAt,
        ),
      )
      assert.equal(result.approval.decision, decision)
      assert.equal(result.proposal.state, decision === 'rejected' ? 'rejected' : 'cancelled')
      const bindings = computeActionApprovalBindings(proposal)
      assert.throws(
        () =>
          database.consumeActionApproval({
            kind: 'action_approval_consumption',
            schemaVersion: 1,
            approvalId: result.approval.id,
            proposalId: proposal.id,
            ...bindings,
            consumedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
              '2026-08-27T08:07:00.000Z'
            ),
          }),
        (error) => error instanceof ApprovalStateError && error.code === 'proposal_state',
      )
      database.close()
    })
  }
})

test('missing responders, stale lifetimes, binding changes, and hostile decisions fail closed', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const proposal = await seedProposal(database, 'invalid')
  const pending = database.requestActionApproval(approvalRequest(proposal, 'invalid'))
  const approved = approvalDecision(
    pending.approval,
    proposal,
    'approved',
    '2026-08-27T08:06:00.000Z',
  )
  clock.set('2026-08-27T08:06:00.000Z')
  const { responderUserId: _responder, ...withoutResponder } = approved
  assert.throws(
    () => database.decideActionApproval(/** @type {ActionApprovalDecision} */ (withoutResponder)),
    (error) => error instanceof ApprovalStateError && error.code === 'invalid_request',
  )
  const privateValue = 'synthetic-private-approval-value'
  assert.throws(
    () =>
      database.decideActionApproval({
        ...approved,
        identityDigest: /** @type {ContentDigest} */ (
          'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        ),
      }),
    (error) =>
      error instanceof ApprovalStateError &&
      error.code === 'binding_mismatch' &&
      !error.message.includes(privateValue),
  )
  assert.throws(
    () =>
      database.decideActionApproval({
        ...approved,
        decidedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
          '2026-08-27T08:16:00.000Z'
        ),
      }),
    (error) => error instanceof ApprovalStateError && error.code === 'approval_expired',
  )
  clock.set('2026-08-27T08:16:00.000Z')
  assert.throws(
    () => database.decideActionApproval(approved),
    (error) => error instanceof ApprovalStateError && error.code === 'approval_expired',
  )
  clock.set('2026-08-27T08:06:00.000Z')
  assert.throws(
    () =>
      database.decideActionApproval(
        approvalDecision(pending.approval, proposal, 'expired', EXPIRES_AT),
      ),
    (error) => error instanceof ApprovalStateError && error.code === 'approval_expired',
  )
  let accessed = false
  const hostile = Object.defineProperty({ ...approved }, 'contentDigest', {
    enumerable: true,
    get() {
      accessed = true
      return privateValue
    },
  })
  assert.throws(
    () => database.decideActionApproval(/** @type {ActionApprovalDecision} */ (hostile)),
    (error) =>
      error instanceof ApprovalStateError &&
      error.code === 'invalid_request' &&
      !error.message.includes(privateValue),
  )
  assert.equal(accessed, false)
  assert.equal(database.getActionApproval(pending.approval.id)?.decision, 'pending')
  assert.equal(database.getActionProposal(proposal.id)?.state, 'awaiting_approval')
  database.close()
})

test('an interrupted approval decision rolls back both approval and proposal state', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const setup = openTwinDeskDatabase(path, clock.options)
  const proposal = await seedProposal(setup, 'interrupted')
  const pending = setup.requestActionApproval(approvalRequest(proposal, 'interrupted'))
  setup.close()
  const injector = new DatabaseSync(path)
  injector.exec(`
    CREATE TRIGGER synthetic_approval_decision_failure
    BEFORE UPDATE OF state ON action_proposals
    WHEN NEW.state = 'approved'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic approval decision interruption');
    END;
  `)
  injector.close()

  const database = openTwinDeskDatabase(path, clock.options)
  clock.set('2026-08-27T08:06:00.000Z')
  assert.throws(
    () =>
      database.decideActionApproval(
        approvalDecision(pending.approval, proposal, 'approved', '2026-08-27T08:06:00.000Z'),
      ),
    (error) =>
      error instanceof ApprovalStateError &&
      error.code === 'storage_error' &&
      !error.message.includes('synthetic approval decision interruption'),
  )
  assert.equal(database.getActionApproval(pending.approval.id)?.decision, 'pending')
  assert.equal(database.getActionProposal(proposal.id)?.state, 'awaiting_approval')
  database.close()
})

test('closed handles reject every approval operation before inspecting input', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  database.close()
  for (const operation of [
    () => database.requestActionApproval(/** @type {never} */ ({})),
    () => database.decideActionApproval(/** @type {never} */ ({})),
    () => database.consumeActionApproval(/** @type {never} */ ({})),
    () => database.getActionApproval(/** @type {never} */ ('missing-approval')),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof ApprovalStateError && error.code === 'database_closed',
    )
  }
})
