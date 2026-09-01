import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FeishuOAuthReconciler,
  FeishuOAuthReconciliationError,
  FeishuOAuthRotationJournal,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const SOURCE = '2026-08-28T07:00:00.000Z'
const REPLACEMENT = '2026-08-28T14:00:00.000Z'
const NOW = Date.parse('2026-09-30T14:00:00.000Z')
const APP_ID = 'cli_synthetic_reconciliation'
const PRINCIPAL_ID = 'ou_synthetic_reconciliation'
const PRIVATE_TOKEN = 'synthetic-private-reconciliation-token'

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryDirectory(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-reconciliation-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function configuration(principalId = PRINCIPAL_ID) {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-reconciliation',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Reconciliation User',
      principalId,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-reconciliation',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {string} obtainedAt @param {string} [principalId] @param {string} [refreshTokenExpiresAt] */
function bundle(
  obtainedAt,
  principalId = PRINCIPAL_ID,
  refreshTokenExpiresAt = '2026-10-04T14:00:00.000Z',
) {
  return new Uint8Array(
    Buffer.from(
      JSON.stringify({
        kind: 'feishu_user_oauth_credential_bundle',
        schemaVersion: 1,
        appId: APP_ID,
        principalId,
        clientSecret: `${PRIVATE_TOKEN}-secret`,
        tokenType: 'Bearer',
        accessToken: `${PRIVATE_TOKEN}-access`,
        obtainedAt,
        accessTokenExpiresAt: '2026-08-28T16:00:00.000Z',
        refreshToken: `${PRIVATE_TOKEN}-refresh`,
        refreshTokenExpiresAt,
        scopes: ['im:message', 'offline_access'],
      }),
    ),
  )
}

/**
 * @param {string} path
 * @param {'reserved' | 'uncertain' | 'reauthorization_reserved'} state
 */
async function history(path, state) {
  const base = {
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: 3,
    sequence: 1,
    sourceObtainedAt: SOURCE,
    recordedAt: REPLACEMENT,
  }
  const events = [{ ...base, state: 'reserved' }]
  if (state === 'uncertain') {
    events.push({ ...base, state: 'uncertain' })
  }
  if (state === 'reauthorization_reserved') {
    events.push({ ...base, state: 'reauthorization_required' })
    events.push({ ...base, state: 'reauthorization_reserved' })
  }
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  await chmod(path, 0o600)
}

/** @param {FeishuOAuthRotationJournal} journal @param {Uint8Array} credential */
function reconciler(journal, credential) {
  return new FeishuOAuthReconciler({
    journal,
    now: () => NOW,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => credential },
    }),
  })
}

for (const [pendingState, terminalState, resolution] of /** @type {const} */ ([
  ['reserved', 'completed', 'rotation'],
  ['uncertain', 'completed', 'rotation'],
  ['reauthorization_reserved', 'reauthorized', 'reauthorization'],
])) {
  test(`${pendingState} reconciles a strictly newer identity-bound Keychain bundle`, async (context) => {
    const root = await temporaryDirectory(context, pendingState)
    const path = join(root, 'rotation.jsonl')
    await history(path, /** @type {never} */ (pendingState))
    const credential = bundle(REPLACEMENT)
    const journal = new FeishuOAuthRotationJournal(path)

    assert.deepEqual(
      await reconciler(journal, credential).reconcile(
        configuration(),
        new AbortController().signal,
      ),
      { status: 'reconciled', resolution },
    )
    assert.equal(
      credential.every((byte) => byte === 0),
      true,
    )
    assert.equal((await journal.inspect())?.state, terminalState)
    const document = await readFile(path, 'utf8')
    assert.equal(document.includes(PRIVATE_TOKEN), false)
    assert.equal(document.includes(PRINCIPAL_ID), false)
  })
}

test('same or older Keychain evidence remains blocked without a journal write', async (context) => {
  const root = await temporaryDirectory(context, 'same')
  const path = join(root, 'rotation.jsonl')
  await history(path, 'uncertain')
  const before = await readFile(path, 'utf8')
  const journal = new FeishuOAuthRotationJournal(path)

  assert.deepEqual(
    await reconciler(journal, bundle(SOURCE)).reconcile(
      configuration(),
      new AbortController().signal,
    ),
    { status: 'still_required' },
  )
  assert.equal(await readFile(path, 'utf8'), before)
})

test('a newer but expired Keychain credential remains blocked', async (context) => {
  const root = await temporaryDirectory(context, 'expired')
  const path = join(root, 'rotation.jsonl')
  await history(path, 'reauthorization_reserved')
  const before = await readFile(path, 'utf8')
  const journal = new FeishuOAuthRotationJournal(path)

  assert.deepEqual(
    await reconciler(
      journal,
      bundle(REPLACEMENT, PRINCIPAL_ID, '2026-09-04T14:00:00.000Z'),
    ).reconcile(configuration(), new AbortController().signal),
    { status: 'still_required' },
  )
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal((await journal.inspect())?.state, 'reauthorization_reserved')
})

test('settled state rejects before Keychain access', async (context) => {
  const root = await temporaryDirectory(context, 'settled')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  let reads = 0
  const current = new FeishuOAuthReconciler({
    journal,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          reads += 1
          return bundle(REPLACEMENT)
        },
      },
    }),
  })

  await assert.rejects(
    current.reconcile(configuration(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthReconciliationError &&
      error.code === 'reconciliation_not_pending',
  )
  assert.equal(reads, 0)
})

test('identity mismatch remains payload-free and preserves unresolved state', async (context) => {
  const root = await temporaryDirectory(context, 'identity')
  const path = join(root, 'rotation.jsonl')
  await history(path, 'reauthorization_reserved')
  const journal = new FeishuOAuthRotationJournal(path)

  await assert.rejects(
    reconciler(journal, bundle(REPLACEMENT, 'ou_other_synthetic')).reconcile(
      configuration(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReconciliationError &&
      error.code === 'credential_invalid' &&
      error.recovery === 'repair_keychain' &&
      !error.message.includes('ou_other_synthetic'),
  )
  assert.equal((await journal.inspect())?.state, 'reauthorization_reserved')
})
