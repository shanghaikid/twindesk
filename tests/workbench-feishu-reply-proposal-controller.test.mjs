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
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'
import {
  createWorkbenchFeishuReplyProposalController,
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
