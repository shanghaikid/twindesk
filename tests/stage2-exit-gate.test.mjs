import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseAuditRecord,
  parseDraft,
  parseDraftStateTransition,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FeishuConnectorDiagnosticsService,
  FeishuContextRetriever,
  FeishuMessageNormalizer,
  FeishuReplyExecutor,
  FeishuReplyProposer,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'
import {
  ActionExecutionStateError,
  computeActionApprovalBindings,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').AuditRecord} SourceAuditRecord */
/** @typedef {import('../packages/domain/src/model.ts').Draft} SourceDraft */
/** @typedef {import('../packages/domain/src/model.ts').DraftStateTransition} SourceDraftStateTransition */
/** @typedef {import('../packages/domain/src/model.ts').IsoTimestamp} IsoTimestamp */
/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} SourceWorkItemUserAction */
/** @typedef {import('../packages/plugin-feishu/src/bot-event-consumer.ts').FeishuBotMessageEvent} FeishuBotMessageEvent */
/** @typedef {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} TwinDeskDatabase */

const ACCOUNT_ID = 'feishu-account:synthetic-stage2'
const APP_ID = 'cli_synthetic_stage2'
const TENANT_KEY = 'tenant_synthetic_stage2'
const BOT_PRINCIPAL = 'ou_synthetic_stage2_bot'
const USER_PRINCIPAL = 'ou_synthetic_stage2_user'
const MESSAGE_ID = 'om_synthetic_stage2_question'
const SOURCE_AT = '2026-08-27T08:00:00.000Z'
const INGESTED_AT = '2026-08-27T08:01:00.000Z'
const CONTEXT_AT = '2026-08-27T08:02:00.000Z'
const DRAFTED_AT = '2026-08-27T08:03:00.000Z'
const EDITED_AT = '2026-08-27T08:04:00.000Z'
const PROPOSED_AT = '2026-08-27T08:05:00.000Z'
const REQUESTED_AT = '2026-08-27T08:06:00.000Z'
const APPROVED_AT = '2026-08-27T08:07:00.000Z'
const CONSUMED_AT = '2026-08-27T08:08:00.000Z'
const EXECUTED_AT = '2026-08-27T08:09:00.000Z'
const EXPIRES_AT = '2026-08-27T08:16:00.000Z'

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Stage 2 Bot',
      principalId: BOT_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-stage2-bot',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    user: {
      identityType: 'user',
      displayName: 'Synthetic Stage 2 User',
      principalId: USER_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-stage2-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @returns {FeishuBotMessageEvent} */
function botMessage() {
  return /** @type {FeishuBotMessageEvent} */ ({
    kind: 'feishu_bot_message_event',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    botPrincipalId: BOT_PRINCIPAL,
    deliveryEventId: 'evt_synthetic_stage2_question',
    messageId: MESSAGE_ID,
    chatId: 'oc_synthetic_stage2_direct',
    chatType: 'p2p',
    visibility: 'direct_message',
    senderPrincipalId: 'ou_synthetic_stage2_sender',
    messageType: 'text',
    sourceCreateTime: String(Date.parse(SOURCE_AT)),
    content: { text: 'Can we confirm the synthetic rollout plan today?' },
    mentions: [],
  })
}

