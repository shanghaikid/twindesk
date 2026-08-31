import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseDraft, parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FeishuReplyExecutionClientError,
  FeishuReplyExecutor,
  FeishuMessageNormalizer,
  FeishuReplyProposer,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'
import {
  APPROVAL_POLICY_VERSION,
  ActionExecutionStateError,
  ApprovalStateError,
  computeActionApprovalBindings,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ActionProposal} ActionProposal */
/** @typedef {import('../packages/domain/src/connector.ts').ApprovedAction} ApprovedAction */
/** @typedef {import('../packages/domain/src/model.ts').ApprovalRecord} ApprovalRecord */
/** @typedef {import('../packages/domain/src/model.ts').ContentDigest} ContentDigest */
/** @typedef {import('../packages/domain/src/model.ts').Draft} Draft */
/** @typedef {import('../packages/domain/src/model.ts').IsoTimestamp} IsoTimestamp */
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
const EXECUTION_AT = /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
  '2026-08-27T08:07:00.000Z'
)
const RECOVERY_AT = /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
  '2026-08-27T08:08:00.000Z'
)

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

/**
 * @param {ReturnType<typeof policyClock>} clock
 * @param {TwinDeskDatabase} database
 */
function executionOptions(clock, database) {
  return {
    ...clock.options,
    async reserveDispatch(
      /** @type {ApprovedAction} */ action,
      /** @type {IsoTimestamp} */ reservedAt,
    ) {
      return database.reserveActionDispatch({
        kind: 'action_dispatch_reservation',
        schemaVersion: 1,
        action,
        reservedAt,
      }).disposition
    },
  }
}

/**
 * @param {TwinDeskDatabase} database
 * @param {ReturnType<typeof policyClock>} clock
 * @param {string} suffix
 */
async function approveAction(database, clock, suffix) {
  const proposal = await seedProposal(database, suffix)
  const pending = database.requestActionApproval(approvalRequest(proposal, suffix))
  clock.set('2026-08-27T08:06:00.000Z')
  const approved = database.decideActionApproval(
    approvalDecision(pending.approval, proposal, 'approved', '2026-08-27T08:06:00.000Z'),
  )
  clock.set('2026-08-27T08:07:00.000Z')
  const consumed = database.consumeActionApproval({
    kind: 'action_approval_consumption',
    schemaVersion: 1,
    approvalId: approved.approval.id,
    proposalId: proposal.id,
    ...computeActionApprovalBindings(proposal),
    consumedAt: /** @type {import('../packages/domain/src/model.ts').IsoTimestamp} */ (
      '2026-08-27T08:07:00.000Z'
    ),
  })
  return { proposal, action: consumed.action }
}

test('execution rejects over-limit and proposal-mismatched keys before client access', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-invalid-key')
  const client = replyClient()
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  for (const idempotencyKey of [
    `feishu:reply:${'a'.repeat(64)}:identity:${'b'.repeat(64)}:v1`,
    `tdfr1:${'f'.repeat(40)}`,
  ]) {
    await assert.rejects(
      executor.execute(
        { ...action, proposal: { ...action.proposal, idempotencyKey } },
        new AbortController().signal,
      ),
      (error) =>
        error instanceof Error &&
        error.name === 'FeishuReplyExecutionError' &&
        'code' in error &&
        error.code === 'identity_mismatch',
    )
  }
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 0, sendCalls: 0 })
  database.close()
})

/**
 * @param {{ sendFailure?: 'network' | 'rate_limited' | 'scope_missing' | 'invalid_response', reconcileFailure?: boolean, sentAt?: string }} [options]
 * @returns {import('../packages/plugin-feishu/src/reply-execution.ts').FeishuReplyExecutionClient & {
 *   diagnostics(): { reconcileCalls: number, sendCalls: number }
 * }}
 */
