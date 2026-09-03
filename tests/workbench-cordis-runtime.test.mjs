import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../packages/bundle-workbench/dist/cordis-runtime.js'
import { openWorkbenchFeishuSettingsStores } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
  FeishuUserMessageSearchAdapter,
} from '../packages/plugin-feishu/dist/index.js'

const FEISHU_CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-cordis-polling',
  appId: 'cli_synthetic_cordis_polling',
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic Cordis Polling User',
    principalId: 'ou_synthetic_cordis_polling',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-cordis-polling',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})
const FEISHU_TENANT_KEY = 'tenant_synthetic_cordis_polling'
const BOT_ENCRYPTION_KEY = 'synthetic-cordis-bot-event-encryption-key'
const BOT_VERIFICATION_TOKEN = 'synthetic-cordis-bot-event-verification-token'

/** @param {import('node:test').TestContext} context */
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-cordis-runtime-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  return {
    config: {
      version: 1,
      homeDirectory: root,
      databasePath: join(root, 'state', 'twindesk.sqlite3'),
      port: 0,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
    },
  }
}

/** @param {{ routeAvailable?: boolean }} [options] */
function runtimeContext({ routeAvailable = true } = {}) {
  /** @type {Promise<() => Promise<void>> | undefined} */
  let lifecycle
  /** @type {string[]} */
  const messages = []
  const context = {
    agents: { create() {}, get() {} },
    sessions: { flush() {} },
    sessionPersistence: { list() {}, inspect() {} },
    agentPresets: { mount() {} },
    llm: {
      listProviders() {
        return routeAvailable ? [{ id: 'synthetic-provider', name: 'Synthetic' }] : []
      },
      /** @param {string} provider @param {string} model @param {AbortSignal | undefined} signal */
      async resolveModelInfo(provider, model, signal) {
        signal?.throwIfAborted()
        return { provider, id: model, name: model }
      },
    },
    /** @param {() => Promise<() => Promise<void>>} effect */
    effect(effect) {
      lifecycle = Promise.resolve(effect())
      return () => {}
    },
    logger() {
      return { info: (/** @type {string} */ message) => messages.push(message) }
    },
  }
  return {
    context,
    messages,
    lifecycle() {
      if (lifecycle === undefined) throw new Error('Synthetic lifecycle was not registered.')
      return lifecycle
    },
  }
}

test('Workbench Cordis runtime owns product Web startup, route injection, restart, and shutdown', async (context) => {
  assert.equal(name, 'twindesk-workbench-runtime')
  assert.deepEqual(inject, ['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'llm'])
  const { config } = await fixture(context)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runtime = runtimeContext()
    apply(runtime.context, config)
    const dispose = await runtime.lifecycle()
    assert.equal(typeof dispose, 'function')
    assert.equal(runtime.messages.length, 1)
    const url = runtime.messages[0]?.match(/TwinDesk product web: (http:\/\/[^\s]+)/u)?.[1]
    assert.ok(url)
    const status = await fetch(`${url}/api/model-drafts`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      autonomy: 'draft_only',
    })
    assert.match(status.headers.get('x-twindesk-model-draft-csrf-token') ?? '', /^[\w-]{43}$/u)
    await dispose()
    await assert.rejects(fetch(`${url}/health`))
  }
})

test('Workbench Cordis runtime fails before listening when the Host route is unavailable', async (context) => {
  const { config } = await fixture(context)
  const runtime = runtimeContext({ routeAvailable: false })
  apply(runtime.context, config)
  await assert.rejects(runtime.lifecycle(), { code: 'runtime_unavailable' })
  assert.deepEqual(runtime.messages, [])
})

