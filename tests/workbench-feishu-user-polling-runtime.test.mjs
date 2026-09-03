import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WorkbenchFeishuUserPollingRuntime,
  createWorkbenchFeishuUserPollingRuntime,
} from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationJournal,
  FeishuOAuthV3TokenRefresher,
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  FeishuUserMessageSearchClientError,
  FeishuUserMessageSearchHttpClient,
} from '../packages/plugin-feishu/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

const ACCOUNT_ID = 'feishu-account:synthetic-polling-runtime'
const APP_ID = 'cli_synthetic_polling_runtime'
const TENANT_KEY = 'tenant_synthetic_polling_runtime'
const USER_PRINCIPAL_ID = 'ou_synthetic_polling_runtime_user'
const NOW = Date.parse('2026-09-02T08:00:00.000Z')

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Polling User',
      principalId: USER_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-polling-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {number} index */
function message(index) {
  return {
    messageId: `om_synthetic_polling_${index}`,
    chatId: `oc_synthetic_polling_${index}`,
    chatType: 'group',
    messageType: 'text',
    createTime: String(NOW - index * 60_000),
    senderPrincipalId: `ou_synthetic_sender_${index}`,
    deleted: false,
    updated: false,
    content: { text: `Synthetic polling message ${index}` },
    mentions: [],
  }
}

/**
 * @param {{ messages?: unknown[], unavailableMessageIds?: string[], hasMore?: boolean, nextPageToken?: string }} [overrides]
 */
function page(overrides = {}) {
  const hasMore = overrides.hasMore ?? false
  return {
    kind: 'feishu_user_message_search_page',
    schemaVersion: 1,
    identityType: 'user',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    userPrincipalId: USER_PRINCIPAL_ID,
    messages: overrides.messages ?? [],
    unavailableMessageIds: overrides.unavailableMessageIds ?? [],
    hasMore,
    ...(hasMore ? { nextPageToken: overrides.nextPageToken ?? 'page-token-next' } : {}),
  }
}

