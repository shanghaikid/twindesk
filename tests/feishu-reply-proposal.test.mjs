import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseDraft, parseWorkItemUserAction } from '../packages/domain/dist/index.js'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FEISHU_REPLY_IDEMPOTENCY_KEY_MAX_CHARACTERS,
  FEISHU_REPLY_PROPOSAL_VERSION,
  FeishuMessageNormalizer,
  FeishuReplyProposalError,
  FeishuReplyProposer,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'
import {
  computeDraftContentDigest,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/connector.ts').ConnectorActionRequest} ConnectorActionRequest */
/** @typedef {import('../packages/domain/src/model.ts').Draft} Draft */
/** @typedef {import('../packages/domain/src/model.ts').WorkItemUserAction} WorkItemUserAction */
/** @typedef {import('../packages/plugin-feishu/src/bot-event-consumer.ts').FeishuBotMessageEvent} FeishuBotMessageEvent */

const ACCOUNT_ID = 'feishu-account:synthetic'
const APP_ID = 'cli_synthetic_twindesk'
const TENANT_KEY = 'tenant_synthetic'
const BOT_PRINCIPAL = 'ou_synthetic_bot'
const USER_PRINCIPAL = 'ou_synthetic_user'
const CREATE_MS = Date.parse('2026-08-27T08:00:00.000Z')

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-feishu-reply-proposal-test-'))
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
        id: 'secret-ref:synthetic-feishu-bot',
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
        id: 'secret-ref:synthetic-feishu-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @returns {FeishuBotMessageEvent} */
function botEvent() {
  return /** @type {FeishuBotMessageEvent} */ ({
    kind: 'feishu_bot_message_event',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    botPrincipalId: BOT_PRINCIPAL,
    deliveryEventId: 'evt_synthetic_reply_delivery',
    messageId: 'om_synthetic_reply_target',
    chatId: 'oc_synthetic_reply_chat',
    chatType: 'p2p',
    visibility: 'direct_message',
    senderPrincipalId: 'ou_synthetic_sender',
    messageType: 'text',
    sourceCreateTime: String(CREATE_MS),
    content: { text: 'Can the synthetic release proceed?' },
    mentions: [],
  })
}

/**
 * @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} database
 */
function seedReplyDraft(database) {
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const batch = normalizer.normalizeBotMessage(botEvent(), '2026-08-27T08:01:00.000Z', database)
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
  const action = /** @type {WorkItemUserAction} */ (
    /** @type {unknown} */ (
      parseWorkItemUserAction({
        kind: 'work_item_user_action',
        schemaVersion: 1,
        id: 'work-item-action-synthetic-reply-persona',
        workItemId: workItem.id,
        revision: 1,
        action: 'select_persona',
        personaId: 'communication',
        occurredAt: '2026-08-27T08:02:00.000Z',
      })
    )
  )
  database.applyWorkItemUserAction(action)
  const content = Object.freeze({
    mediaType: /** @type {const} */ ('text/plain'),
    text: 'The synthetic release can proceed after the final health check.',
  })
  const draft = /** @type {Draft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-synthetic-feishu-reply',
        workItemId: workItem.id,
        personaId: 'communication',
        revision: 1,
        state: 'ready_for_review',
        content,
        rationale: 'Uses only the synthetic message context.',
        createdAt: '2026-08-27T08:03:00.000Z',
        updatedAt: '2026-08-27T08:03:00.000Z',
      })
    )
  )
  database.createDraft(draft)
  return Object.freeze({ workItem, event, draft, content })
}

/**
 * @param {ReturnType<typeof seedReplyDraft>} fixture
 * @param {'bot' | 'user'} identityType
 * @returns {ConnectorActionRequest}
 */
function request(fixture, identityType = 'user') {
  return /** @type {ConnectorActionRequest} */ ({
    workItemId: fixture.workItem.id,
    draftId: fixture.draft.id,
    actionType: FEISHU_REPLY_ACTION_TYPE,
    identity: toFeishuActionIdentity(configuration(), identityType),
    target: fixture.event.source,
    content: fixture.content,
  })
}

test('a Feishu reply preview binds the exact Draft, identity, target, and content across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const fixture = seedReplyDraft(database)
  const proposer = new FeishuReplyProposer(configuration(), {
    now: () => Date.parse('2026-08-27T08:04:00.000Z'),
    createNonce: () => 'synthetic-reply-proposal-1',
  })
  const proposal = await proposer.propose(request(fixture), new AbortController().signal)
  assert.equal(FEISHU_REPLY_PROPOSAL_VERSION, 1)
  assert.equal(proposal.actionType, 'feishu.reply')
  assert.equal(proposal.risk, 'write')
  assert.equal(proposal.state, 'proposed')
  assert.deepEqual(proposal.identity, toFeishuActionIdentity(configuration(), 'user'))
  assert.deepEqual(proposal.target, fixture.event.source)
  assert.equal(proposal.contentDigest, computeDraftContentDigest(fixture.content))
  assert.match(proposal.idempotencyKey, /^tdfr1:[a-f0-9]{40}$/u)
  assert.ok(proposal.idempotencyKey.length <= FEISHU_REPLY_IDEMPOTENCY_KEY_MAX_CHARACTERS)
  assert.equal(database.createActionProposal(proposal).disposition, 'inserted')
  database.close()

  const restarted = openTwinDeskDatabase(path)
  assert.deepEqual(restarted.getActionProposal(proposal.id), proposal)
  restarted.close()
  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM approval_records').get()?.count, 0)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM action_receipts').get()?.count, 0)
  inspection.close()
})

