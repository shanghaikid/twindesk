import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { parseConnectorCursor } from '../packages/domain/dist/index.js'
import {
  FEISHU_BOT_MESSAGE_STREAM,
  FEISHU_MESSAGE_NORMALIZATION_VERSION,
  FeishuMessageNormalizationError,
  FeishuMessageNormalizer,
} from '../packages/plugin-feishu/dist/index.js'
import {
  EventIngestionError,
  SyncCursorError,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

const ACCOUNT_ID = 'feishu-account:synthetic'
const APP_ID = 'cli_synthetic_twindesk'
const TENANT_KEY = 'tenant_synthetic'
const BOT_PRINCIPAL = 'ou_synthetic_bot'
const USER_PRINCIPAL = 'ou_synthetic_user'
const CREATE_MS = Date.parse('2026-08-27T08:00:00.000Z')
const UPDATE_MS = Date.parse('2026-08-27T08:05:00.000Z')

/** @typedef {import('../packages/domain/src/index.ts').ConnectorCursor} ConnectorCursor */
/** @typedef {import('../packages/plugin-feishu/src/bot-event-consumer.ts').FeishuBotMessageEvent} FeishuBotMessageEvent */
/** @typedef {import('../packages/plugin-feishu/src/message-normalization.ts').FeishuNormalizedMessageBatch} FeishuNormalizedMessageBatch */
/** @typedef {import('../packages/plugin-feishu/src/user-message-discovery.ts').FeishuDiscoveredUserMessage} FeishuDiscoveredUserMessage */
/** @typedef {import('../packages/plugin-feishu/src/user-message-discovery.ts').FeishuUserMessageDiscoveryBatch} FeishuUserMessageDiscoveryBatch */
/** @typedef {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} TwinDeskDatabase */

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-feishu-normalization-test-'))
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

/**
 * @param {Partial<FeishuBotMessageEvent>} [overrides]
 * @returns {FeishuBotMessageEvent}
 */
function botEvent(overrides = {}) {
  return /** @type {FeishuBotMessageEvent} */ ({
    kind: 'feishu_bot_message_event',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    botPrincipalId: BOT_PRINCIPAL,
    deliveryEventId: 'evt_synthetic_delivery_1',
    messageId: 'om_synthetic_shared_message',
    chatId: 'oc_synthetic_chat',
    chatType: 'group',
    visibility: 'bot_mention',
    senderPrincipalId: 'ou_synthetic_sender',
    messageType: 'text',
    sourceCreateTime: String(CREATE_MS),
    content: { text: 'Synthetic release question' },
    mentions: [{ key: '@_user_1', principalId: BOT_PRINCIPAL }],
    threadId: 'omt_synthetic_thread',
    ...overrides,
  })
}

/**
 * @param {Partial<FeishuDiscoveredUserMessage>} [overrides]
 * @returns {FeishuDiscoveredUserMessage}
 */
function userMessage(overrides = {}) {
  return /** @type {FeishuDiscoveredUserMessage} */ ({
    kind: 'feishu_discovered_user_message',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    userPrincipalId: USER_PRINCIPAL,
    messageId: 'om_synthetic_shared_message',
    chatId: 'oc_synthetic_chat',
    chatType: 'group',
    messageType: 'text',
    createTime: String(CREATE_MS),
    senderPrincipalId: 'ou_synthetic_sender',
    deleted: false,
    updated: false,
    content: { text: 'Synthetic release question' },
    mentions: [{ key: '@_user_1', principalId: BOT_PRINCIPAL }],
    threadId: 'omt_synthetic_thread',
    ...overrides,
  })
}

/** @returns {ConnectorCursor} */
function cursor() {
  return /** @type {ConnectorCursor} */ (
    /** @type {unknown} */ (
      parseConnectorCursor({
        kind: 'connector_cursor',
        schemaVersion: 1,
        id: 'cursor-feishu-user-synthetic',
        connectorId: 'feishu',
        accountId: ACCOUNT_ID,
        stream: 'user_visible_messages',
        position: 'synthetic-page-complete',
        committedThrough: '2026-08-27T08:10:00.000Z',
        updatedAt: '2026-08-27T08:11:00.000Z',
      })
    )
  )
}

/**
 * @param {readonly FeishuDiscoveredUserMessage[]} messages
 * @param {Partial<Omit<FeishuUserMessageDiscoveryBatch, 'candidateCursor'>> & { candidateCursor?: ConnectorCursor | undefined }} [overrides]
 * @returns {FeishuUserMessageDiscoveryBatch}
 */
function userBatch(messages, overrides = {}) {
  return /** @type {FeishuUserMessageDiscoveryBatch} */ ({
    messages,
    unavailableMessageIds: [],
    candidateCursor: cursor(),
    hasMore: false,
    observedAt: '2026-08-27T08:11:00.000Z',
    coverage: {
      status: 'partial',
      basis: 'authorized_user_message_search',
      windowStart: '2026-08-27T07:00:00.000Z',
      windowEnd: '2026-08-27T08:10:00.000Z',
      limitations: ['api_visibility', 'bounded_time_window', 'indexing_delay'],
    },
    issues: [],
    ...overrides,
  })
}

/**
 * @param {TwinDeskDatabase} database
 * @param {FeishuNormalizedMessageBatch} batch
 */
function commit(database, batch) {
  return database.commitConnectorSyncBatch({
    connectorId: batch.connectorId,
    accountId: batch.accountId,
    stream: batch.stream,
    events: batch.events,
    projections: batch.projections,
    ...(batch.candidateCursor === undefined ? {} : { candidateCursor: batch.candidateCursor }),
  })
}

/** @param {string} path */
function durableCounts(path) {
  const inspection = new DatabaseSync(path, { readOnly: true })
  try {
    /** @param {'external_events' | 'external_threads' | 'work_items' | 'connector_cursors'} table */
    const count = (table) => {
      const row = inspection.prepare(`SELECT count(*) AS count FROM ${table}`).get()
      assert.ok(row)
      assert.equal(typeof row.count, 'number')
      return row.count
    }
    return {
      events: count('external_events'),
      threads: count('external_threads'),
      workItems: count('work_items'),
      cursors: count('connector_cursors'),
    }
  } finally {
    inspection.close()
  }
}

test('Bot and User views normalize to one replay-safe event and Work Item across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const database = openTwinDeskDatabase(path)
  const bot = normalizer.normalizeBotMessage(botEvent(), '2026-08-27T08:01:00.000Z', database)
  assert.equal(FEISHU_MESSAGE_NORMALIZATION_VERSION, 1)
  assert.equal(FEISHU_BOT_MESSAGE_STREAM, 'bot_message_events')
  assert.equal(bot.events.length, 1)
  assert.equal(bot.projections.length, 1)
  assert.deepEqual(bot.events[0]?.context, {
    status: 'partial',
    missing: [
      'conversation context not retrieved',
      'document context not retrieved',
      'attachment context not retrieved',
    ],
  })
  assert.equal(bot.projections[0]?.workItem.inboxState, 'needs_reply')
  const first = commit(database, bot)
  assert.equal(first.ingestion.insertedCount, 1)
  assert.equal(first.projections[0]?.disposition, 'inserted')
  assert.equal(first.cursor.disposition, 'not_provided')
  database.close()

  const restarted = openTwinDeskDatabase(path)
  const user = normalizer.normalizeUserBatch(userBatch([userMessage()]), restarted)
  assert.equal(user.events[0]?.id, bot.events[0]?.id)
  assert.deepEqual(user.events[0]?.normalized, bot.events[0]?.normalized)
  assert.equal(user.projections.length, 0)
  const replay = commit(restarted, user)
  assert.equal(replay.ingestion.duplicateCount, 1)
  assert.equal(replay.projections.length, 0)
  assert.equal(replay.cursor.disposition, 'inserted')
  assert.equal(restarted.queryInbox().items.length, 1)
  assert.equal(restarted.queryInbox().items[0]?.summary, 'Synthetic release question')
  restarted.close()

  assert.deepEqual(durableCounts(path), { events: 1, threads: 1, workItems: 1, cursors: 1 })
})