function replyClient(options = {}) {
  /** @type {Map<string, Record<string, unknown>>} */
  const remote = new Map()
  let reconcileCalls = 0
  let sendCalls = 0
  return {
    async reconcile(request, signal) {
      signal.throwIfAborted()
      reconcileCalls += 1
      if (options.reconcileFailure) throw new FeishuReplyExecutionClientError('network')
      return (
        remote.get(request.idempotencyKey) ?? {
          status: 'absent',
          accountId: request.accountId,
          identityType: request.identityType,
          idempotencyKey: request.idempotencyKey,
          targetMessageId: request.targetMessageId,
        }
      )
    },
    async send(request, signal) {
      signal.throwIfAborted()
      sendCalls += 1
      const result = {
        status: 'found',
        accountId: request.accountId,
        identityType: request.identityType,
        idempotencyKey: request.idempotencyKey,
        targetMessageId: request.targetMessageId,
        messageId: 'om_synthetic_sent_reply',
        sentAt: options.sentAt ?? '2026-08-27T08:07:00.000Z',
      }
      if (options.sendFailure === 'network') {
        remote.set(request.idempotencyKey, result)
        throw new FeishuReplyExecutionClientError('network')
      }
      if (options.sendFailure === 'rate_limited') {
        throw new FeishuReplyExecutionClientError('rate_limited')
      }
      if (options.sendFailure === 'scope_missing') {
        throw new FeishuReplyExecutionClientError('scope_missing')
      }
      if (options.sendFailure === 'invalid_response') {
        return { status: 'found', privatePayload: 'synthetic-private-response' }
      }
      remote.set(request.idempotencyKey, result)
      return result
    },
    diagnostics() {
      return { reconcileCalls, sendCalls }
    },
  }
}

/**
 * @param {{ sendFailure?: 'network' | 'preflight_unavailable' | 'rate_limited' | 'credential_reauthorization_required' | 'credential_rotation_uncertain' }} [options]
 * @returns {Pick<import('../packages/plugin-feishu/src/reply-execution.ts').FeishuReplyExecutionClient, 'send'> & {
 *   diagnostics(): { sendCalls: number }
 * }}
 */
function sendOnlyReplyClient(options = {}) {
  let sendCalls = 0
  return {
    async send(request, signal) {
      signal.throwIfAborted()
      sendCalls += 1
      if (options.sendFailure === 'network') {
        throw new FeishuReplyExecutionClientError('network')
      }
      if (options.sendFailure === 'rate_limited') {
        throw new FeishuReplyExecutionClientError('rate_limited')
      }
      if (options.sendFailure === 'preflight_unavailable') {
        throw new FeishuReplyExecutionClientError('preflight_unavailable')
      }
      if (options.sendFailure === 'credential_reauthorization_required') {
        throw new FeishuReplyExecutionClientError('credential_reauthorization_required')
      }
      if (options.sendFailure === 'credential_rotation_uncertain') {
        throw new FeishuReplyExecutionClientError('credential_rotation_uncertain')
      }
      return {
        status: 'found',
        accountId: request.accountId,
        identityType: request.identityType,
        idempotencyKey: request.idempotencyKey,
        targetMessageId: request.targetMessageId,
        messageId: 'om_synthetic_send_only_reply',
        sentAt: '2026-08-27T08:07:00.000Z',
      }
    },
    diagnostics() {
      return { sendCalls }
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
  for (const operation of [
    () => database.beginActionExecution(/** @type {never} */ ({})),
    () => database.reserveActionDispatch(/** @type {never} */ ({})),
    () => database.getLatestActionDispatch(/** @type {never} */ ('missing-attempt')),
    () => database.recordActionExecutionReceipt(/** @type {never} */ ({})),
    () => database.getActionExecutionReceipt(/** @type {never} */ ('missing-attempt')),
    () => database.recoverActionExecution(/** @type {never} */ ({})),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof ActionExecutionStateError && error.code === 'database_closed',
    )
  }
})

test('execution without a durable dispatch coordinator never calls send', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-no-dispatch')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient()
  const receipt = await new FeishuReplyExecutor(configuration(), client, clock.options).execute(
    action,
    new AbortController().signal,
  )
  assert.equal(receipt.outcome, 'uncertain')
  assert.equal(receipt.error.code, 'feishu_dispatch_unavailable')
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 1, sendCalls: 0 })
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId), undefined)
  database.close()
})

test('a send-only client may send once only after its first durable reservation', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-send-only')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = sendOnlyReplyClient()
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'succeeded')
  assert.deepEqual(client.diagnostics(), { sendCalls: 1 })
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.ordinal, 1)
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt,
  })
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  assert.equal(database.getActionProposal(action.proposal.id)?.state, 'succeeded')
  assert.equal(
    database.getLatestActionDispatch(action.executionAttemptId)?.settlement?.outcome,
    'succeeded',
  )
  assert.deepEqual(client.diagnostics(), { sendCalls: 1 })
  database.close()
})

