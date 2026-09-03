import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../packages/bundle-workbench/dist/cordis-runtime.js'
import { openWorkbenchFeishuSettingsStores } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuRuntimeLeaseManager,
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

test('Workbench Cordis runtime leaves polling dormant until a User identity exists', async (context) => {
  const { config } = await fixture(context)
  const originalWithLease = Object.getOwnPropertyDescriptor(
    FeishuRuntimeLeaseManager.prototype,
    'withLease',
  )
  let acquisitions = 0
  Object.defineProperty(FeishuRuntimeLeaseManager.prototype, 'withLease', {
    configurable: true,
    async value() {
      acquisitions += 1
      throw new Error('A dormant polling runtime must not acquire a lease.')
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
  await dispose()
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
})
