import assert from 'node:assert/strict'
import {
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createCipheriv, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FEISHU_BOT_MESSAGE_EVENT_VERSION,
  FEISHU_BOT_RECEIPT_VERSION,
  FeishuBotEventConsumer,
  FeishuBotEventError,
  FeishuBotEventReceiptStore,
} from '../packages/plugin-feishu/dist/index.js'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')
const ENCRYPTION_KEY = 'synthetic-feishu-event-encryption-key'
const VERIFICATION_TOKEN = 'synthetic-feishu-verification-token'
const TIMESTAMP = String(NOW / 1000)

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    bot: {
      identityType: 'bot',
      displayName: 'TwinDesk Bot',
      principalId: 'ou_synthetic_bot',
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-feishu-app',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
  }
}

/** @param {Record<string, any>} [overrides] */
function eventBody(overrides = {}) {
  const body = {
    schema: '2.0',
    header: {
      event_id: 'evt_synthetic_delivery_1',
      event_type: 'im.message.receive_v1',
      create_time: TIMESTAMP,
      app_id: 'cli_synthetic_twindesk',
      tenant_key: 'tenant_synthetic',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_synthetic_sender' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_synthetic_message_1',
        create_time: String(NOW),
        chat_id: 'oc_synthetic_direct_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Synthetic status request' }),
      },
    },
  }
  return {
    ...body,
    ...overrides,
    header: { ...body.header, ...overrides.header },
    event: {
      ...body.event,
      ...overrides.event,
      sender: { ...body.event.sender, ...overrides.event?.sender },
      message: { ...body.event.message, ...overrides.event?.message },
    },
  }
}

/**
 * @param {unknown} body
 * @param {{timestamp?: string, nonce?: string, key?: string, signature?: string}} [options]
 */
function signedRequest(body, options = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = options.timestamp ?? TIMESTAMP
  const nonce = options.nonce ?? 'synthetic-nonce'
  const key = options.key ?? ENCRYPTION_KEY
  const signature = createHash('sha256')
    .update(timestamp)
    .update(nonce)
    .update(key)
    .update(rawBody)
    .digest('hex')
  return {
    headers: {
      'X-Lark-Request-Timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'X-Lark-Signature': options.signature ?? signature,
    },
    rawBody,
  }
}

/** @param {unknown} body */
function encryptedRequest(body) {
  const key = createHash('sha256').update(ENCRYPTION_KEY).digest()
  const iv = Buffer.alloc(16, 7)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(body), 'utf8')),
    cipher.final(),
  ])
  return signedRequest({ encrypt: Buffer.concat([iv, ciphertext]).toString('base64') })
}

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function fixture(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-feishu-events-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, receipts: join(root, 'bot-message-receipts.jsonl') }
}

/** @param {string} receipts */
function consumer(receipts) {
  return new FeishuBotEventConsumer(
    configuration(),
    ENCRYPTION_KEY,
    new FeishuBotEventReceiptStore(receipts),
    { tenantKey: 'tenant_synthetic', now: () => NOW },
  )
}

/** @param {string} receipts */
function subscriptionConsumer(receipts) {
  return new FeishuBotEventConsumer(
    configuration(),
    ENCRYPTION_KEY,
    new FeishuBotEventReceiptStore(receipts),
    {
      tenantKey: 'tenant_synthetic',
      verificationToken: VERIFICATION_TOKEN,
      now: () => NOW,
    },
  )
}

