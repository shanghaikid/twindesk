import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseDraft, parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import {
  FeishuIdentityConfigurationStore,
  FeishuMessageNormalizer,
} from '../packages/plugin-feishu/dist/index.js'
import {
  computeApprovalExecutionAttemptId,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'
import {
  createWorkbenchFeishuReplyApprovalController,
  createWorkbenchFeishuReplyExecutionController,
  createWorkbenchFeishuReplyProposalController,
  WorkbenchFeishuReplyApprovalError,
  WorkbenchFeishuReplyProposalError,
} from '../packages/bundle-workbench/dist/index.js'

const ACCOUNT_ID = 'feishu-account:synthetic-product-preview'
const APP_ID = 'cli_synthetic_product_preview'
const TENANT_KEY = 'tenant_synthetic_product_preview'
const BOT_PRINCIPAL = 'ou_synthetic_product_preview_bot'
const USER_PRINCIPAL = 'ou_synthetic_product_preview_user'
const MESSAGE_ID = 'om_synthetic_product_preview_target'

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Preview Bot',
      principalId: BOT_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-product-preview-bot',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    user: {
      identityType: 'user',
      displayName: 'Synthetic Preview User',
      principalId: USER_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-product-preview-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} database */
function seedReadyDraft(database) {
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const batch = normalizer.normalizeBotMessage(
    /** @type {any} */ ({
      kind: 'feishu_bot_message_event',
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      botPrincipalId: BOT_PRINCIPAL,
      deliveryEventId: 'evt_synthetic_product_preview',
      messageId: MESSAGE_ID,
      chatId: 'oc_synthetic_product_preview_chat',
      chatType: 'p2p',
      visibility: 'direct_message',
      senderPrincipalId: 'ou_synthetic_product_preview_sender',
      messageType: 'text',
      sourceCreateTime: String(Date.parse('2026-09-02T09:00:00.000Z')),
      content: { text: 'Can the synthetic rollout proceed?' },
      mentions: [],
    }),
    '2026-09-02T09:01:00.000Z',
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
  assert.ok(workItem)
  database.applyWorkItemUserAction(
    /** @type {any} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'action-synthetic-product-preview-persona',
        workItemId: workItem.id,
        revision: 1,
        action: 'select_persona',
        personaId: 'communication',
        occurredAt: '2026-09-02T09:02:00.000Z',
      })
    ),
  )
  const draft = parseDraft({
    kind: 'draft',
    schemaVersion: 1,
    id: 'draft-synthetic-product-preview',
    workItemId: workItem.id,
    personaId: 'communication',
    revision: 1,
    state: 'ready_for_review',
    content: {
      mediaType: 'text/plain',
      text: 'The synthetic rollout can proceed after the final health check.',
    },
    rationale: 'Edited locally for exact preview.',
    createdAt: '2026-09-02T09:03:00.000Z',
    updatedAt: '2026-09-02T09:03:00.000Z',
  })
  database.createDraft(/** @type {any} */ (draft))
  return { workItem, draft }
}

test('Workbench creates one exact User reply preview and recovers it across restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-preview-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'twindesk.sqlite3')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  let database = openTwinDeskDatabase(databasePath)
  context.after(() => database.isOpen && database.close())
  const { workItem, draft } = seedReadyDraft(database)
  let controller = createWorkbenchFeishuReplyProposalController({
    database,
    identityStore,
    now: () => Date.parse('2026-09-02T09:04:00.000Z'),
  })
  assert.deepEqual(await controller.read(), {
    version: 1,
    capability: 'ready',
    actionType: 'feishu.reply',
  })
  const request = { version: /** @type {const} */ (1), workItemId: workItem.id, draftRevision: 1 }
  const first = /** @type {any} */ (await controller.create(request, new AbortController().signal))
  const replay = /** @type {any} */ (await controller.create(request, new AbortController().signal))
  assert.equal(first.disposition, 'created')
  assert.equal(replay.disposition, 'recovered')
  assert.equal(first.approvalAvailable, false)
  assert.equal(first.executionAvailable, false)
  assert.equal(first.proposal.state, 'proposed')
  assert.equal(first.proposal.risk, 'write')
  assert.equal(first.proposal.identity.identityType, 'user')
  assert.equal(first.proposal.identity.displayName, 'Synthetic Preview User')
  assert.equal(first.proposal.target.externalId, MESSAGE_ID)
  assert.equal(first.proposal.content.text, draft.content.text)
  assert.deepEqual(replay.proposal, first.proposal)
  assert.doesNotMatch(JSON.stringify(first), new RegExp(USER_PRINCIPAL, 'u'))
  assert.doesNotMatch(JSON.stringify(first), /secret-ref/u)
  assert.deepEqual(database.getDraftByWorkItemRevision(workItem.id, 1), draft)

  database.close()
  database = openTwinDeskDatabase(databasePath)
  controller = createWorkbenchFeishuReplyProposalController({ database, identityStore })
  const restarted = /** @type {any} */ (
    await controller.create(request, new AbortController().signal)
  )
  assert.equal(restarted.disposition, 'recovered')
  assert.deepEqual(restarted.proposal, first.proposal)

  const inspection = new DatabaseSync(databasePath, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_proposals').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 0)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  inspection.close()
})

test('Workbench reply preview fails closed for stale Drafts, missing User identity, and cancellation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-preview-fail-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const database = openTwinDeskDatabase(join(root, 'twindesk.sqlite3'))
  context.after(() => database.close())
  const { workItem } = seedReadyDraft(database)
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  const { user: _user, ...withoutUser } = configuration()
  await identityStore.write(withoutUser)
  const unavailable = createWorkbenchFeishuReplyProposalController({ database, identityStore })
  assert.equal(/** @type {any} */ (await unavailable.read()).capability, 'unavailable')
  await assert.rejects(
    unavailable.create(
      { version: 1, workItemId: workItem.id, draftRevision: 1 },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError && error.code === 'connector_unavailable',
  )

  await identityStore.write(configuration())
  const controller = createWorkbenchFeishuReplyProposalController({ database, identityStore })
  await assert.rejects(
    controller.create(
      { version: 1, workItemId: workItem.id, draftRevision: 2 },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError && error.code === 'target_unavailable',
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    controller.create({ version: 1, workItemId: workItem.id, draftRevision: 1 }, cancelled.signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError && error.code === 'runtime_unavailable',
  )

  let getterCalls = 0
  const hostileDatabase = Object.defineProperty({}, 'getWorkItem', {
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-hostile-proposal-database')
    },
  })
  assert.throws(
    () =>
      createWorkbenchFeishuReplyProposalController(
        /** @type {any} */ ({ database: hostileDatabase, identityStore }),
      ),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError &&
      error.code === 'invalid_options' &&
      !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})

test('Workbench repairs an interrupted proposal Audit without creating another proposal', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-preview-audit-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'twindesk.sqlite3')
  const database = openTwinDeskDatabase(databasePath)
  context.after(() => database.close())
  const { workItem } = seedReadyDraft(database)
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  let auditAttempts = 0
  const interruptedDatabase = {
    /** @param {any} records */
    appendAuditRecords(records) {
      auditAttempts += 1
      if (auditAttempts === 1) throw new Error('synthetic-private-proposal-audit-interruption')
      return database.appendAuditRecords(records)
    },
    createActionProposal: database.createActionProposal.bind(database),
    getActionProposal: database.getActionProposal.bind(database),
    getDraftByWorkItemRevision: database.getDraftByWorkItemRevision.bind(database),
    getThread: database.getThread.bind(database),
    getWorkItem: database.getWorkItem.bind(database),
  }
  const controller = createWorkbenchFeishuReplyProposalController(
    /** @type {any} */ ({
      database: interruptedDatabase,
      identityStore,
      now: () => Date.parse('2026-09-02T09:04:00.000Z'),
    }),
  )
  const request = {
    version: /** @type {const} */ (1),
    workItemId: workItem.id,
    draftRevision: 1,
  }
  await assert.rejects(
    controller.create(request, new AbortController().signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError &&
      error.code === 'runtime_unavailable' &&
      !error.message.includes('synthetic-private'),
  )
  const repaired = /** @type {any} */ (
    await controller.create(request, new AbortController().signal)
  )
  assert.equal(repaired.disposition, 'repaired')
  assert.equal(auditAttempts, 2)
  const inspection = new DatabaseSync(databasePath, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_proposals').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 1)
  inspection.close()
})

test('Workbench requests and grants exact one-time approval across restart without execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-approval-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'twindesk.sqlite3')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  let nowMs = Date.parse('2026-09-02T09:04:00.000Z')
  let database = openTwinDeskDatabase(databasePath, { now: () => nowMs })
  context.after(() => database.isOpen && database.close())
  const { workItem, draft } = seedReadyDraft(database)
  let proposalController = createWorkbenchFeishuReplyProposalController({
    database,
    identityStore,
    now: () => nowMs,
  })
  const request = { version: /** @type {const} */ (1), workItemId: workItem.id, draftRevision: 1 }
  await proposalController.create(request, new AbortController().signal)
  let approvalController = createWorkbenchFeishuReplyApprovalController({
    database,
    proposalController,
    now: () => nowMs,
  })
  assert.deepEqual(await approvalController.read(), {
    version: 1,
    capability: 'ready',
    actionType: 'feishu.reply',
    ttlSeconds: 900,
  })

  nowMs = Date.parse('2026-09-02T09:05:00.000Z')
  const pending = /** @type {any} */ (
    await approvalController.request(request, new AbortController().signal)
  )
  const replay = /** @type {any} */ (
    await approvalController.request(request, new AbortController().signal)
  )
  assert.equal(pending.operation, 'request')
  assert.equal(pending.disposition, 'applied')
  assert.equal(replay.disposition, 'recovered')
  assert.equal(pending.approval.decision, 'pending')
  assert.equal(pending.approval.requestedAt, '2026-09-02T09:05:00.000Z')
  assert.equal(pending.approval.expiresAt, '2026-09-02T09:20:00.000Z')
  assert.equal(pending.proposal.state, 'awaiting_approval')
  assert.equal(pending.proposal.identity.displayName, 'Synthetic Preview User')
  assert.equal(pending.proposal.target.externalId, MESSAGE_ID)
  assert.equal(pending.proposal.content.text, draft.content.text)
  assert.equal(pending.executionAvailable, false)
  await assert.rejects(
    proposalController.create(request, new AbortController().signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyProposalError && error.code === 'target_unavailable',
  )

  database.close()
  database = openTwinDeskDatabase(databasePath, { now: () => nowMs })
  proposalController = createWorkbenchFeishuReplyProposalController({ database, identityStore })
  approvalController = createWorkbenchFeishuReplyApprovalController({
    database,
    proposalController,
    now: () => nowMs,
  })
  const restarted = /** @type {any} */ (
    await approvalController.request(request, new AbortController().signal)
  )
  assert.equal(restarted.disposition, 'recovered')
  assert.deepEqual(restarted.approval, pending.approval)

  nowMs = Date.parse('2026-09-02T09:06:00.000Z')
  const decision = { ...request, decision: /** @type {const} */ ('approved') }
  const approved = /** @type {any} */ (
    await approvalController.decide(decision, new AbortController().signal)
  )
  const approvedReplay = /** @type {any} */ (
    await approvalController.decide(decision, new AbortController().signal)
  )
  assert.equal(approved.operation, 'decision')
  assert.equal(approved.disposition, 'applied')
  assert.equal(approvedReplay.disposition, 'recovered')
  assert.equal(approved.approval.decision, 'approved')
  assert.equal(approved.approval.decidedAt, '2026-09-02T09:06:00.000Z')
  assert.equal(approved.proposal.state, 'approved')
  assert.equal(approved.executionAvailable, false)
  const serialized = JSON.stringify(approved)
  assert.doesNotMatch(serialized, new RegExp(USER_PRINCIPAL, 'u'))
  assert.doesNotMatch(serialized, /secret-ref|contentDigest|approvalId|responderUserId/u)

  const inspection = new DatabaseSync(databasePath, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 1)
  assert.equal(
    inspection.prepare('SELECT decision FROM approval_records').get()?.decision,
    'approved',
  )
  assert.equal(
    inspection.prepare('SELECT consumed_at FROM approval_records').get()?.consumed_at,
    null,
  )
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 3)
  inspection.close()
})

test('Workbench executes only the exact approved reply through Host-owned identities', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-execution-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  let nowMs = Date.parse('2026-09-02T09:04:00.000Z')
  const database = openTwinDeskDatabase(join(root, 'twindesk.sqlite3'), { now: () => nowMs })
  context.after(() => database.close())
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  const { workItem } = seedReadyDraft(database)
  const proposalController = createWorkbenchFeishuReplyProposalController({
    database,
    identityStore,
    now: () => nowMs,
  })
  const request = { version: /** @type {const} */ (1), workItemId: workItem.id, draftRevision: 1 }
  await proposalController.create(request, new AbortController().signal)
  const approvalController = createWorkbenchFeishuReplyApprovalController({
    database,
    proposalController,
    now: () => nowMs,
  })
  nowMs = Date.parse('2026-09-02T09:05:00.000Z')
  await approvalController.request(request, new AbortController().signal)

  let hostCalls = 0
  let returnInvalidAttemptId = true
  /** @type {any} */
  let lastHostRequest
  const controller = createWorkbenchFeishuReplyExecutionController({
    database,
    identityStore,
    proposalController,
    createHost(executionConfiguration) {
      assert.equal(executionConfiguration.bot, undefined)
      assert.equal(executionConfiguration.user?.principalId, USER_PRINCIPAL)
      return /** @type {any} */ ({
        /** @param {any} hostRequest @param {AbortSignal} signal */
        async execute(hostRequest, signal) {
          signal.throwIfAborted()
          hostCalls += 1
          lastHostRequest = hostRequest
          const proposal = database.getActionProposal(/** @type {any} */ (hostRequest).proposalId)
          assert.ok(proposal)
          return {
            kind: 'work_hub_action_execution_result',
            schemaVersion: 1,
            executionAttemptId: returnInvalidAttemptId
              ? 'invalid-attempt'
              : computeApprovalExecutionAttemptId(hostRequest.approvalId),
            source: 'executed',
            receipt: {
              proposalId: proposal.id,
              connectorId: 'feishu',
              accountId: proposal.identity.accountId,
              idempotencyKey: proposal.idempotencyKey,
              outcome: 'succeeded',
              attemptedAt: '2026-09-02T09:06:30.000Z',
              externalReference: {
                connectorId: 'feishu',
                accountId: proposal.identity.accountId,
                objectType: 'message',
                externalId: 'om_synthetic_execution_result',
                sourceTimestamp: '2026-09-02T09:06:31.000Z',
              },
            },
            receiptDisposition: 'inserted',
            auditInsertedCount: 2,
            auditDuplicateCount: 0,
          }
        },
      })
    },
  })
  assert.deepEqual(await controller.read(), {
    version: 1,
    capability: 'ready',
    actionType: 'feishu.reply',
  })
  await assert.rejects(controller.execute(request, new AbortController().signal), {
    code: 'approval_unavailable',
  })
  await approvalController.decide(
    { ...request, decision: 'approved' },
    new AbortController().signal,
  )
  await assert.rejects(controller.execute(request, new AbortController().signal), {
    code: 'execution_unavailable',
  })
  returnInvalidAttemptId = false
  const result = /** @type {any} */ (
    await controller.execute(request, new AbortController().signal)
  )
  assert.equal(hostCalls, 2)
  assert.equal(lastHostRequest.kind, 'work_hub_action_execution_request')
  assert.equal(lastHostRequest.schemaVersion, 1)
  assert.match(lastHostRequest.approvalId, /^approval-feishu-reply-/u)
  assert.match(lastHostRequest.proposalId, /^proposal-feishu-reply-/u)
  assert.equal(result.execution.outcome, 'succeeded')
  assert.equal(result.execution.externalReference.externalId, 'om_synthetic_execution_result')
  assert.equal(result.proposal.identity.displayName, 'Synthetic Preview User')
  assert.equal(result.proposal.target.externalId, MESSAGE_ID)
  assert.equal(
    result.proposal.content.text,
    'The synthetic rollout can proceed after the final health check.',
  )
  assert.doesNotMatch(
    JSON.stringify(result),
    /approvalId|proposalId|idempotency|execution-attempt|secret-ref/u,
  )
  await assert.rejects(
    controller.execute(
      /** @type {any} */ ({ ...request, approvalId: 'forged' }),
      new AbortController().signal,
    ),
    { code: 'invalid_request' },
  )
  assert.equal(hostCalls, 2)
})

for (const decision of /** @type {const} */ (['rejected', 'cancelled', 'expired'])) {
  test(`Workbench records ${decision} without granting or consuming execution`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), `twindesk-workbench-reply-${decision}-`))
    context.after(() => rm(root, { recursive: true, force: true }))
    let nowMs = Date.parse('2026-09-02T09:04:00.000Z')
    const databasePath = join(root, 'twindesk.sqlite3')
    const database = openTwinDeskDatabase(databasePath, { now: () => nowMs })
    context.after(() => database.close())
    const { workItem } = seedReadyDraft(database)
    const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
    await identityStore.write(configuration())
    const proposalController = createWorkbenchFeishuReplyProposalController({
      database,
      identityStore,
      now: () => nowMs,
    })
    const request = {
      version: /** @type {const} */ (1),
      workItemId: workItem.id,
      draftRevision: 1,
    }
    await proposalController.create(request, new AbortController().signal)
    const approvalController = createWorkbenchFeishuReplyApprovalController({
      database,
      proposalController,
      now: () => nowMs,
    })
    nowMs = Date.parse('2026-09-02T09:05:00.000Z')
    await approvalController.request(request, new AbortController().signal)
    nowMs = Date.parse(
      decision === 'expired' ? '2026-09-02T09:20:00.001Z' : '2026-09-02T09:06:00.000Z',
    )
    const result = /** @type {any} */ (
      await approvalController.decide(
        { ...request, decision: decision === 'expired' ? 'approved' : decision },
        new AbortController().signal,
      )
    )
    assert.equal(result.approval.decision, decision)
    assert.equal(result.proposal.state, decision === 'rejected' ? 'rejected' : 'cancelled')
    assert.equal(result.executionAvailable, false)
    if (decision === 'expired') {
      const replay = /** @type {any} */ (
        await approvalController.decide(
          { ...request, decision: 'approved' },
          new AbortController().signal,
        )
      )
      assert.equal(replay.disposition, 'recovered')
      assert.equal(replay.approval.decision, 'expired')
    }
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(
      inspection.prepare('SELECT consumed_at FROM approval_records').get()?.consumed_at,
      null,
    )
    assert.equal(
      inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count,
      0,
    )
    const approvalAudits = inspection
      .prepare(
        `SELECT outcome, actor_type, details_json
         FROM audit_records WHERE category = 'approval' ORDER BY occurred_at, id`,
      )
      .all()
    assert.equal(approvalAudits.length, 3)
    assert.deepEqual(
      {
        outcome: approvalAudits[1]?.outcome,
        actorType: approvalAudits[1]?.actor_type,
        decision: JSON.parse(/** @type {string} */ (approvalAudits[1]?.details_json)).decision,
      },
      { outcome: 'pending', actorType: 'user', decision: 'pending' },
    )
    assert.deepEqual(
      {
        outcome: approvalAudits[2]?.outcome,
        actorType: approvalAudits[2]?.actor_type,
        decision: JSON.parse(/** @type {string} */ (approvalAudits[2]?.details_json)).decision,
      },
      {
        outcome: 'cancelled',
        actorType: decision === 'expired' ? 'system' : 'user',
        decision,
      },
    )
    inspection.close()
  })
}