function clock(initial = REQUESTED_AT) {
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
  const root = await mkdtemp(join(tmpdir(), 'twindesk-stage2-exit-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

/** @param {unknown} value @returns {SourceAuditRecord} */
function audit(value) {
  return /** @type {SourceAuditRecord} */ (/** @type {unknown} */ (parseAuditRecord(value)))
}

/** @returns {import('../packages/plugin-feishu/src/connector-diagnostics.ts').FeishuConnectorDiagnosticsClient} */
function diagnosticsClient() {
  return {
    async inspectIdentity(request, signal) {
      signal.throwIfAborted()
      const sendScope =
        request.identityType === 'bot' ? 'im:message:send_as_bot' : 'im:message:send_as_user'
      return {
        kind: 'feishu_identity_probe_result',
        schemaVersion: 1,
        accountId: request.accountId,
        appId: request.appId,
        identityType: request.identityType,
        principalId: request.principalId,
        authorization: 'authorized',
        requiredScopes:
          request.identityType === 'user'
            ? [sendScope, 'im:chat:read', 'im:message:readonly']
            : [sendScope],
        grantedScopes:
          request.identityType === 'user'
            ? [sendScope, 'im:chat:read', 'im:message:readonly']
            : [sendScope],
        rateLimit: {
          status: 'available',
          limit: 100,
          remaining: 99,
          resetsAt: '2026-08-27T08:10:00.000Z',
        },
      }
    },
    async readCursors(request, signal) {
      signal.throwIfAborted()
      return {
        kind: 'feishu_cursor_probe_result',
        schemaVersion: 1,
        connectorId: request.connectorId,
        accountId: request.accountId,
        cursors: [],
      }
    },
  }
}

/**
 * @param {import('../packages/domain/src/model.ts').ExternalReference} reference
 * @returns {import('../packages/plugin-feishu/src/context-retrieval.ts').FeishuContextClient}
 */
function contextClient(reference) {
  return {
    async read(request, signal) {
      signal.throwIfAborted()
      return {
        kind: 'feishu_context_read_result',
        schemaVersion: 1,
        identityType: 'user',
        accountId: request.accountId,
        appId: request.appId,
        tenantKey: request.tenantKey,
        userPrincipalId: request.userPrincipalId,
        reference,
        status: 'complete',
        items: [
          {
            source: reference,
            title: 'Synthetic direct-message context',
            content: {
              kind: 'feishu_conversation_message_context',
              messageType: 'text',
              text: 'The synthetic rollout is staged and reversible.',
              deleted: false,
              edited: false,
              relation: 'anchor',
            },
            observedAt: CONTEXT_AT,
          },
        ],
        hasMoreConversation: false,
        problems: [],
        observedAt: CONTEXT_AT,
      }
    },
  }
}

/**
 * @returns {import('../packages/plugin-feishu/src/reply-execution.ts').FeishuReplyExecutionClient & {
 *   diagnostics(): { reconcileCalls: number, sendCalls: number, externalWrites: number }
 * }}
 */
function replyClient() {
  /** @type {Map<string, Record<string, unknown>>} */
  const remote = new Map()
  let reconcileCalls = 0
  let sendCalls = 0
  let externalWrites = 0
  return {
    async reconcile(request, signal) {
      signal.throwIfAborted()
      reconcileCalls += 1
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
      const existing = remote.get(request.idempotencyKey)
      if (existing !== undefined) return existing
      externalWrites += 1
      const sent = {
        status: 'found',
        accountId: request.accountId,
        identityType: request.identityType,
        idempotencyKey: request.idempotencyKey,
        targetMessageId: request.targetMessageId,
        messageId: 'om_synthetic_stage2_sent_reply',
        sentAt: EXECUTED_AT,
      }
      remote.set(request.idempotencyKey, sent)
      return sent
    },
    diagnostics() {
      return { reconcileCalls, sendCalls, externalWrites }
    },
  }
}

/**
 * @param {TwinDeskDatabase} database
 * @param {ReturnType<typeof clock>} policyClock
 * @param {ReturnType<typeof replyClient>} client
 */
async function completeLocalContractFlow(database, policyClock, client) {
  const identityConfiguration = configuration()
  const normalizer = new FeishuMessageNormalizer(identityConfiguration, TENANT_KEY)
  const batch = normalizer.normalizeBotMessage(botMessage(), INGESTED_AT, database)
  const committed = database.commitConnectorSyncBatch({
    connectorId: batch.connectorId,
    accountId: batch.accountId,
    stream: batch.stream,
    events: batch.events,
    projections: batch.projections,
  })
  const event = batch.events[0]
  const projection = batch.projections[0]
  assert.ok(event)
  assert.ok(projection)
  assert.equal(committed.ingestion.insertedCount, 1)
  assert.equal(projection.workItem.inboxState, 'needs_reply')

  const diagnostics = await new FeishuConnectorDiagnosticsService(
    identityConfiguration,
    diagnosticsClient(),
    { now: () => Date.parse(CONTEXT_AT) },
  ).diagnose(new AbortController().signal)
  assert.equal(diagnostics.health.status, 'healthy')
  assert.equal(diagnostics.cursors[0]?.status, 'not_started')

  const context = await new FeishuContextRetriever(
    identityConfiguration,
    contextClient(event.source),
    { tenantKey: TENANT_KEY },
  ).getContext(
    {
      reference: event.source,
      purpose: 'Prepare the Stage 2 synthetic acceptance reply.',
      maxItems: 5,
      before: /** @type {IsoTimestamp} */ (CONTEXT_AT),
    },
    new AbortController().signal,
  )
  assert.deepEqual(context.availability, { status: 'complete' })
  assert.equal(context.items.length, 1)

  database.applyWorkItemUserAction(
    /** @type {SourceWorkItemUserAction} */ (
      /** @type {unknown} */ (
        parseWorkItemUserAction({
          kind: 'work_item_user_action',
          schemaVersion: 1,
          id: 'action-stage2-select-communication',
          workItemId: projection.workItem.id,
          revision: 1,
          action: 'select_persona',
          personaId: 'communication',
          occurredAt: CONTEXT_AT,
        })
      )
    ),
  )

  const initialDraft = /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-stage2-initial',
        workItemId: projection.workItem.id,
        personaId: 'communication',
        revision: 1,
        state: 'editing',
        content: {
          mediaType: 'text/plain',
          text: 'The rollout looks good.',
        },
        rationale: 'Initial synthetic draft from bounded complete context.',
        createdAt: DRAFTED_AT,
        updatedAt: DRAFTED_AT,
      })
    )
  )
  database.createDraft(initialDraft)
  database.transitionDraft(
    /** @type {SourceDraftStateTransition} */ (
      /** @type {unknown} */ (
        parseDraftStateTransition({
          kind: 'draft_state_transition',
          schemaVersion: 1,
          id: 'transition-stage2-initial-superseded',
          draftId: initialDraft.id,
          fromState: 'editing',
          toState: 'superseded',
          occurredAt: EDITED_AT,
        })
      )
    ),
  )
  const finalDraft = /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-stage2-user-edited',
        workItemId: projection.workItem.id,
        personaId: 'communication',
        revision: 2,
        state: 'ready_for_review',
        content: {
          mediaType: 'text/plain',
          text: 'Confirmed: the synthetic rollout is staged and reversible. I can share the checkpoint results this afternoon.',
        },
        rationale: 'User-edited synthetic reply grounded in the bounded context item.',
        createdAt: EDITED_AT,
        updatedAt: EDITED_AT,
      })
    )
  )
  database.createDraft(finalDraft)

  const proposal = await new FeishuReplyProposer(identityConfiguration, {
    now: () => Date.parse(PROPOSED_AT),
    createNonce: () => 'stage2-closed-loop-acceptance',
  }).propose(
    {
      workItemId: projection.workItem.id,
      draftId: finalDraft.id,
      actionType: FEISHU_REPLY_ACTION_TYPE,
      identity: toFeishuActionIdentity(identityConfiguration, 'user'),
      target: event.source,
      content: finalDraft.content,
    },
    new AbortController().signal,
  )
  database.createActionProposal(proposal)

  policyClock.set(REQUESTED_AT)
  const pending = database.requestActionApproval({
    kind: 'action_approval_request',
    schemaVersion: 1,
    id: /** @type {import('../packages/domain/src/model.ts').ApprovalRecordId} */ (
      'approval-stage2-user-confirmation'
    ),
    proposalId: proposal.id,
    requestedAt: /** @type {IsoTimestamp} */ (REQUESTED_AT),
    expiresAt: /** @type {IsoTimestamp} */ (EXPIRES_AT),
  })
  const bindings = computeActionApprovalBindings(proposal)
  policyClock.set(APPROVED_AT)
  const approved = database.decideActionApproval({
    kind: 'action_approval_decision',
    schemaVersion: 1,
    approvalId: pending.approval.id,
    proposalId: proposal.id,
    decision: 'approved',
    ...bindings,
    decidedAt: /** @type {IsoTimestamp} */ (APPROVED_AT),
    responderUserId: 'user:synthetic-local-owner',
  })
  policyClock.set(CONSUMED_AT)
  const consumed = database.consumeActionApproval({
    kind: 'action_approval_consumption',
    schemaVersion: 1,
    approvalId: approved.approval.id,
    proposalId: proposal.id,
    ...bindings,
    consumedAt: /** @type {IsoTimestamp} */ (CONSUMED_AT),
  })
  policyClock.set(EXECUTED_AT)
  database.beginActionExecution({
    kind: 'action_execution_start',
    schemaVersion: 1,
    action: consumed.action,
    startedAt: /** @type {IsoTimestamp} */ (CONSUMED_AT),
  })
  const receipt = await new FeishuReplyExecutor(
    identityConfiguration,
    client,
    policyClock.options,
  ).execute(consumed.action, new AbortController().signal)
  assert.equal(receipt.outcome, 'succeeded')
  database.recordActionExecutionReceipt({
    kind: 'action_execution_receipt_write',
    schemaVersion: 1,
    action: consumed.action,
    receipt,
  })
  return {
    event,
    projection,
    context,
    initialDraft,
    finalDraft,
    proposal,
    approved,
    consumed,
    receipt,
  }
}

