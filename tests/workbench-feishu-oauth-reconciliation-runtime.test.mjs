import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuOAuthReconciliationService } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthRotationJournal,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

const SOURCE = '2026-08-28T07:00:00.000Z'
const REPLACEMENT = '2026-08-28T14:00:00.000Z'
const NOW = Date.parse('2026-09-30T14:00:00.000Z')
const PRIVATE_TOKEN = 'synthetic-private-workbench-reconciliation'
const IDENTITY = {
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-workbench-reconciliation',
  appId: 'cli_synthetic_workbench_reconciliation',
  user: {
    identityType: 'user',
    displayName: 'Synthetic Workbench Reconciliation User',
    principalId: 'ou_synthetic_workbench_reconciliation',
    credentialReference: {
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-workbench-reconciliation',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    },
  },
}

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryDirectory(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-workbench-reconciliation-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function bundle() {
  return new Uint8Array(
    Buffer.from(
      JSON.stringify({
        kind: 'feishu_user_oauth_credential_bundle',
        schemaVersion: 1,
        appId: IDENTITY.appId,
        principalId: IDENTITY.user.principalId,
        clientSecret: `${PRIVATE_TOKEN}-secret`,
        tokenType: 'Bearer',
        accessToken: `${PRIVATE_TOKEN}-access`,
        obtainedAt: REPLACEMENT,
        accessTokenExpiresAt: '2026-08-28T16:00:00.000Z',
        refreshToken: `${PRIVATE_TOKEN}-refresh`,
        refreshTokenExpiresAt: '2026-10-04T14:00:00.000Z',
        scopes: ['im:message', 'offline_access'],
      }),
    ),
  )
}

/** @param {string} path */
async function blocked(path) {
  const base = {
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: 3,
    sequence: 1,
    sourceObtainedAt: SOURCE,
    recordedAt: REPLACEMENT,
  }
  await writeFile(
    path,
    `${[
      { ...base, state: 'reserved' },
      { ...base, state: 'reauthorization_required' },
      { ...base, state: 'reauthorization_reserved' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  )
  await chmod(path, 0o600)
}

/** @param {string} path */
async function reauthorized(path) {
  const base = {
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: 3,
    sequence: 1,
    sourceObtainedAt: SOURCE,
  }
  await writeFile(
    path,
    `${[
      { ...base, state: 'reserved', recordedAt: REPLACEMENT },
      { ...base, state: 'reauthorization_required', recordedAt: REPLACEMENT },
      { ...base, state: 'reauthorization_reserved', recordedAt: REPLACEMENT },
      {
        ...base,
        state: 'reauthorized',
        recordedAt: REPLACEMENT,
        resultObtainedAt: REPLACEMENT,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  )
  await chmod(path, 0o600)
}

class RecordingLeaseManager extends FeishuRuntimeLeaseManager {
  constructor() {
    super()
    this.entries = 0
    this.held = false
  }

  /**
   * @override
   * @template TResult
   * @param {unknown} _configuration
   * @param {AbortSignal} signal
   * @param {(lease: import('../packages/plugin-feishu/dist/index.js').FeishuRuntimeLease) => Promise<TResult> | TResult} use
   * @returns {Promise<TResult>}
   */
  async withLease(_configuration, signal, use) {
    signal.throwIfAborted()
    this.entries += 1
    this.held = true
    try {
      return await use({
        assertHeld: () => {
          if (!this.held) throw new Error('lease lost')
        },
      })
    } finally {
      this.held = false
    }
  }
}

class CancellingJournal extends FeishuOAuthRotationJournal {
  /** @param {string} path @param {AbortController} controller */
  constructor(path, controller) {
    super(path)
    this.controller = controller
  }

  /**
   * @override
   * @param {number} sequence
   * @param {'completed' | 'uncertain' | 'reauthorization_required' | 'reauthorized'} state
   * @param {string} recordedAt
   * @param {string} [resultObtainedAt]
   */
  async settle(sequence, state, recordedAt, resultObtainedAt) {
    const result = await super.settle(sequence, state, recordedAt, resultObtainedAt)
    this.controller.abort()
    return result
  }
}

test('Workbench reconciles local evidence while the Host lease is held', async (context) => {
  const root = await temporaryDirectory(context, 'success')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const journal = new FeishuOAuthRotationJournal(journalPath)
  const database = openTwinDeskDatabase(join(root, 'business.sqlite3'))
  context.after(() => database.close())
  const leaseManager = new RecordingLeaseManager()
  const credential = bundle()
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal,
    database,
    leaseManager,
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          assert.equal(leaseManager.held, true)
          const pending = database.getPendingConnectorMaintenance(
            'feishu',
            'credential_reconciliation',
          )
          assert.ok(pending !== undefined)
          assert.ok(
            database.getAuditRecord(/** @type {any} */ (pending.requestAuditId)) !== undefined,
          )
          return credential
        },
      },
    }),
  })

  assert.deepEqual(await service.reconcile(new AbortController().signal), {
    version: 1,
    connectorId: 'feishu',
    status: 'reconciled',
  })
  assert.equal(reads, 1)
  assert.equal(leaseManager.entries, 1)
  assert.equal(leaseManager.held, false)
  assert.equal(
    credential.every((byte) => byte === 0),
    true,
  )
  assert.equal((await journal.inspect())?.state, 'reauthorized')
  assert.equal(
    database.getPendingConnectorMaintenance('feishu', 'credential_reconciliation'),
    undefined,
  )
  assert.deepEqual(
    database.queryAuditTimeline({ limit: 10 }).records.map((record) => record.summary),
    [
      'Local Connector credential reconciliation requested.',
      'Local Connector credential reconciliation completed.',
    ],
  )
})