test('a send-only client never resends an existing dispatch and reports unsupported reconciliation', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-send-only-blocked')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  database.reserveActionDispatch({
    kind: 'action_dispatch_reservation',
    schemaVersion: 1,
    action,
    reservedAt: EXECUTION_AT,
  })
  const client = sendOnlyReplyClient()
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  const blocked = await executor.execute(action, new AbortController().signal)
  assert.equal(blocked.outcome, 'uncertain')
  assert.equal(blocked.error.code, 'feishu_dispatch_already_reserved')
  assert.equal(blocked.error.retryable, false)
  assert.deepEqual(client.diagnostics(), { sendCalls: 0 })

  const unsupported = await executor.reconcile(action, new AbortController().signal)
  assert.equal(unsupported.outcome, 'uncertain')
  assert.equal(unsupported.error.code, 'feishu_reconciliation_unsupported')
  assert.equal(unsupported.error.retryable, false)
  assert.deepEqual(client.diagnostics(), { sendCalls: 0 })
  database.close()
})

test('a send-only network ambiguity is non-retryable and remains blocked after restart', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-send-only-network')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = sendOnlyReplyClient({ sendFailure: 'network' })
  const uncertain = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(uncertain.outcome, 'uncertain')
  assert.equal(uncertain.error.code, 'feishu_send_network')
  assert.equal(uncertain.error.retryable, false)
  assert.deepEqual(client.diagnostics(), { sendCalls: 1 })
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt: uncertain,
  })
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  const recovered = database.recoverActionExecution({
    kind: 'action_execution_recovery_request',
    schemaVersion: 1,
    approvalId: action.approval.id,
    proposalId: action.proposal.id,
    executionAttemptId: action.executionAttemptId,
  })
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action: recovered.action,
    startedAt: EXECUTION_AT,
  })
  const blocked = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(recovered.action, new AbortController().signal)
  assert.equal(blocked.outcome, 'uncertain')
  assert.equal(blocked.error.code, 'feishu_dispatch_already_reserved')
  assert.equal(blocked.error.retryable, false)
  assert.deepEqual(client.diagnostics(), { sendCalls: 1 })
  database.close()
})

test('a hostile reconciliation capability fails before reservation without exposing its error', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-hostile-reconcile')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  let sendCalls = 0
  const client = {
    async send() {
      sendCalls += 1
    },
  }
  let accessorCalls = 0
  Object.defineProperty(client, 'reconcile', {
    enumerable: true,
    get() {
      accessorCalls += 1
      throw new Error('synthetic-private-reconciliation-error')
    },
  })
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    /** @type {any} */ (client),
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'uncertain')
  assert.equal(receipt.error.code, 'feishu_reconciliation_invalid_response')
  assert.equal(JSON.stringify(receipt).includes('synthetic-private-reconciliation-error'), false)
  assert.equal(accessorCalls, 0)
  assert.equal(sendCalls, 0)
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId), undefined)
  database.close()
})

test('cancellation during reconciliation capability inspection never reserves or sends', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-capability-cancelled')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const controller = new AbortController()
  let sendCalls = 0
  const client = new Proxy(
    {
      async send() {
        sendCalls += 1
      },
    },
    {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'reconcile') controller.abort()
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    },
  )
  const executor = new FeishuReplyExecutor(
    configuration(),
    /** @type {any} */ (client),
    executionOptions(clock, database),
  )
  await assert.rejects(executor.execute(action, controller.signal), { name: 'AbortError' })
  assert.equal(sendCalls, 0)
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId), undefined)
  database.close()
})

test('a hostile preparation capability fails before reservation without invoking its accessor', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-hostile-prepare')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  let accessorCalls = 0
  let sendCalls = 0
  const client = {
    async send() {
      sendCalls += 1
    },
  }
  Object.defineProperty(client, 'prepare', {
    get() {
      accessorCalls += 1
      throw new Error('synthetic-private-preparation-error')
    },
  })
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    /** @type {any} */ (client),
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'failed')
  assert.equal(receipt.error.code, 'feishu_send_invalid_response')
  assert.equal(JSON.stringify(receipt).includes('synthetic-private-preparation-error'), false)
  assert.equal(accessorCalls, 0)
  assert.equal(sendCalls, 0)
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId), undefined)
  database.close()
})