class SyntheticLeaseManager extends FeishuRuntimeLeaseManager {
  assertions = 0
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
    this.active = true
    try {
      return await use({
        assertHeld: () => {
          signal.throwIfAborted()
          assert.equal(this.active, true)
          this.assertions += 1
        },
      })
    } finally {
      this.active = false
    }
  }
}

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const directory = await mkdtemp(join(tmpdir(), 'twindesk-feishu-user-polling-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'twindesk.sqlite3')
}

/**
 * @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} database
 * @param {() => void} afterCommit
 * @returns {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase}
 */
function databaseWithCommitHook(database, afterCommit) {
  return /** @type {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} */ (
    /** @type {unknown} */ ({
      /** @param {import('../packages/storage-sqlite/src/sync-cursor.ts').ConnectorCursorKey} key */
      getConnectorCursor: (key) => database.getConnectorCursor(key),
      /** @param {string} id */
      getThread: (id) => database.getThread(id),
      /** @param {import('../packages/domain/src/model.ts').WorkItemId} id */
      getWorkItem: (id) => database.getWorkItem(id),
      /** @param {import('../packages/storage-sqlite/src/sync-cursor.ts').ConnectorSyncCommitRequest} request */
      commitConnectorSyncBatch: (request) => {
        const result = database.commitConnectorSyncBatch(request)
        afterCommit()
        return result
      },
    })
  )
}

/**
 * @param {object} input
 * @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} input.database
 * @param {(request: import('../packages/plugin-feishu/src/user-message-discovery.ts').FeishuUserMessageSearchRequest, signal: AbortSignal) => Promise<unknown>} input.search
 * @param {AbortController} input.controller
 * @param {SyntheticLeaseManager} input.leaseManager
 * @param {(delayMs: number, signal: AbortSignal) => Promise<void>} [input.wait]
 */
function runtime({ database, search, controller, leaseManager, wait }) {
  return new WorkbenchFeishuUserPollingRuntime({
    database,
    configuration: configuration(),
    tenantKey: TENANT_KEY,
    searchClient: { search },
    leaseManager,
    pageSize: 10,
    pollIntervalMs: 100,
    retryDelayMs: 5,
    maximumRetryDelayMs: 20,
    now: () => NOW,
    wait:
      wait ??
      (async () => {
        controller.abort()
        controller.signal.throwIfAborted()
      }),
  })
}

test('polling commits each page before restart and resumes the durable page cursor', async (context) => {
  const path = await temporaryDatabase(context)
  const firstController = new AbortController()
  const leaseManager = new SyntheticLeaseManager()
  let database = openTwinDeskDatabase(path)
  /** @type {import('../packages/plugin-feishu/src/user-message-discovery.ts').FeishuUserMessageSearchRequest[]} */
  const firstRequests = []
  const firstRuntime = runtime({
    database: databaseWithCommitHook(database, () => firstController.abort()),
    search: async (request, signal) => {
      signal.throwIfAborted()
      firstRequests.push(request)
      return page({
        messages: [message(1)],
        hasMore: true,
        nextPageToken: 'page-token-restart',
      })
    },
    controller: firstController,
    leaseManager,
  })
  await assert.rejects(firstRuntime.run(firstController.signal), { name: 'AbortError' })
  assert.equal(firstRequests[0]?.pageToken, undefined)
  assert.equal(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    })?.committedThrough,
    undefined,
  )
  database.close()

  database = openTwinDeskDatabase(path)
  context.after(() => {
    if (database.isOpen) database.close()
  })
  const secondController = new AbortController()
  /** @type {import('../packages/plugin-feishu/src/user-message-discovery.ts').FeishuUserMessageSearchRequest[]} */
  const resumedRequests = []
  const secondRuntime = runtime({
    database,
    search: async (request, signal) => {
      signal.throwIfAborted()
      resumedRequests.push(request)
      return page({ messages: [message(2)] })
    },
    controller: secondController,
    leaseManager,
  })
  await assert.rejects(secondRuntime.run(secondController.signal), { name: 'AbortError' })

  assert.equal(resumedRequests[0]?.pageToken, 'page-token-restart')
  assert.equal(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    })?.committedThrough,
    '2026-09-02T07:59:30.000Z',
  )
  assert.equal(database.queryInbox().items.length, 2)
  assert.equal(leaseManager.assertions, 4)
})

test('retryable search and missing-detail batches use bounded waits without advancing early', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const controller = new AbortController()
  const leaseManager = new SyntheticLeaseManager()
  /** @type {number[]} */
  const waits = []
  let calls = 0
  const polling = runtime({
    database,
    controller,
    leaseManager,
    search: async () => {
      calls += 1
      if (calls === 1) throw new FeishuUserMessageSearchClientError('rate_limited')
      if (calls === 2 || calls === 3) {
        return page({ unavailableMessageIds: ['om_synthetic_missing_detail'] })
      }
      return page({ messages: [message(3)] })
    },
    wait: async (delayMs, signal) => {
      waits.push(delayMs)
      if (waits.length === 4) controller.abort()
      signal.throwIfAborted()
    },
  })
  await assert.rejects(polling.run(controller.signal), { name: 'AbortError' })

  assert.equal(calls, 4)
  assert.deepEqual(waits, [5, 10, 20, 100])
  assert.ok(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    }),
  )
  assert.equal(database.queryInbox().items.length, 1)
})

test('non-retryable authorization failures stop without a commit or hidden retry', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const controller = new AbortController()
  let waited = false
  const polling = runtime({
    database,
    controller,
    leaseManager: new SyntheticLeaseManager(),
    search: async () => {
      throw new FeishuUserMessageSearchClientError('not_authorized')
    },
    wait: async () => {
      waited = true
    },
  })

  await assert.rejects(polling.run(controller.signal), {
    name: 'FeishuUserDiscoveryError',
    code: 'not_authorized',
    retryable: false,
  })
  assert.equal(waited, false)
  assert.equal(database.queryInbox().items.length, 0)
  assert.equal(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    }),
    undefined,
  )
})