test('Workbench rejects missing User configuration before lease or Keychain access', async (context) => {
  const root = await temporaryDirectory(context, 'missing-user')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  const leaseManager = new RecordingLeaseManager()
  const database = openTwinDeskDatabase(':memory:')
  context.after(() => database.close())
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl')),
    database,
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle()
        },
      },
    }),
  })

  await assert.rejects(service.reconcile(new AbortController().signal), TypeError)
  assert.equal(leaseManager.entries, 0)
  assert.equal(reads, 0)
})

test('Workbench does not read Keychain when request Audit persistence fails', async (context) => {
  const root = await temporaryDirectory(context, 'audit-failure')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const database = openTwinDeskDatabase(':memory:')
  database.close()
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle()
        },
      },
    }),
  })

  await assert.rejects(service.reconcile(new AbortController().signal), /database is closed/u)
  assert.equal(reads, 0)
})

test('Workbench settles known reconciliation failures without exposing the thrown value', async (context) => {
  const root = await temporaryDirectory(context, 'known-failure')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const database = openTwinDeskDatabase(':memory:')
  context.after(() => database.close())
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          throw new Error(PRIVATE_TOKEN)
        },
      },
    }),
  })

  await assert.rejects(
    service.reconcile(new AbortController().signal),
    (error) => error instanceof Error && !error.message.includes(PRIVATE_TOKEN),
  )
  assert.equal(database.queryAuditTimeline({ limit: 10 }).records.at(-1)?.details.result, 'failed')
})

test('Workbench settles cancellation after request Audit without repeating reconciliation', async (context) => {
  const root = await temporaryDirectory(context, 'cancelled')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const database = openTwinDeskDatabase(':memory:')
  context.after(() => database.close())
  const controller = new AbortController()
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          controller.abort()
          throw controller.signal.reason
        },
      },
    }),
  })

  await assert.rejects(service.reconcile(controller.signal), { name: 'AbortError' })
  assert.equal(
    database.queryAuditTimeline({ limit: 10 }).records.at(-1)?.details.result,
    'cancelled',
  )
  assert.equal(
    (await new FeishuOAuthRotationJournal(journalPath).inspect())?.state,
    'reauthorization_reserved',
  )
})