/** @param {Awaited<ReturnType<typeof completeLocalContractFlow>>} flow */
function traceRecords(flow) {
  const workItem = { kind: 'work_item', id: flow.projection.workItem.id }
  const event = { kind: 'external_event', id: flow.event.id }
  return [
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-ingestion',
      category: 'ingestion',
      outcome: 'success',
      actor: { type: 'connector', id: 'feishu' },
      summary: 'A synthetic verified Feishu direct message entered the local Inbox.',
      references: [event, { kind: 'external_thread', id: flow.projection.thread.id }, workItem],
      details: { fixture: true, path: 'bot_direct_message', roadmapStage: 2 },
      occurredAt: INGESTED_AT,
    }),
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-routing',
      category: 'routing',
      outcome: 'success',
      actor: { type: 'system' },
      summary: 'The Communication Persona was selected without granting write authority.',
      references: [event, workItem],
      details: { fixture: true, personaId: 'communication', authorityEffect: 'none' },
      occurredAt: CONTEXT_AT,
    }),
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-context-run',
      category: 'run',
      outcome: 'success',
      actor: { type: 'persona', id: 'communication' },
      summary: 'Bounded Feishu context supported a synthetic reply draft.',
      references: [event, workItem],
      details: {
        fixture: true,
        contextAvailability: flow.context.availability.status,
        contextItemCount: flow.context.items.length,
        modelInvocation: false,
      },
      occurredAt: DRAFTED_AT,
    }),
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-edited-draft',
      category: 'draft',
      outcome: 'success',
      actor: { type: 'user', id: 'user:synthetic-local-owner' },
      summary: 'The user-edited synthetic reply became ready for review.',
      references: [
        event,
        workItem,
        { kind: 'draft', id: flow.initialDraft.id },
        { kind: 'draft', id: flow.finalDraft.id },
      ],
      details: { fixture: true, revision: 2, supersedesRevision: 1 },
      occurredAt: EDITED_AT,
    }),
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-approval',
      category: 'approval',
      outcome: 'success',
      actor: { type: 'user', id: 'user:synthetic-local-owner' },
      summary: 'The exact synthetic Feishu reply received one-time approval.',
      references: [
        workItem,
        { kind: 'action_proposal', id: flow.proposal.id },
        { kind: 'approval_record', id: flow.approved.approval.id },
      ],
      details: {
        fixture: true,
        identityType: flow.proposal.identity.identityType,
        contentDigest: flow.proposal.contentDigest,
        expiresAt: flow.approved.approval.expiresAt,
      },
      occurredAt: CONSUMED_AT,
    }),
    audit({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'audit-stage2-execution',
      category: 'execution',
      outcome: 'success',
      actor: { type: 'connector', id: 'feishu' },
      summary: 'The approved synthetic Feishu reply produced one durable success receipt.',
      references: [
        workItem,
        { kind: 'action_proposal', id: flow.proposal.id },
        { kind: 'approval_record', id: flow.approved.approval.id },
        { kind: 'action_receipt', id: flow.consumed.action.executionAttemptId },
      ],
      details: {
        fixture: true,
        outcome: flow.receipt.outcome,
        idempotencyKey: flow.proposal.idempotencyKey,
      },
      occurredAt: EXECUTED_AT,
    }),
  ]
}