test('Workbench Cordis runtime starts polling after the product creates its first User identity', async (context) => {
  const { config } = await fixture(context)
  const stores = await openWorkbenchFeishuSettingsStores({
    platform: 'darwin',
    homeDirectory: config.homeDirectory,
  })
  /** @type {((value?: unknown) => void) | undefined} */
  let resolveSearch
  const searched = new Promise((resolve) => {
    resolveSearch = resolve
  })
  const originalSearch = Object.getOwnPropertyDescriptor(
    FeishuUserMessageSearchAdapter.prototype,
    'search',
  )
  Object.defineProperty(FeishuUserMessageSearchAdapter.prototype, 'search', {
    configurable: true,
    async value() {
      const configuration = await stores.identityStore.read()
      if (configuration?.user === undefined) throw new Error('Synthetic User is missing.')
      resolveSearch?.()
      return Object.freeze({
        kind: 'feishu_user_message_search_page',
        schemaVersion: 1,
        identityType: 'user',
        accountId: configuration.accountId,
        appId: configuration.appId,
        tenantKey: FEISHU_TENANT_KEY,
        userPrincipalId: configuration.user.principalId,
        messages: Object.freeze([]),
        unavailableMessageIds: Object.freeze([]),
        hasMore: false,
      })
    },
  })
  context.after(() => {
    if (originalSearch !== undefined) {
      Object.defineProperty(FeishuUserMessageSearchAdapter.prototype, 'search', originalSearch)
    }
  })
  const originalWithLease = Object.getOwnPropertyDescriptor(
    FeishuRuntimeLeaseManager.prototype,
    'withLease',
  )
  let acquisitions = 0
  let ownerActive = false
  Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', {
    configurable: true,
    /**
     * @template TResult
     * @param {unknown} _configuration
     * @param {AbortSignal} signal
     * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
     * @returns {Promise<TResult>}
     */
    async value(_configuration, signal, use) {
      signal.throwIfAborted()
      acquisitions += 1
      ownerActive = true
      try {
        return await use({
          assertHeld() {
            if (!ownerActive) throw new Error('Synthetic Cordis owner is not active.')
          },
        })
      } finally {
        ownerActive = false
      }
    },
  })
  context.after(() => {
    if (originalWithLease !== undefined) {
      Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', originalWithLease)
    }
  })

  const runtime = runtimeContext()
  apply(runtime.context, { ...config, feishuTenantKey: FEISHU_TENANT_KEY })
  const dispose = await runtime.lifecycle()
  context.after(() => dispose())
  assert.equal(runtime.messages.length, 1)
  assert.equal(acquisitions, 0)

  const url = runtime.messages[0]?.match(/TwinDesk product web: (http:\/\/[^\s]+)/u)?.[1]
  assert.ok(url)
  const status = await fetch(`${url}/api/settings/feishu`)
  const csrfToken = status.headers.get('x-twindesk-csrf-token')
  assert.ok(csrfToken !== null)
  const created = await fetch(`${url}/api/settings/feishu/user-identity`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      version: 1,
      connection: 'new',
      appId: 'cli_synthetic_cordis_dynamic',
      displayName: 'Synthetic Cordis Dynamic User',
      principalId: 'ou_synthetic_cordis_dynamic',
    }),
  })
  assert.equal(created.status, 200)
  await Promise.race([
    searched,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Dynamic Cordis polling did not start.')), 1_000),
    ),
  ])
  assert.equal(acquisitions, 1)
  assert.equal(ownerActive, true)
  await dispose()
  assert.equal(ownerActive, false)
})