test('a durable dispatch reservation survives restart and blocks an unproven resend', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-dispatch-restart')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const reserved = database.reserveActionDispatch({
    kind: 'action_dispatch_reservation',
    schemaVersion: 1,
    action,
    reservedAt: EXECUTION_AT,
  })
  assert.equal(reserved.disposition, 'reserved')
  assert.equal(reserved.dispatch.ordinal, 1)
  assert.equal(reserved.dispatch.settlement, undefined)
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  const recovered = database.recoverActionExecution({
    kind: 'action_execution_recovery_request',
    schemaVersion: 1,
    approvalId: action.approval.id,
    proposalId: action.proposal.id,
    executionAttemptId: action.executionAttemptId,
  })
  const client = replyClient()
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(recovered.action, new AbortController().signal)
  assert.equal(receipt.outcome, 'uncertain')
  assert.equal(receipt.error.code, 'feishu_dispatch_already_reserved')
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 1, sendCalls: 0 })
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action: recovered.action,
    receipt,
  })
  assert.equal(
    database.getLatestActionDispatch(action.executionAttemptId)?.settlement?.outcome,
    'uncertain',
  )
  database.close()
})

test('cancellation after durable reservation leaves recoverable evidence and never sends', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-dispatch-cancelled')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient()
  const controller = new AbortController()
  const executor = new FeishuReplyExecutor(configuration(), client, {
    ...clock.options,
    async reserveDispatch(approvedAction, reservedAt) {
      const disposition = database.reserveActionDispatch({
        kind: 'action_dispatch_reservation',
        schemaVersion: 1,
        action: approvedAction,
        reservedAt,
      }).disposition
      controller.abort()
      return disposition
    },
  })
  await assert.rejects(executor.execute(action, controller.signal), { name: 'AbortError' })
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 1, sendCalls: 0 })
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.ordinal, 1)
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.settlement, undefined)
  database.close()
})

test('an approved Feishu reply sends once and persists an idempotent success receipt', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-success')
  const started = database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  assert.equal(started.proposal.state, 'executing')
  const client = replyClient()
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  const receipt = await executor.execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'succeeded')
  const stored = database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt,
  })
  assert.equal(stored.disposition, 'inserted')
  assert.equal(stored.proposal.state, 'succeeded')
  assert.equal(stored.storedReceipt.executionAttemptId, action.executionAttemptId)
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 1, sendCalls: 1 })
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  const reconciled = await executor.execute(action, new AbortController().signal)
  assert.equal(reconciled.outcome, 'succeeded')
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 2, sendCalls: 1 })
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action,
      receipt: reconciled,
    }).disposition,
    'duplicate',
  )
  assert.throws(
    () =>
      database.beginActionExecution({
        kind: 'action_execution_start',
        schemaVersion: 1,
        action,
        startedAt: EXECUTION_AT,
      }),
    (error) => error instanceof ActionExecutionStateError && error.code === 'execution_state',
  )
  database.close()
})

test('an uncertain send reconciles after restart without sending twice', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-uncertain')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient({ sendFailure: 'network' })
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  const uncertain = await executor.execute(action, new AbortController().signal)
  assert.equal(uncertain.outcome, 'uncertain')
  assert.equal(uncertain.retryDisposition, 'reconcile_first')
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action,
      receipt: uncertain,
    }).proposal.state,
    'uncertain',
  )
  database.close()

  database = openTwinDeskDatabase(path, clock.options)
  const recovery = database.recoverActionExecution({
    kind: 'action_execution_recovery_request',
    schemaVersion: 1,
    approvalId: action.approval.id,
    proposalId: action.proposal.id,
    executionAttemptId: action.executionAttemptId,
  })
  clock.set('2026-08-27T08:16:00.000Z')
  const reconciled = await executor.reconcile(recovery.action, new AbortController().signal)
  assert.equal(reconciled.outcome, 'succeeded')
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action: recovery.action,
      receipt: reconciled,
    }).disposition,
    'updated',
  )
  assert.equal(database.getActionProposal(action.proposal.id)?.state, 'succeeded')
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 2, sendCalls: 1 })
  database.close()
})

test('a known retryable rejection permits one new same-key dispatch reservation', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-dispatch-retry')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = sendOnlyReplyClient({ sendFailure: 'rate_limited' })
  const first = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(first.outcome, 'failed')
  assert.equal(first.retryDisposition, 'retry_same_key')
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt: first,
  })
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.ordinal, 1)

  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const second = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(second.outcome, 'failed')
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.ordinal, 2)
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action,
      receipt: second,
    }).disposition,
    'updated',
  )
  assert.equal(
    database.getLatestActionDispatch(action.executionAttemptId)?.settlement?.outcome,
    'failed',
  )
  assert.deepEqual(client.diagnostics(), { sendCalls: 2 })
  database.close()
})