test('an interrupted durable commit stops the loop without storing events or a cursor', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const controller = new AbortController()
  const privateValue = 'synthetic-private-polling-value'
  const failingDatabase =
    /** @type {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} */ (
      /** @type {unknown} */ ({
        /** @param {import('../packages/storage-sqlite/src/sync-cursor.ts').ConnectorCursorKey} key */
        getConnectorCursor: (key) => database.getConnectorCursor(key),
        /** @param {string} id */
        getThread: (id) => database.getThread(id),
        /** @param {import('../packages/domain/src/model.ts').WorkItemId} id */
        getWorkItem: (id) => database.getWorkItem(id),
        commitConnectorSyncBatch: () => {
          throw new Error('Synthetic commit interruption.')
        },
      })
    )
  const polling = runtime({
    database: failingDatabase,
    controller,
    leaseManager: new SyntheticLeaseManager(),
    search: async () => page({ messages: [message(4)] }),
  })

  await assert.rejects(polling.run(controller.signal), (error) => {
    assert.equal(String(error).includes(privateValue), false)
    return error instanceof Error && error.message === 'Synthetic commit interruption.'
  })
  assert.equal(database.queryInbox().items.length, 0)
  assert.equal(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    }),
    undefined,
  )
})

test('lease loss after discovery stops before committing the observed page', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const controller = new AbortController()
  class LosingLeaseManager extends SyntheticLeaseManager {
    /**
     * @override
     * @template TResult
     * @param {unknown} _configuration
     * @param {AbortSignal} signal
     * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
     * @returns {Promise<TResult>}
     */
    async withLease(_configuration, signal, use) {
      let assertions = 0
      return use({
        assertHeld: () => {
          signal.throwIfAborted()
          assertions += 1
          if (assertions === 2) {
            throw new FeishuRuntimeLeaseError(
              'lease_lost',
              'stop_connector',
              'The Feishu runtime lease is no longer held.',
            )
          }
        },
      })
    }
  }
  const polling = runtime({
    database,
    controller,
    leaseManager: new LosingLeaseManager(),
    search: async () => page({ messages: [message(5)] }),
  })

  await assert.rejects(polling.run(controller.signal), {
    name: 'FeishuRuntimeLeaseError',
    code: 'lease_lost',
    recovery: 'stop_connector',
  })
  assert.equal(database.queryInbox().items.length, 0)
  assert.equal(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    }),
    undefined,
  )
})