test('updates advance one projection while a late older state cannot regress its presentation', async (context) => {
  const path = await temporaryDatabase(context)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const database = openTwinDeskDatabase(path)
  commit(database, normalizer.normalizeUserBatch(userBatch([userMessage()]), database))

  const updatedBatch = userBatch(
    [
      userMessage({
        updated: true,
        updatedTime: String(UPDATE_MS),
        content: { text: 'Synthetic revised release question' },
      }),
    ],
    {
      candidateCursor: undefined,
      observedAt: '2026-08-27T08:12:00.000Z',
    },
  )
  const updated = normalizer.normalizeUserBatch(updatedBatch, database)
  assert.equal(updated.projections[0]?.thread.sourceEventIds.length, 2)
  assert.equal(updated.projections[0]?.workItem.summary, 'Synthetic revised release question')
  commit(database, updated)

  const lateDeletion = userBatch(
    [
      userMessage({
        deleted: true,
        updated: true,
        updatedTime: String(CREATE_MS + 60_000),
        content: { text: 'Synthetic older deleted state' },
      }),
    ],
    {
      candidateCursor: undefined,
      observedAt: '2026-08-27T08:13:00.000Z',
    },
  )
  const late = normalizer.normalizeUserBatch(lateDeletion, database)
  const lateProjection = late.projections[0]
  assert.ok(lateProjection)
  assert.equal(lateProjection.workItem.summary, 'Synthetic revised release question')
  assert.equal(lateProjection.workItem.inboxState, 'needs_reply')
  commit(database, late)
  assert.equal(database.getWorkItem(lateProjection.workItem.id)?.sourceEventIds.length, 3)
  assert.equal(database.getWorkItem(lateProjection.workItem.id)?.inboxState, 'needs_reply')
  database.close()
})