test('a preflight failure settles before-send evidence and permits a same-key retry', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-preflight-retry')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = sendOnlyReplyClient({ sendFailure: 'preflight_unavailable' })
  const first = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(first.outcome, 'failed')
  assert.equal(first.error.code, 'feishu_preflight_unavailable')
  assert.equal(first.error.retryable, true)
  assert.equal(first.retryDisposition, 'retry_same_key')
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt: first,
  })

  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const second = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(second.outcome, 'failed')
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.ordinal, 2)
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt: second,
  })
  assert.equal(
    database.getLatestActionDispatch(action.executionAttemptId)?.settlement?.retryDisposition,
    'retry_same_key',
  )
  assert.deepEqual(client.diagnostics(), { sendCalls: 2 })
  database.close()
})

test('User credential recovery failures are terminal reply receipts with no blind retry', async (context) => {
  const scenarios = [
    {
      clientCode: 'credential_reauthorization_required',
      receiptCode: 'feishu_credential_reauthorization_required',
    },
    {
      clientCode: 'credential_rotation_uncertain',
      receiptCode: 'feishu_credential_rotation_uncertain',
    },
  ]
  for (const [index, scenario] of scenarios.entries()) {
    const path = await temporaryDatabase(context)
    const clock = policyClock()
    const database = openTwinDeskDatabase(path, clock.options)
    const { action } = await approveAction(database, clock, `credential-recovery-${index}`)
    database.beginActionExecution({
      kind: 'action_execution_start',
      schemaVersion: 1,
      action,
      startedAt: EXECUTION_AT,
    })
    const client = sendOnlyReplyClient()
    Object.defineProperty(client, 'prepare', {
      value: async () => {
        throw new FeishuReplyExecutionClientError(
          /** @type {'credential_reauthorization_required' | 'credential_rotation_uncertain'} */ (
            scenario.clientCode
          ),
        )
      },
    })
    const receipt = await new FeishuReplyExecutor(
      configuration(),
      client,
      executionOptions(clock, database),
    ).execute(action, new AbortController().signal)
    assert.equal(receipt.outcome, 'failed')
    assert.equal(receipt.error.code, scenario.receiptCode)
    assert.equal(receipt.error.retryable, false)
    assert.equal(receipt.retryDisposition, 'do_not_retry')
    assert.deepEqual(client.diagnostics(), { sendCalls: 0 })
    assert.equal(database.getLatestActionDispatch(action.executionAttemptId), undefined)
    assert.equal(
      database.recordActionExecutionReceipt({
        kind: 'action_execution_receipt_write',
        schemaVersion: 1,
        action,
        receipt,
      }).proposal.state,
      'failed',
    )
    database.close()
  }
})

test('a failed reconciliation never calls send and expired approval cannot restart execution', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-reconcile-failure')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient({ reconcileFailure: true })
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  const uncertain = await executor.execute(action, new AbortController().signal)
  assert.equal(uncertain.outcome, 'uncertain')
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 1, sendCalls: 0 })
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action,
    receipt: uncertain,
  })
  clock.set('2026-08-27T08:16:00.000Z')
  await assert.rejects(
    executor.execute(action, new AbortController().signal),
    (error) => error instanceof Error && error.name === 'FeishuReplyExecutionError',
  )
  assert.throws(
    () =>
      database.beginActionExecution({
        kind: 'action_execution_start',
        schemaVersion: 1,
        action,
        startedAt: RECOVERY_AT,
      }),
    (error) => error instanceof ActionExecutionStateError && error.code === 'approval_expired',
  )
  database.close()
})

test('a malformed post-send response becomes an uncertain payload-free receipt', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-invalid-response')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient({ sendFailure: 'invalid_response' })
  const executor = new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  )
  const receipt = await executor.execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'uncertain')
  assert.equal(receipt.retryDisposition, 'reconcile_first')
  assert.equal(JSON.stringify(receipt).includes('synthetic-private-response'), false)
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action,
      receipt,
    }).proposal.state,
    'uncertain',
  )
  database.close()
})

