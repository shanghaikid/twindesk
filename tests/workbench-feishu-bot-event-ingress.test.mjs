import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuBotEventIngress } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuIdentityConfigurationStore,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

const NOW = Date.parse('2026-09-03T08:01:00.000Z')
const SOURCE_TIME = NOW - 60_000
const ENCRYPTION_KEY = 'synthetic-ingress-encryption-key'
const VERIFICATION_TOKEN = 'synthetic-ingress-verification-token'
const TENANT_KEY = 'tenant_synthetic_ingress'
const SECRET_REFERENCE = Object.freeze({
  kind: 'secret_reference',
  schemaVersion: 1,
  id: 'secret-ref:synthetic-bot-event-subscription',
  store: 'system_keychain',
  purpose: 'connector_api_key',
})

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-ingress',
  appId: 'cli_synthetic_ingress',
  bot: Object.freeze({
    identityType: 'bot',
    displayName: 'Synthetic Ingress Bot',
    principalId: 'ou_synthetic_ingress_bot',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-ingress-app',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    }),
  }),
})

function bundle() {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: 'feishu_bot_event_subscription_secret_bundle',
      schemaVersion: 1,
      appId: CONFIGURATION.appId,
      verificationToken: VERIFICATION_TOKEN,
      encryptionKey: ENCRYPTION_KEY,
    }),
  )
}

function eventBody() {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_synthetic_ingress_delivery',
      event_type: 'im.message.receive_v1',
      create_time: String(SOURCE_TIME),
      app_id: CONFIGURATION.appId,
      tenant_key: TENANT_KEY,
    },
    event: {
      sender: { sender_id: { open_id: 'ou_synthetic_ingress_sender' } },
      message: {
        message_id: 'om_synthetic_ingress_message',
        create_time: String(SOURCE_TIME),
        chat_id: 'oc_synthetic_ingress_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Synthetic ingress request' }),
      },
    },
  }
}

/** @param {unknown} body */
function signedRequest(body) {
  const rawBody = JSON.stringify(body)
  const timestamp = String(NOW / 1000)
  const nonce = 'synthetic-ingress-nonce'
  return Object.freeze({
    headers: Object.freeze({
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': createHash('sha256')
        .update(timestamp)
        .update(nonce)
        .update(ENCRYPTION_KEY)
        .update(rawBody)
        .digest('hex'),
    }),
    rawBody,
  })
}

class SyntheticLeaseManager extends FeishuRuntimeLeaseManager {
  acquisitions = 0

  /**
   * @override
   * @template TResult
   * @param {unknown} _configuration
   * @param {AbortSignal} signal
   * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
   * @returns {Promise<TResult>}
   */
  async withLease(_configuration, signal, use) {
    signal.throwIfAborted()
    this.acquisitions += 1
    return use(Object.freeze({ assertHeld: () => signal.throwIfAborted() }))
  }
}

test('hosted Bot ingress resolves Keychain, commits Inbox before ack, and deduplicates restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-bot-ingress-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(CONFIGURATION)
  const databasePath = join(root, 'twindesk.sqlite3')
  const receiptStorePath = join(root, 'bot-event-receipts.jsonl')
  const database = openTwinDeskDatabase(databasePath)
  context.after(() => {
    if (database.isOpen) database.close()
  })
  /** @type {Uint8Array[]} */
  const resolvedSecrets = []
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run(_request, signal) {
        signal.throwIfAborted()
        const bytes = bundle()
        resolvedSecrets.push(bytes)
        return bytes
      },
    },
  })
  const leaseManager = new SyntheticLeaseManager()
  const ingress = createWorkbenchFeishuBotEventIngress({
    identityStore,
    database,
    tenantKey: TENANT_KEY,
    receiptStorePath,
    secretReference: /** @type {any} */ (SECRET_REFERENCE),
    leaseManager,
    resolver,
    now: () => NOW,
  })

  assert.deepEqual(
    await ingress.consume(signedRequest(eventBody()), new AbortController().signal),
    { version: 1, disposition: 'accepted' },
  )
  assert.equal(database.queryInbox().items.length, 1)
  assert.equal(database.queryInbox().items[0]?.summary, 'Synthetic ingress request')
  assert.ok(resolvedSecrets[0]?.every((value) => value === 0))

  database.close()
  const restarted = openTwinDeskDatabase(databasePath)
  context.after(() => restarted.close())
  const restartedIngress = createWorkbenchFeishuBotEventIngress({
    identityStore,
    database: restarted,
    tenantKey: TENANT_KEY,
    receiptStorePath,
    secretReference: /** @type {any} */ (SECRET_REFERENCE),
    leaseManager,
    resolver,
    now: () => NOW,
  })
  assert.deepEqual(
    await restartedIngress.consume(signedRequest(eventBody()), new AbortController().signal),
    { version: 1, disposition: 'duplicate' },
  )
  assert.equal(restarted.queryInbox().items.length, 1)
  assert.equal(leaseManager.acquisitions, 2)
  assert.ok(resolvedSecrets.every((bytes) => bytes.every((value) => value === 0)))
})

test('hosted Bot ingress handles URL verification and minimizes rejected callbacks', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-bot-ingress-challenge-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(CONFIGURATION)
  const database = openTwinDeskDatabase(join(root, 'twindesk.sqlite3'))
  context.after(() => database.close())
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: { run: async () => bundle() },
  })
  const ingress = createWorkbenchFeishuBotEventIngress({
    identityStore,
    database,
    tenantKey: TENANT_KEY,
    receiptStorePath: join(root, 'receipts.jsonl'),
    secretReference: /** @type {any} */ (SECRET_REFERENCE),
    leaseManager: new SyntheticLeaseManager(),
    resolver,
    now: () => NOW,
  })
  assert.deepEqual(
    await ingress.consume(
      signedRequest({
        type: 'url_verification',
        challenge: 'synthetic-ingress-challenge',
        token: VERIFICATION_TOKEN,
      }),
      new AbortController().signal,
    ),
    { version: 1, disposition: 'challenge', challenge: 'synthetic-ingress-challenge' },
  )
  const invalid = signedRequest(eventBody())
  assert.deepEqual(
    await ingress.consume(
      { ...invalid, headers: { ...invalid.headers, 'x-lark-signature': '0'.repeat(64) } },
      new AbortController().signal,
    ),
    { version: 1, disposition: 'rejected' },
  )
  assert.equal(database.queryInbox().items.length, 0)
})