test('signed URL verification echoes only the exact bound challenge', async (context) => {
  const files = await fixture(context, 'challenge')
  let calls = 0
  const challenge = {
    type: 'url_verification',
    challenge: 'synthetic-challenge-value',
    token: VERIFICATION_TOKEN,
  }
  assert.deepEqual(
    await subscriptionConsumer(files.receipts).consume(signedRequest(challenge), async () => {
      calls += 1
    }),
    { status: 'challenge', challenge: 'synthetic-challenge-value' },
  )
  assert.equal(calls, 0)
  await assert.rejects(
    subscriptionConsumer(files.receipts).consume(
      signedRequest({ ...challenge, token: 'wrong-token' }),
      async () => {
        calls += 1
      },
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'identity_mismatch',
  )
  await assert.rejects(
    consumer(files.receipts).consume(signedRequest(challenge), async () => undefined),
    (error) => error instanceof FeishuBotEventError && error.code === 'identity_mismatch',
  )
  await assert.rejects(
    subscriptionConsumer(files.receipts).consume(
      signedRequest({ ...challenge, extra: 'unsupported' }),
      async () => undefined,
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'identity_mismatch',
  )
  assert.equal(calls, 0)
})

test('verified direct messages are consumed once and persist only hash receipts', async (context) => {
  const files = await fixture(context, 'direct')
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuBotMessageEvent[]} */
  const received = []
  const result = await consumer(files.receipts).consume(
    signedRequest(eventBody()),
    async (event) => {
      received.push(event)
    },
  )

  assert.equal(result.status, 'accepted')
  assert.equal(FEISHU_BOT_MESSAGE_EVENT_VERSION, 1)
  assert.equal(FEISHU_BOT_RECEIPT_VERSION, 1)
  assert.equal(received.length, 1)
  const first = received[0]
  assert.ok(first)
  assert.equal(first.visibility, 'direct_message')
  assert.equal(first.messageId, 'om_synthetic_message_1')
  assert.deepEqual(first.content, { text: 'Synthetic status request' })
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.content), true)

  const journal = await readFile(files.receipts, 'utf8')
  assert.match(journal, /feishu_bot_message_receipt/u)
  assert.match(journal, /"messageKeyDigest":"[a-f0-9]{64}"/u)
  assert.doesNotMatch(
    journal,
    /om_synthetic|oc_synthetic|ou_synthetic|cli_synthetic|tenant_synthetic|Synthetic status|encryption-key|secret-ref/u,
  )
})

test('message-id deduplication survives restart and detects changed replays', async (context) => {
  const files = await fixture(context, 'restart')
  let calls = 0
  const handle = async () => {
    calls += 1
  }
  const original = eventBody({
    event: {
      message: {
        content: JSON.stringify({ text: 'Synthetic status request', priority: 'normal' }),
      },
    },
  })
  assert.equal(
    (await consumer(files.receipts).consume(signedRequest(original), handle)).status,
    'accepted',
  )
  const restartedReceipts = join(files.root, 'restarted-receipts.jsonl')
  await copyFile(files.receipts, restartedReceipts)
  const reordered = eventBody({
    header: { event_id: 'evt_synthetic_delivery_retry' },
    event: {
      message: {
        content: JSON.stringify({ priority: 'normal', text: 'Synthetic status request' }),
      },
    },
  })
  assert.equal(
    (await consumer(restartedReceipts).consume(signedRequest(reordered), handle)).status,
    'duplicate',
  )
  assert.equal(calls, 1)

  const changed = eventBody({
    header: { event_id: 'evt_synthetic_delivery_retry' },
    event: { message: { content: JSON.stringify({ text: 'Changed replay' }) } },
  })
  await assert.rejects(
    consumer(restartedReceipts).consume(signedRequest(changed), handle),
    (error) => error instanceof FeishuBotEventError && error.code === 'receipt_conflict',
  )
  assert.equal(calls, 1)
})

test('group delivery requires an exact mention of the configured Bot principal', async (context) => {
  const files = await fixture(context, 'mentions')
  let calls = 0
  const unmentioned = eventBody({
    event: {
      message: {
        chat_id: 'oc_synthetic_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone_else' }, name: 'Someone' }],
      },
    },
  })
  const ignored = await consumer(files.receipts).consume(signedRequest(unmentioned), async () => {
    calls += 1
  })
  assert.deepEqual(ignored, {
    status: 'ignored',
    reason: 'group_message_without_bot_mention',
  })

  const mentioned = eventBody({
    event: {
      message: {
        message_id: 'om_synthetic_group_message',
        chat_id: 'oc_synthetic_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_synthetic_bot' }, name: 'TwinDesk Bot' }],
      },
    },
  })
  const accepted = await consumer(files.receipts).consume(
    signedRequest(mentioned),
    async (event) => {
      calls += 1
      assert.equal(event.visibility, 'bot_mention')
      assert.deepEqual(event.mentions, [{ key: '@_user_1', principalId: 'ou_synthetic_bot' }])
    },
  )
  assert.equal(accepted.status, 'accepted')
  assert.equal(calls, 1)
})