test('a missing send scope is terminal and does not expose adapter data', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-scope')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const client = replyClient({ sendFailure: 'scope_missing' })
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    client,
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  assert.equal(receipt.outcome, 'failed')
  assert.equal(receipt.retryDisposition, 'do_not_retry')
  assert.equal(receipt.error.code, 'feishu_send_scope_missing')
  assert.equal(JSON.stringify(receipt).includes('credentialReference'), false)
  assert.equal(
    database.recordActionExecutionReceipt({
      kind: 'action_execution_receipt_write',
      schemaVersion: 1,
      action,
      receipt,
    }).proposal.state,
    'failed',
  )
  database.close()
})

test('principal or credential rotation invalidates the approved reply before client access', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-identity-rotation')
  const original = configuration()
  const rotated = {
    ...original,
    user: {
      ...original.user,
      principalId: 'ou_synthetic_rotated_user',
      credentialReference: {
        ...original.user.credentialReference,
        id: 'secret-ref:synthetic-approval-user-rotated',
      },
    },
  }
  const client = replyClient()
  await assert.rejects(
    new FeishuReplyExecutor(rotated, client, executionOptions(clock, database)).execute(
      action,
      new AbortController().signal,
    ),
    (error) =>
      error instanceof Error &&
      error.name === 'FeishuReplyExecutionError' &&
      !error.message.includes('ou_synthetic_rotated_user'),
  )
  assert.deepEqual(client.diagnostics(), { reconcileCalls: 0, sendCalls: 0 })
  database.close()
})

test('stale remote chronology and mismatched success identities fail closed', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  const database = openTwinDeskDatabase(path, clock.options)
  const stale = await approveAction(database, clock, 'execution-stale-remote')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action: stale.action,
    startedAt: EXECUTION_AT,
  })
  const staleReceipt = await new FeishuReplyExecutor(
    configuration(),
    replyClient({ sentAt: '2026-08-27T08:00:00.000Z' }),
    executionOptions(clock, database),
  ).execute(stale.action, new AbortController().signal)
  assert.equal(staleReceipt.outcome, 'uncertain')
  assert.equal(staleReceipt.retryDisposition, 'reconcile_first')

  const mismatched = await approveAction(database, clock, 'execution-receipt-identity')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action: mismatched.action,
    startedAt: EXECUTION_AT,
  })
  const success = await new FeishuReplyExecutor(
    configuration(),
    replyClient(),
    executionOptions(clock, database),
  ).execute(mismatched.action, new AbortController().signal)
  assert.equal(success.outcome, 'succeeded')
  assert.throws(
    () =>
      database.recordActionExecutionReceipt({
        kind: 'action_execution_receipt_write',
        schemaVersion: 1,
        action: mismatched.action,
        receipt: {
          ...success,
          externalReference: {
            ...success.externalReference,
            accountId: 'feishu-account:other-synthetic',
          },
        },
      }),
    (error) => error instanceof ActionExecutionStateError && error.code === 'binding_mismatch',
  )
  assert.equal(database.getActionExecutionReceipt(mismatched.action.executionAttemptId), undefined)
  assert.equal(database.getActionProposal(mismatched.action.proposal.id)?.state, 'executing')
  database.close()
})

test('an interrupted receipt write rolls back the receipt and proposal state together', async (context) => {
  const path = await temporaryDatabase(context)
  const clock = policyClock()
  let database = openTwinDeskDatabase(path, clock.options)
  const { action } = await approveAction(database, clock, 'execution-interrupted')
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action,
    startedAt: EXECUTION_AT,
  })
  const receipt = await new FeishuReplyExecutor(
    configuration(),
    replyClient(),
    executionOptions(clock, database),
  ).execute(action, new AbortController().signal)
  database.close()
  const injector = new DatabaseSync(path)
  injector.exec(`
    CREATE TRIGGER synthetic_receipt_failure
    BEFORE UPDATE OF state ON action_proposals
    WHEN NEW.state = 'succeeded'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic receipt interruption');
    END;
  `)
  injector.close()

  database = openTwinDeskDatabase(path, clock.options)
  assert.throws(
    () =>
      database.recordActionExecutionReceipt({
        kind: 'action_execution_receipt_write',
        schemaVersion: 1,
        action,
        receipt,
      }),
    (error) =>
      error instanceof ActionExecutionStateError &&
      error.code === 'storage_error' &&
      !error.message.includes('synthetic receipt interruption'),
  )
  assert.equal(database.getActionExecutionReceipt(action.executionAttemptId), undefined)
  assert.equal(database.getLatestActionDispatch(action.executionAttemptId)?.settlement, undefined)
  assert.equal(database.getActionProposal(action.proposal.id)?.state, 'executing')
  database.close()
})