test('Workbench Cordis runtime polls beneath one shared Feishu owner and releases it on shutdown', async (context) => {
  const { config } = await fixture(context)
  const stores = await openWorkbenchFeishuSettingsStores({
    platform: 'darwin',
    homeDirectory: config.homeDirectory,
  })
  await stores.identityStore.write(FEISHU_CONFIGURATION)
  /** @type {((value?: unknown) => void) | undefined} */
  let resolveSearch
  const searched = new Promise((resolve) => {
    resolveSearch = resolve
  })
  const originalSearch = Object.getOwnPropertyDescriptor(
    FeishuUserMessageSearchAdapter.prototype,
    'search',
  )
  Object.defineProperty(FeishuUserMessageSearchAdapter.prototype, 'search', {
    configurable: true,
    /** @param {unknown} _request @param {AbortSignal} signal */
    async value(_request, signal) {
      signal.throwIfAborted()
      resolveSearch?.()
      return Object.freeze({
        kind: 'feishu_user_message_search_page',
        schemaVersion: 1,
        identityType: 'user',
        accountId: FEISHU_CONFIGURATION.accountId,
        appId: FEISHU_CONFIGURATION.appId,
        tenantKey: FEISHU_TENANT_KEY,
        userPrincipalId: FEISHU_CONFIGURATION.user.principalId,
        messages: Object.freeze([]),
        unavailableMessageIds: Object.freeze([]),
        hasMore: false,
      })
    },
  })
  context.after(() => {
    if (originalSearch !== undefined) {
      Object.defineProperty(FeishuUserMessageSearchAdapter.prototype, 'search', originalSearch)
    }
  })
  const originalWithLease = Object.getOwnPropertyDescriptor(
    FeishuRuntimeLeaseManager.prototype,
    'withLease',
  )
  let acquisitions = 0
  let ownerActive = false
  Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', {
    configurable: true,
    /**
     * @template TResult
     * @param {unknown} _configuration
     * @param {AbortSignal} signal
     * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
     * @returns {Promise<TResult>}
     */
    async value(_configuration, signal, use) {
      signal.throwIfAborted()
      acquisitions += 1
      ownerActive = true
      try {
        return await use({
          assertHeld() {
            if (!ownerActive) {
              throw new Error('Synthetic Cordis owner is not active.')
            }
          },
        })
      } finally {
        ownerActive = false
      }
    },
  })
  context.after(() => {
    if (originalWithLease !== undefined) {
      Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', originalWithLease)
    }
  })

  const runtime = runtimeContext()
  apply(runtime.context, { ...config, feishuTenantKey: FEISHU_TENANT_KEY })
  const dispose = await runtime.lifecycle()
  context.after(() => dispose())
  await Promise.race([
    searched,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Synthetic Cordis polling did not start.')), 1_000),
    ),
  ])
  assert.equal(runtime.messages.length, 1)
  assert.equal(acquisitions, 1)
  assert.equal(ownerActive, true)
  await dispose()
  assert.equal(ownerActive, false)
})