test('Workbench approval fails closed on changed decisions and hostile inputs', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-approval-fail-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  let nowMs = Date.parse('2026-09-02T09:04:00.000Z')
  const database = openTwinDeskDatabase(join(root, 'twindesk.sqlite3'), { now: () => nowMs })
  context.after(() => database.close())
  const { workItem } = seedReadyDraft(database)
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  const proposalController = createWorkbenchFeishuReplyProposalController({
    database,
    identityStore,
    now: () => nowMs,
  })
  const request = { version: /** @type {const} */ (1), workItemId: workItem.id, draftRevision: 1 }
  await proposalController.create(request, new AbortController().signal)
  const approvalController = createWorkbenchFeishuReplyApprovalController({
    database,
    proposalController,
    now: () => nowMs,
  })
  nowMs = Date.parse('2026-09-02T09:05:00.000Z')
  await approvalController.request(request, new AbortController().signal)
  nowMs = Date.parse('2026-09-02T09:06:00.000Z')
  await approvalController.decide(
    { ...request, decision: 'rejected' },
    new AbortController().signal,
  )
  await assert.rejects(
    approvalController.decide({ ...request, decision: 'approved' }, new AbortController().signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyApprovalError && error.code === 'approval_unavailable',
  )
  await assert.rejects(
    approvalController.decide(
      /** @type {any} */ ({ ...request, decision: 'approved', responderUserId: 'attacker' }),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof WorkbenchFeishuReplyApprovalError && error.code === 'invalid_request',
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    approvalController.request(request, cancelled.signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyApprovalError && error.code === 'runtime_unavailable',
  )
})

test('Workbench repairs interrupted approval request and decision Audit after durable state', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-reply-approval-audit-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  let nowMs = Date.parse('2026-09-02T09:04:00.000Z')
  const databasePath = join(root, 'twindesk.sqlite3')
  const database = openTwinDeskDatabase(databasePath, { now: () => nowMs })
  context.after(() => database.close())
  const { workItem } = seedReadyDraft(database)
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(configuration())
  const proposalController = createWorkbenchFeishuReplyProposalController({
    database,
    identityStore,
    now: () => nowMs,
  })
  const request = { version: /** @type {const} */ (1), workItemId: workItem.id, draftRevision: 1 }
  await proposalController.create(request, new AbortController().signal)
  let auditAttempts = 0
  const interruptedDatabase = {
    /** @param {any} records */
    appendAuditRecords(records) {
      auditAttempts += 1
      if (auditAttempts === 1 || auditAttempts === 3) {
        throw new Error('synthetic-private-approval-audit-interruption')
      }
      return database.appendAuditRecords(records)
    },
    decideActionApproval: database.decideActionApproval.bind(database),
    getActionApproval: database.getActionApproval.bind(database),
    requestActionApproval: database.requestActionApproval.bind(database),
  }
  const approvalController = createWorkbenchFeishuReplyApprovalController(
    /** @type {any} */ ({
      database: interruptedDatabase,
      proposalController,
      now: () => nowMs,
    }),
  )
  nowMs = Date.parse('2026-09-02T09:05:00.000Z')
  await assert.rejects(
    approvalController.request(request, new AbortController().signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyApprovalError &&
      error.code === 'runtime_unavailable' &&
      !error.message.includes('synthetic-private'),
  )
  const repairedRequest = /** @type {any} */ (
    await approvalController.request(request, new AbortController().signal)
  )
  assert.equal(repairedRequest.disposition, 'repaired')

  nowMs = Date.parse('2026-09-02T09:06:00.000Z')
  const decision = { ...request, decision: /** @type {const} */ ('approved') }
  await assert.rejects(
    approvalController.decide(decision, new AbortController().signal),
    (error) =>
      error instanceof WorkbenchFeishuReplyApprovalError &&
      error.code === 'runtime_unavailable' &&
      !error.message.includes('synthetic-private'),
  )
  const repairedDecision = /** @type {any} */ (
    await approvalController.decide(decision, new AbortController().signal)
  )
  assert.equal(repairedDecision.disposition, 'repaired')
  assert.equal(repairedDecision.approval.decision, 'approved')
  assert.equal(auditAttempts, 4)
  const inspection = new DatabaseSync(databasePath, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 3)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  inspection.close()
})