test('Bot and User previews remain distinct configured identities without implying approval', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const fixture = seedReplyDraft(database)
  let nonce = 0
  const proposer = new FeishuReplyProposer(configuration(), {
    now: () => Date.parse('2026-08-27T08:04:00.000Z'),
    createNonce: () => `synthetic-identity-proposal-${++nonce}`,
  })
  const user = await proposer.propose(request(fixture, 'user'), new AbortController().signal)
  const bot = await proposer.propose(request(fixture, 'bot'), new AbortController().signal)
  assert.equal(user.identity.identityType, 'user')
  assert.equal(bot.identity.identityType, 'bot')
  assert.notEqual(user.id, bot.id)
  assert.notEqual(user.idempotencyKey, bot.idempotencyKey)
  assert.equal(user.state, 'proposed')
  assert.equal(bot.state, 'proposed')
  database.close()
})

test('reply proposal validation rejects spoofed, unsupported, hostile, and cancelled requests', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const fixture = seedReplyDraft(database)
  const proposer = new FeishuReplyProposer(configuration(), {
    now: () => Date.parse('2026-08-27T08:04:00.000Z'),
    createNonce: () => 'synthetic-validation-proposal',
  })
  const valid = request(fixture)
  const privateValue = 'synthetic-private-reply-value'
  await assert.rejects(
    proposer.propose(
      { ...valid, identity: { ...valid.identity, displayName: privateValue } },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuReplyProposalError &&
      error.code === 'identity_mismatch' &&
      !error.message.includes(privateValue),
  )
  await assert.rejects(
    proposer.propose(
      { ...valid, target: { ...valid.target, objectType: 'thread' } },
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuReplyProposalError && error.code === 'identity_mismatch',
  )
  await assert.rejects(
    proposer.propose(
      {
        ...valid,
        content: { mediaType: 'text/markdown', text: '**Synthetic reply**' },
      },
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuReplyProposalError && error.code === 'unsupported_action',
  )
  await assert.rejects(
    proposer.propose({ ...valid, actionType: 'feishu.send' }, new AbortController().signal),
    (error) => error instanceof FeishuReplyProposalError && error.code === 'unsupported_action',
  )
  const { user: _user, ...botOnlyConfiguration } = configuration()
  const botOnly = new FeishuReplyProposer(botOnlyConfiguration, {
    now: () => Date.parse('2026-08-27T08:04:00.000Z'),
    createNonce: () => 'synthetic-unconfigured-proposal',
  })
  await assert.rejects(
    botOnly.propose(valid, new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyProposalError && error.code === 'identity_not_configured',
  )
  const { draftId: _draftId, ...withoutDraft } = valid
  await assert.rejects(
    proposer.propose(
      /** @type {ConnectorActionRequest} */ (withoutDraft),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuReplyProposalError && error.code === 'invalid_request',
  )
  let accessed = false
  const hostile = Object.defineProperty({ ...valid }, 'content', {
    enumerable: true,
    get() {
      accessed = true
      return privateValue
    },
  })
  await assert.rejects(
    proposer.propose(/** @type {ConnectorActionRequest} */ (hostile), new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyProposalError &&
      error.code === 'invalid_request' &&
      !error.message.includes(privateValue),
  )
  assert.equal(accessed, false)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(proposer.propose(valid, controller.signal), { name: 'AbortError' })
  assert.equal(database.getActionProposal(/** @type {never} */ ('missing-proposal')), undefined)
  database.close()
})
