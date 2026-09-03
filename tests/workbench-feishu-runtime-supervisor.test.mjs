import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createWorkbenchFeishuRuntimeSupervisor,
  openWorkbenchFeishuSettingsStores,
} from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
  FeishuUserMessageSearchAdapter,
  FeishuUserMessageSearchClientError,
} from '../packages/plugin-feishu/dist/index.js'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-runtime-supervisor',
  appId: 'cli_synthetic_runtime_supervisor',
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic Runtime Supervisor User',
    principalId: 'ou_synthetic_runtime_supervisor',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-runtime-supervisor',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})
const TENANT_KEY = 'tenant_synthetic_runtime_supervisor'

class SyntheticParentLeaseManager extends FeishuRuntimeLeaseManager {
  acquisitions = 0
  active = false

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
    this.active = true
    try {
      return await use({
        assertHeld: () => {
          if (!this.active) {
            throw new FeishuRuntimeLeaseError(
              'lease_lost',
              'stop_connector',
              'The synthetic supervisor lease is no longer held.',
            )
          }
        },
      })
    } finally {
      this.active = false
    }
  }
}

test('the supervisor restarts terminal polling beneath the same owner after a durable change', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-runtime-supervisor-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'state')
  await mkdir(state)
  const stores = await openWorkbenchFeishuSettingsStores({
    platform: 'darwin',
    homeDirectory: root,
  })
  await stores.identityStore.write(CONFIGURATION)

  let searchCalls = 0
  /** @type {((value?: unknown) => void) | undefined} */
  let resolveSecondSearch
  const secondSearch = new Promise((resolve) => {
    resolveSecondSearch = resolve
  })
  const originalSearch = Object.getOwnPropertyDescriptor(
    FeishuUserMessageSearchAdapter.prototype,
    'search',
  )
  Object.defineProperty(FeishuUserMessageSearchAdapter.prototype, 'search', {
    configurable: true,
    async value() {
      searchCalls += 1
      if (searchCalls === 1) throw new FeishuUserMessageSearchClientError('not_authorized')
      resolveSecondSearch?.()
      return Object.freeze({
        kind: 'feishu_user_message_search_page',
        schemaVersion: 1,
        identityType: 'user',
        accountId: CONFIGURATION.accountId,
        appId: CONFIGURATION.appId,
        tenantKey: TENANT_KEY,
        userPrincipalId: CONFIGURATION.user.principalId,
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

  const parent = new SyntheticParentLeaseManager()
  /** @type {((value?: unknown) => void) | undefined} */
  let resolveAttention
  const attention = new Promise((resolve) => {
    resolveAttention = resolve
  })
  const supervisor = createWorkbenchFeishuRuntimeSupervisor({
    identityStore: stores.identityStore,
    rotationJournal: stores.rotationJournal,
    databasePath: join(state, 'twindesk.sqlite3'),
    tenantKey: TENANT_KEY,
    parentLeaseManager: parent,
    onAttentionRequired() {
      resolveAttention?.()
    },
  })
  context.after(() => supervisor.close())

  await supervisor.refresh()
  await attention
  assert.equal(searchCalls, 1)
  assert.equal(parent.acquisitions, 1)
  assert.equal(parent.active, true)

  supervisor.requestRefresh()
  await Promise.race([
    secondSearch,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Synthetic polling did not restart.')), 1_000),
    ),
  ])
  assert.equal(searchCalls, 2)
  assert.equal(parent.acquisitions, 1)

  await supervisor.quiesce()
  await assert.rejects(
    supervisor.leaseManager.withLease(
      CONFIGURATION,
      new AbortController().signal,
      async () => undefined,
    ),
    { name: 'FeishuRuntimeLeaseError', code: 'lease_lost' },
  )
  await supervisor.close()
  await supervisor.close()
  assert.equal(parent.active, false)
})
