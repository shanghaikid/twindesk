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

test('Workbench reconciles local evidence while the Host lease is held', async (context) => {
  const root = await temporaryDirectory(context, 'success')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  await identityStore.write(IDENTITY)
  const journalPath = join(root, 'rotation.jsonl')
  await blocked(journalPath)
  const journal = new FeishuOAuthRotationJournal(journalPath)
  const leaseManager = new RecordingLeaseManager()
  const credential = bundle()
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal,
    leaseManager,
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          assert.equal(leaseManager.held, true)
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
})

test('Workbench rejects missing User configuration before lease or Keychain access', async (context) => {
  const root = await temporaryDirectory(context, 'missing-user')
  const identityStore = new FeishuIdentityConfigurationStore(join(root, 'identity.json'))
  const leaseManager = new RecordingLeaseManager()
  let reads = 0
  const service = createWorkbenchFeishuOAuthReconciliationService({
    identityStore,
    journal: new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl')),
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