test('Workbench Cordis runtime hosts signed Bot events into the durable Inbox', async (context) => {
  const { config } = await fixture(context)
  const stores = await openWorkbenchFeishuSettingsStores({
    platform: 'darwin',
    homeDirectory: config.homeDirectory,
  })
  const botConfiguration = {
    ...FEISHU_CONFIGURATION,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Cordis Bot',
      principalId: 'ou_synthetic_cordis_bot',
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-cordis-bot-app',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    user: undefined,
  }
  await stores.identityStore.write(botConfiguration)

  const originalSecret = Object.getOwnPropertyDescriptor(
    FeishuSystemKeychainSecretResolver.prototype,
    'withSecret',
  )
  Object.defineProperty(FeishuSystemKeychainSecretResolver.prototype, 'withSecret', {
    configurable: true,
    /**
     * @template TResult
     * @param {unknown} _reference
     * @param {AbortSignal} signal
     * @param {(secret: Uint8Array) => Promise<TResult> | TResult} use
     * @returns {Promise<TResult>}
     */
    async value(_reference, signal, use) {
      signal.throwIfAborted()
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          kind: 'feishu_bot_event_subscription_secret_bundle',
          schemaVersion: 1,
          appId: botConfiguration.appId,
          verificationToken: BOT_VERIFICATION_TOKEN,
          encryptionKey: BOT_ENCRYPTION_KEY,
        }),
      )
      try {
        return await use(bytes)
      } finally {
        bytes.fill(0)
      }
    },
  })
  context.after(() => {
    if (originalSecret !== undefined) {
      Object.defineProperty(
        FeishuSystemKeychainSecretResolver.prototype,
        'withSecret',
        originalSecret,
      )
    }
  })
  const originalWithLease = Object.getOwnPropertyDescriptor(
    FeishuRuntimeLeaseManager.prototype,
    'withLease',
  )
  Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', {
    configurable: true,
    /**
     * @template TResult
     * @param {unknown} _configuration
     * @param {AbortSignal} signal
     * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
     * @returns {Promise<TResult>}
     */
    async value(_configuration, signal, use) {
      signal.throwIfAborted()
      return use({ assertHeld: () => signal.throwIfAborted() })
    },
  })
  context.after(() => {
    if (originalWithLease !== undefined) {
      Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', originalWithLease)
    }
  })

  const runtime = runtimeContext()
  apply(runtime.context, {
    ...config,
    feishuTenantKey: FEISHU_TENANT_KEY,
    feishuBotEventSecretReferenceId: 'secret-ref:synthetic-cordis-bot-events',
  })
  const dispose = await runtime.lifecycle()
  context.after(() => dispose())
  const url = runtime.messages[0]?.match(/TwinDesk product web: (http:\/\/[^\s]+)/u)?.[1]
  assert.ok(url)
  const now = Date.now()
  const rawBody = JSON.stringify({
    schema: '2.0',
    header: {
      event_id: 'evt_synthetic_cordis_bot',
      event_type: 'im.message.receive_v1',
      create_time: String(now),
      app_id: botConfiguration.appId,
      tenant_key: FEISHU_TENANT_KEY,
    },
    event: {
      sender: { sender_id: { open_id: 'ou_synthetic_cordis_sender' } },
      message: {
        message_id: 'om_synthetic_cordis_bot',
        create_time: String(now),
        chat_id: 'oc_synthetic_cordis_bot',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Synthetic Cordis Bot request' }),
      },
    },
  })
  const timestamp = String(Math.floor(now / 1000))
  const nonce = 'synthetic-cordis-bot-nonce'
  const response = await fetch(`${url}/api/connectors/feishu/bot/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': createHash('sha256')
        .update(timestamp)
        .update(nonce)
        .update(BOT_ENCRYPTION_KEY)
        .update(rawBody)
        .digest('hex'),
    },
    body: rawBody,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {})
  const inbox = await fetch(`${url}/api/inbox`)
  assert.equal(inbox.status, 200)
  const snapshot = /** @type {{items: Array<{summary: string}>}} */ (await inbox.json())
  assert.equal(
    snapshot.items.some((item) => item.summary === 'Synthetic Cordis Bot request'),
    true,
  )
})

test('Workbench Cordis runtime rejects unknown and accessor-backed configuration', async () => {
  const runtime = runtimeContext()
  await assert.rejects(
    async () => apply(runtime.context, { version: 1, extra: true }),
    /configuration is invalid/u,
  )
  let accessed = false
  const hostile = {
    version: 1,
    homeDirectory: '/tmp/synthetic-home',
    databasePath: '/tmp/synthetic.sqlite3',
    port: 0,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    get credential() {
      accessed = true
      return 'synthetic-private-value'
    },
  }
  await assert.rejects(async () => apply(runtime.context, hostile), /configuration is invalid/u)
  assert.equal(accessed, false)
  await assert.rejects(async () =>
    apply(runtime.context, {
      version: 1,
      homeDirectory: '/tmp/synthetic-home',
      databasePath: '/tmp/synthetic.sqlite3',
      port: 0,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      feishuTenantKey: ' ',
    }),
  )
  await assert.rejects(async () =>
    apply(runtime.context, {
      version: 1,
      homeDirectory: '/tmp/synthetic-home',
      databasePath: '/tmp/synthetic.sqlite3',
      port: 0,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      feishuBotEventSecretReferenceId: 'secret-ref:synthetic-without-tenant',
    }),
  )
  await assert.rejects(async () =>
    apply(runtime.context, {
      version: 1,
      homeDirectory: '/tmp/synthetic-home',
      databasePath: '/tmp/synthetic.sqlite3',
      port: 0,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      feishuTenantKey: FEISHU_TENANT_KEY,
      feishuBotEventSecretReferenceId: 'not-a-secret-reference',
    }),
  )
})