test('Workbench treats durable reconciliation success as authoritative over late cancellation', async (context) => {
  const root = await temporaryDirectory(context, 'late-cancellation')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const database = openTwinDeskDatabase(':memory:')
  context.after(() => database.close())
  const controller = new AbortController()
  const journal = new CancellingJournal(journalPath, controller)
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal,
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          return bundle()
        },
      },
    }),
  })

  assert.deepEqual(await service.reconcile(controller.signal), {
    version: 1,
    connectorId: 'feishu',
    status: 'reconciled',
  })
  assert.equal(controller.signal.aborted, true)
  assert.equal((await journal.inspect())?.state, 'reauthorized')
  assert.equal(
    database.queryAuditTimeline({ limit: 10 }).records.at(-1)?.details.result,
    'reconciled',
  )
})

test('Workbench repairs a pending successful Audit after restart without Keychain access', async (context) => {
  const root = await temporaryDirectory(context, 'repair-success')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await reauthorized(journalPath)
  const databasePath = join(root, 'business.sqlite3')
  const beforeRestart = openTwinDeskDatabase(databasePath)
  const operation = beforeRestart.beginConnectorMaintenance(
    /** @type {any} */ ({
      kind: 'connector_maintenance_request',
      schemaVersion: 1,
      id: 'connector-maintenance:feishu:credential-reconciliation:restart-success',
      connectorId: 'feishu',
      operation: 'credential_reconciliation',
      requestedAt: '2026-08-28T13:00:00.000Z',
    }),
  ).operation
  beforeRestart.close()

  const database = openTwinDeskDatabase(databasePath)
  context.after(() => database.close())
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle()
        },
      },
    }),
  })

  await service.recoverPending(new AbortController().signal)
  assert.equal(reads, 0)
  assert.equal(database.getConnectorMaintenance(operation.id)?.settlement?.result, 'reconciled')
})

test('Workbench does not attribute older terminal journal evidence to a newer pending request', async (context) => {
  const root = await temporaryDirectory(context, 'repair-old-terminal')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await reauthorized(journalPath)
  const database = openTwinDeskDatabase(join(root, 'business.sqlite3'))
  context.after(() => database.close())
  const operation = database.beginConnectorMaintenance(
    /** @type {any} */ ({
      kind: 'connector_maintenance_request',
      schemaVersion: 1,
      id: 'connector-maintenance:feishu:credential-reconciliation:old-terminal',
      connectorId: 'feishu',
      operation: 'credential_reconciliation',
      requestedAt: new Date(NOW).toISOString(),
    }),
  ).operation
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle()
        },
      },
    }),
  })

  await service.recoverPending(new AbortController().signal)
  assert.equal(reads, 0)
  assert.equal(database.getConnectorMaintenance(operation.id)?.settlement?.result, 'failed')
})

test('Workbench repairs unresolved pending Audit as still required without Keychain access', async (context) => {
  const root = await temporaryDirectory(context, 'repair-unresolved')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const database = openTwinDeskDatabase(join(root, 'business.sqlite3'))
  context.after(() => database.close())
  const operation = database.beginConnectorMaintenance(
    /** @type {any} */ ({
      kind: 'connector_maintenance_request',
      schemaVersion: 1,
      id: 'connector-maintenance:feishu:credential-reconciliation:restart-unresolved',
      connectorId: 'feishu',
      operation: 'credential_reconciliation',
      requestedAt: new Date(NOW).toISOString(),
    }),
  ).operation
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(journalPath),
    database,
    leaseManager: new RecordingLeaseManager(),
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle()
        },
      },
    }),
  })

  await service.recoverPending(new AbortController().signal)
  assert.equal(reads, 0)
  assert.equal(database.getConnectorMaintenance(operation.id)?.settlement?.result, 'still_required')
  assert.equal(
    (await new FeishuOAuthRotationJournal(journalPath).inspect())?.state,
    'reauthorization_reserved',
  )
})

test('Workbench reconciliation options reject hostile accessors', () => {
  let accessed = false
  const hostile = Object.defineProperty({}, 'identityStore', {
    enumerable: true,
    get() {
      accessed = true
      throw new Error(PRIVATE_TOKEN)
    },
  })
  assert.throws(
    () => createWorkbenchFeishuOAuthReconciliationService(/** @type {never} */ (hostile)),
    /reconciliation runtime is invalid/u,
  )
  assert.equal(accessed, false)
})
