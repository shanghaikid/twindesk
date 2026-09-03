import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkbenchFeishuConnectorDiagnostics } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuRuntimeLeaseManager,
  FeishuUserCredentialScopeProbe,
  parseFeishuIdentityConfiguration,
} from '../packages/plugin-feishu/dist/index.js'

const CONFIGURATION = parseFeishuIdentityConfiguration({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-production-diagnostics',
  appId: 'cli_synthetic_production_diagnostics',
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic Private Diagnostics User',
    principalId: 'ou_synthetic_private_diagnostics_user',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-private-diagnostics-user',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})
const USER = CONFIGURATION.user
if (USER === undefined) throw new Error('Synthetic User configuration is required.')

class SyntheticLeaseManager extends FeishuRuntimeLeaseManager {
  active = false
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
    this.active = true
    try {
      return await use({
        assertHeld: () => {
          assert.equal(this.active, true)
        },
      })
    } finally {
      this.active = false
    }
  }
}

test('Workbench diagnostics run beneath the Host lease and remove every opaque identity', async () => {
  const leaseManager = new SyntheticLeaseManager()
  let clientCreatedUnderLease = false
  const diagnostics = createWorkbenchFeishuConnectorDiagnostics({
    identityStore: {
      async read() {
        return CONFIGURATION
      },
    },
    database: {
      getConnectorCursor() {
        return undefined
      },
    },
    leaseManager,
    runtimeStatus: () => ({
      version: 1,
      state: 'attention_required',
      recovery: 'grant_scope',
    }),
    now: () => Date.parse('2026-09-03T08:00:00.000Z'),
    createClient() {
      clientCreatedUnderLease = leaseManager.active
      return {
        async inspectIdentity(request, signal) {
          signal.throwIfAborted()
          return {
            kind: 'feishu_identity_probe_result',
            schemaVersion: 1,
            accountId: request.accountId,
            appId: request.appId,
            identityType: request.identityType,
            principalId: request.principalId,
            authorization: 'authorized',
            requiredScopes: [
              'im:chat:read',
              'im:message:readonly',
              'im:message:send_as_user',
              'search:message',
            ],
            grantedScopes: ['im:chat:read', 'im:message:readonly', 'search:message'],
            rateLimit: { status: 'unknown' },
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
    },
  })

  const snapshot = await diagnostics.read(new AbortController().signal)
  assert.equal(clientCreatedUnderLease, true)
  assert.equal(leaseManager.acquisitions, 1)
  assert.equal(snapshot.status, 'degraded')
  assert.deepEqual(snapshot.runtime, {
    version: 1,
    state: 'attention_required',
    recovery: 'grant_scope',
  })
  assert.deepEqual(snapshot.identities, [
    {
      identityType: 'user',
      status: 'attention_required',
      requiredScopes: [
        'im:chat:read',
        'im:message:readonly',
        'im:message:send_as_user',
        'search:message',
      ],
      missingScopes: ['im:message:send_as_user'],
    },
  ])
  assert.equal(snapshot.issues[0]?.recovery, 'grant_scope')
  assert.deepEqual(Object.keys(snapshot.issues[0] ?? {}).sort(), ['code', 'recovery'])
  const serialized = JSON.stringify(snapshot)
  for (const privateValue of [
    CONFIGURATION.accountId,
    CONFIGURATION.appId,
    USER.displayName,
    USER.principalId,
    USER.credentialReference.id,
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('an unconfigured Connector reports no inferred health and performs no lease work', async () => {
  const leaseManager = new SyntheticLeaseManager()
  const diagnostics = createWorkbenchFeishuConnectorDiagnostics({
    identityStore: {
      async read() {
        return undefined
      },
    },
    database: {
      getConnectorCursor() {
        throw new Error('must not read')
      },
    },
    leaseManager,
    createClient() {
      throw new Error('must not construct')
    },
  })
  const snapshot = await diagnostics.read(new AbortController().signal)
  assert.deepEqual(snapshot, {
    version: 1,
    connectorId: 'feishu',
    status: 'not_configured',
    checkedAt: null,
    runtime: { version: 1, state: 'disabled', reason: 'not_configured' },
    identities: [],
    rateLimits: [],
    cursors: [],
    issues: [],
  })
  assert.equal(leaseManager.acquisitions, 0)
})

test('the default composition reuses the concrete User Keychain scope probe for both operations', async (context) => {
  /** @type {string[]} */
  const operations = []
  const original = Object.getOwnPropertyDescriptor(
    FeishuUserCredentialScopeProbe.prototype,
    'inspectCurrentScopes',
  )
  Object.defineProperty(FeishuUserCredentialScopeProbe.prototype, 'inspectCurrentScopes', {
    configurable: true,
    /**
     * @param {import('../packages/plugin-feishu/src/operation-scope-authorization.ts').FeishuOperationScopeProbeRequest} request
     * @param {AbortSignal} signal
     */
    async value(request, signal) {
      signal.throwIfAborted()
      operations.push(request.operation)
      return {
        kind: 'feishu_operation_scope_probe_result',
        schemaVersion: 1,
        accountId: request.accountId,
        appId: request.appId,
        identityType: request.identityType,
        principalId: request.principalId,
        operation: request.operation,
        authorization: 'authorized',
        grantedScopes: [
          'im:chat:read',
          'im:message:readonly',
          'im:message:send_as_user',
          'search:message',
        ],
        observedAt: '2026-09-03T08:00:00.000Z',
      }
    },
  })
  context.after(() => {
    if (original !== undefined) {
      Object.defineProperty(
        FeishuUserCredentialScopeProbe.prototype,
        'inspectCurrentScopes',
        original,
      )
    }
  })
  const diagnostics = createWorkbenchFeishuConnectorDiagnostics({
    identityStore: {
      async read() {
        return CONFIGURATION
      },
    },
    database: {
      getConnectorCursor() {
        return undefined
      },
    },
    leaseManager: new SyntheticLeaseManager(),
    now: () => Date.parse('2026-09-03T08:00:00.000Z'),
  })
  const snapshot = await diagnostics.read(new AbortController().signal)
  assert.equal(snapshot.status, 'degraded')
  assert.deepEqual(operations.sort(), ['user_message_discovery', 'user_reply'])
  assert.deepEqual(snapshot.identities[0]?.missingScopes, [])
  assert.deepEqual(snapshot.runtime, {
    version: 1,
    state: 'disabled',
    reason: 'host_configuration_missing',
  })
  assert.deepEqual(snapshot.issues, [
    { code: 'polling_disabled', recovery: 'repair_configuration' },
  ])
})

test('Workbench diagnostics honor cancellation before reading configuration', async () => {
  let reads = 0
  const diagnostics = createWorkbenchFeishuConnectorDiagnostics({
    identityStore: {
      async read() {
        reads += 1
        return CONFIGURATION
      },
    },
    database: {
      getConnectorCursor() {
        return undefined
      },
    },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(diagnostics.read(controller.signal), { name: 'AbortError' })
  assert.equal(reads, 0)
})