test('signatures fail closed before parsing or handling and encrypted callbacks work', async (context) => {
  const files = await fixture(context, 'signatures')
  let calls = 0
  const handle = async () => {
    calls += 1
  }
  await assert.rejects(
    consumer(files.receipts).consume(
      signedRequest(eventBody(), { signature: '0'.repeat(64) }),
      handle,
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'invalid_signature',
  )
  await assert.rejects(
    consumer(files.receipts).consume(
      signedRequest(eventBody(), { timestamp: String(NOW / 1000 - 301) }),
      handle,
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'stale_request',
  )
  await assert.rejects(
    consumer(files.receipts).consume(
      signedRequest(eventBody({ header: { app_id: 'cli_wrong_app' } })),
      handle,
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'identity_mismatch',
  )
  await assert.rejects(
    consumer(files.receipts).consume(
      signedRequest(eventBody({ header: { tenant_key: 'tenant_wrong' } })),
      handle,
    ),
    (error) => error instanceof FeishuBotEventError && error.code === 'identity_mismatch',
  )
  assert.equal(calls, 0)

  const encrypted = eventBody({
    header: { event_id: 'evt_synthetic_encrypted' },
    event: { message: { message_id: 'om_synthetic_encrypted' } },
  })
  assert.equal(
    (await consumer(files.receipts).consume(encryptedRequest(encrypted), handle)).status,
    'accepted',
  )
  assert.equal(calls, 1)
})

test('failed handlers remain retryable and concurrent duplicate delivery invokes once', async (context) => {
  const files = await fixture(context, 'retry')
  const request = signedRequest(eventBody())
  const secret = 'synthetic-downstream-private-value'
  await assert.rejects(
    consumer(files.receipts).consume(request, async () => {
      throw new Error(secret)
    }),
    (error) =>
      error instanceof FeishuBotEventError &&
      error.code === 'downstream_failure' &&
      !error.message.includes(secret),
  )

  let calls = 0
  const results = await Promise.all([
    consumer(files.receipts).consume(request, async () => {
      calls += 1
      await Promise.resolve()
    }),
    consumer(files.receipts).consume(request, async () => {
      calls += 1
    }),
  ])
  assert.deepEqual(results.map((result) => result.status).sort(), ['accepted', 'duplicate'])
  assert.equal(calls, 1)
})

test('out-of-order messages are independent and a torn receipt tail recovers safely', async (context) => {
  const files = await fixture(context, 'recovery')
  /** @type {string[]} */
  const seen = []
  const active = consumer(files.receipts)
  const later = eventBody({
    header: { event_id: 'evt_later' },
    event: { message: { message_id: 'om_later', create_time: String(NOW + 2000) } },
  })
  const earlier = eventBody({
    header: { event_id: 'evt_earlier' },
    event: { message: { message_id: 'om_earlier', create_time: String(NOW + 1000) } },
  })
  await active.consume(signedRequest(later), async (event) => {
    seen.push(event.messageId)
  })
  await active.consume(signedRequest(earlier), async (event) => {
    seen.push(event.messageId)
  })
  assert.deepEqual(seen, ['om_later', 'om_earlier'])

  await appendFile(files.receipts, '{"kind":"feishu_bot_message_receipt"')
  const restartedReceipts = join(files.root, 'restarted-torn-receipts.jsonl')
  await copyFile(files.receipts, restartedReceipts)
  let duplicateCalls = 0
  const duplicate = await consumer(restartedReceipts).consume(signedRequest(later), async () => {
    duplicateCalls += 1
  })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicateCalls, 0)
  assert.equal((await readFile(restartedReceipts)).at(-1), 0x0a)
})

test('receipt storage rejects unsafe files and hostile request accessors without disclosure', async (context) => {
  const files = await fixture(context, 'unsafe')
  const external = join(files.root, 'external.jsonl')
  const linked = join(files.root, 'linked.jsonl')
  await writeFile(external, '')
  await chmod(external, 0o600)
  await symlink(external, linked)
  await assert.rejects(
    consumer(linked).consume(signedRequest(eventBody()), async () => undefined),
    (error) => error instanceof FeishuBotEventError && error.code === 'unsafe_file',
  )

  const secret = 'synthetic-hostile-request-secret'
  let invoked = false
  const hostile = { headers: signedRequest(eventBody()).headers }
  Object.defineProperty(hostile, 'rawBody', {
    enumerable: true,
    get() {
      invoked = true
      return secret
    },
  })
  await assert.rejects(
    consumer(files.receipts).consume(hostile, async () => undefined),
    (error) => error instanceof FeishuBotEventError && !error.message.includes(secret),
  )
  assert.equal(invoked, false)
})