test('the production polling composition constructs and uses its search adapter inside one lease', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const controller = new AbortController()
  const leaseManager = new SyntheticLeaseManager()
  /** @type {string[]} */
  const events = []
  const credential = new TextEncoder().encode(
    `${JSON.stringify({
      kind: 'feishu_user_oauth_credential_bundle',
      schemaVersion: 1,
      appId: APP_ID,
      principalId: USER_PRINCIPAL_ID,
      clientSecret: 'synthetic-private-polling-client-secret',
      tokenType: 'Bearer',
      accessToken: 'u-synthetic-private-polling-access-token',
      obtainedAt: '2026-09-02T07:00:00.000Z',
      accessTokenExpiresAt: '2026-09-02T09:00:00.000Z',
      refreshToken: 'synthetic-private-polling-refresh-token',
      refreshTokenExpiresAt: '2026-09-09T07:00:00.000Z',
      scopes: ['im:chat:read', 'im:message:readonly', 'offline_access', 'search:message'],
    })}\n`,
  )
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        assert.equal(leaseManager.active, true)
        events.push('keychain')
        return credential.slice()
      },
    },
  })
  const scopeProbe = new FeishuUserCredentialScopeProbe({
    configuration: configuration(),
    resolver,
    now: () => NOW,
  })
  const rotationCoordinator = new FeishuOAuthRotationCoordinator({
    resolver,
    refresher: new FeishuOAuthV3TokenRefresher({
      now: () => NOW,
      transport: {
        async send() {
          return { status: 500, body: new Uint8Array() }
        },
      },
    }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: { async replace() {} },
    }),
    journal: new FeishuOAuthRotationJournal(join(tmpdir(), 'twindesk-unused-polling.jsonl')),
    now: () => NOW,
  })
  Object.defineProperty(rotationCoordinator, 'refreshIfNeeded', {
    value: async () => {
      assert.equal(leaseManager.active, true)
      events.push('rotation')
      return { status: 'not_required', obtainedAt: '2026-09-02T07:00:00.000Z' }
    },
  })
  const httpClient = new FeishuUserMessageSearchHttpClient({
    fetch: async () => new Response(null, { status: 500 }),
  })
  Object.defineProperty(httpClient, 'search', {
    /**
     * @param {unknown} _request
     * @param {AbortSignal} signal
     */
    value: async (_request, signal) => {
      signal.throwIfAborted()
      assert.equal(leaseManager.active, true)
      events.push('http')
      return page()
    },
  })

  const polling = createWorkbenchFeishuUserPollingRuntime({
    database,
    configuration: configuration(),
    tenantKey: TENANT_KEY,
    resolver,
    scopeProbe,
    rotationCoordinator,
    httpClient,
    leaseManager,
    pageSize: 10,
    pollIntervalMs: 100,
    retryDelayMs: 5,
    maximumRetryDelayMs: 20,
    now: () => NOW,
    wait: async () => controller.abort(),
  })
  assert.deepEqual(events, [])

  await assert.rejects(polling.run(controller.signal), { name: 'AbortError' })
  assert.deepEqual(events, ['rotation', 'keychain', 'keychain', 'http'])
  assert.equal(leaseManager.active, false)
  assert.equal(leaseManager.assertions, 9)
  assert.ok(
    database.getConnectorCursor({
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      stream: 'user_visible_messages',
    }),
  )
})

test('lease-aware search factories are exclusive, lazy, and descriptor-safe', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  const leaseManager = new SyntheticLeaseManager()
  let factoryCalls = 0
  let getterCalls = 0
  const controller = new AbortController()
  const polling = new WorkbenchFeishuUserPollingRuntime({
    database,
    configuration: configuration(),
    tenantKey: TENANT_KEY,
    searchClientFactory() {
      factoryCalls += 1
      assert.equal(leaseManager.active, true)
      return /** @type {any} */ (
        Object.defineProperty({}, 'search', {
          get() {
            getterCalls += 1
            return async () => page()
          },
        })
      )
    },
    leaseManager,
  })
  assert.equal(factoryCalls, 0)
  await assert.rejects(polling.run(controller.signal), {
    name: 'TypeError',
    message: 'The Workbench Feishu User polling runtime configuration is invalid.',
  })
  assert.equal(factoryCalls, 1)
  assert.equal(getterCalls, 0)
  assert.equal(leaseManager.active, false)

  assert.throws(
    () =>
      new WorkbenchFeishuUserPollingRuntime(
        /** @type {any} */ ({
          database,
          configuration: configuration(),
          tenantKey: TENANT_KEY,
          searchClient: { search: async () => page() },
          searchClientFactory: () => ({ search: async () => page() }),
        }),
      ),
    { name: 'TypeError' },
  )
  assert.throws(
    () =>
      new WorkbenchFeishuUserPollingRuntime(
        /** @type {any} */ ({
          database,
          configuration: configuration(),
          tenantKey: TENANT_KEY,
        }),
      ),
    { name: 'TypeError' },
  )
})