test('the local Feishu contract completes ingestion → edited Draft → approval → receipt → Audit across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const policyClock = clock()
  const client = replyClient()
  let database = openTwinDeskDatabase(path, policyClock.options)
  const flow = await completeLocalContractFlow(database, policyClock, client)

  assert.deepEqual(client.diagnostics(), {
    reconcileCalls: 1,
    sendCalls: 1,
    externalWrites: 1,
  })
  assert.equal(database.queryAuditTimeline({ limit: 100 }).records.length, 0)
  database.close()

  database = openTwinDeskDatabase(path, policyClock.options)
  assert.deepEqual(database.getThread(flow.projection.thread.id), flow.projection.thread)
  assert.equal(database.getWorkItem(flow.projection.workItem.id)?.sourceEventIds[0], flow.event.id)
  assert.equal(database.getDraft(flow.initialDraft.id)?.state, 'superseded')
  assert.equal(database.getDraft(flow.finalDraft.id)?.state, 'ready_for_review')
  const records = traceRecords(flow)
  const insertedAudit = database.appendAuditRecords(records)
  assert.equal(insertedAudit.insertedCount, records.length)
  assert.equal(insertedAudit.duplicateCount, 0)
  assert.equal(database.getActionProposal(flow.proposal.id)?.state, 'succeeded')
  assert.equal(database.getActionApproval(flow.approved.approval.id)?.decision, 'approved')
  assert.equal(
    database.getActionExecutionReceipt(flow.consumed.action.executionAttemptId)?.receipt.outcome,
    'succeeded',
  )
  assert.throws(
    () =>
      database.beginActionExecution({
        kind: 'action_execution_start',
        schemaVersion: 1,
        action: flow.consumed.action,
        startedAt: /** @type {IsoTimestamp} */ (EXECUTED_AT),
      }),
    (error) => error instanceof ActionExecutionStateError && error.code === 'execution_state',
  )
  assert.deepEqual(client.diagnostics(), {
    reconcileCalls: 1,
    sendCalls: 1,
    externalWrites: 1,
  })

  const timeline = database.queryAuditTimeline({ limit: 100 }).records
  assert.equal(timeline.length, 6)
  assert.deepEqual(
    new Set(timeline.map((record) => record.category)),
    new Set(['ingestion', 'routing', 'run', 'draft', 'approval', 'execution']),
  )
  assert.equal(
    timeline.every((record) => record.references.some(({ kind }) => kind === 'work_item')),
    true,
  )
  const duplicateAudit = database.appendAuditRecords(records)
  assert.equal(duplicateAudit.insertedCount, 0)
  assert.equal(duplicateAudit.duplicateCount, records.length)
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM external_events').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM work_items').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM drafts').get()?.count, 2)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_proposals').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 1)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 6)
  inspection.close()

  const stored = await readFile(path)
  for (const forbidden of [
    'secret-ref:synthetic-stage2',
    BOT_PRINCIPAL,
    USER_PRINCIPAL,
    'synthetic-stage2-user',
  ]) {
    assert.equal(stored.includes(Buffer.from(forbidden)), false)
  }
})