test('routing distinguishes review, reply, and latest deletion without granting authority', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const batch = normalizer.normalizeUserBatch(
    userBatch(
      [
        userMessage({
          messageId: 'om_synthetic_review',
          chatId: 'oc_synthetic_review',
          threadId: 'omt_synthetic_review',
          content: { text: 'Synthetic group information' },
          mentions: [],
        }),
        userMessage({
          messageId: 'om_synthetic_direct',
          chatId: 'oc_synthetic_direct',
          threadId: 'omt_synthetic_direct',
          chatType: 'p2p',
          content: { text: 'Synthetic direct question' },
          mentions: [],
        }),
        userMessage({
          messageId: 'om_synthetic_deleted',
          chatId: 'oc_synthetic_deleted',
          threadId: 'omt_synthetic_deleted',
          deleted: true,
          updated: true,
          updatedTime: String(UPDATE_MS),
          content: { text: 'Synthetic deleted message' },
          mentions: [],
        }),
      ],
      { candidateCursor: undefined },
    ),
    database,
  )
  assert.deepEqual(
    batch.projections.map((projection) => projection.workItem.inboxState),
    ['needs_review', 'needs_reply', 'done'],
  )
  assert.equal(
    batch.projections.every((projection) => projection.workItem.selectedPersonaId === undefined),
    true,
  )
  commit(database, batch)
  assert.equal(database.queryInbox().items.length, 3)
  database.close()
})

test('conflicting Bot and User bodies for one canonical state fail closed', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  commit(database, normalizer.normalizeBotMessage(botEvent(), '2026-08-27T08:01:00.000Z', database))
  const privateValue = 'synthetic-private-conflicting-content'
  const conflict = normalizer.normalizeUserBatch(
    userBatch([userMessage({ content: { text: privateValue } })], {
      candidateCursor: undefined,
      observedAt: '2026-08-27T08:02:00.000Z',
    }),
    database,
  )
  assert.equal(conflict.projections.length, 0)
  assert.throws(
    () => commit(database, conflict),
    (error) =>
      error instanceof EventIngestionError &&
      error.code === 'idempotency_conflict' &&
      error.conflictKey === 'both' &&
      !error.message.includes(privateValue),
  )
  assert.equal(database.queryInbox().items[0]?.summary, 'Synthetic release question')
  database.close()
})

test('events, projections, and the User cursor roll back together on an interrupted projection', async (context) => {
  const path = await temporaryDatabase(context)
  openTwinDeskDatabase(path).close()
  const injector = new DatabaseSync(path)
  injector.exec(`
    CREATE TRIGGER synthetic_projection_failure
    BEFORE INSERT ON work_items
    BEGIN
      SELECT RAISE(ABORT, 'synthetic projection interruption');
    END;
  `)
  injector.close()

  const database = openTwinDeskDatabase(path)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const batch = normalizer.normalizeUserBatch(userBatch([userMessage()]), database)
  assert.throws(
    () => commit(database, batch),
    (error) =>
      error instanceof SyncCursorError &&
      error.code === 'storage_error' &&
      !error.message.includes('synthetic projection interruption'),
  )
  database.close()
  assert.deepEqual(durableCounts(path), { events: 0, threads: 0, workItems: 0, cursors: 0 })
})

test('identity mismatches fail before normalization and do not disclose rejected values', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const normalizer = new FeishuMessageNormalizer(configuration(), TENANT_KEY)
  const privateValue = 'synthetic-private-normalization-value'
  assert.throws(
    () =>
      normalizer.normalizeBotMessage(
        botEvent({ accountId: privateValue }),
        '2026-08-27T08:01:00.000Z',
        database,
      ),
    (error) =>
      error instanceof FeishuMessageNormalizationError &&
      error.code === 'identity_mismatch' &&
      !error.message.includes(privateValue),
  )
  assert.throws(
    () =>
      normalizer.normalizeUserBatch(
        userBatch([userMessage({ tenantKey: privateValue })]),
        database,
      ),
    (error) =>
      error instanceof FeishuMessageNormalizationError &&
      error.code === 'identity_mismatch' &&
      !error.message.includes(privateValue),
  )
  assert.deepEqual(database.queryInbox().items, [])
  database.close()
})
