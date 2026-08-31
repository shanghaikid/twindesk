import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuOAuthReauthorizationHost } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthReauthorizationCoordinator,
  FeishuOAuthReauthorizationError,
  FeishuOAuthRotationJournal,
  FeishuOAuthUserPrincipalVerifier,
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
} from '../packages/plugin-feishu/dist/index.js'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-reauthorization-runtime',
  appId: 'cli_synthetic_reauthorization_runtime',
  user: Object.freeze({
    identityType: 'user',
    principalId: 'ou_synthetic_reauthorization_runtime',
    displayName: 'Synthetic User',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-reauthorization-runtime',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

const TOKEN_SET =
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet} */ (
    Object.freeze({
      tokenType: 'Bearer',
      accessToken: new TextEncoder().encode('synthetic-private-new-access-token'),
      obtainedAt: '2026-08-31T10:00:00.000Z',
      accessTokenExpiresAt: '2026-08-31T11:00:00.000Z',
      refreshToken: new TextEncoder().encode('synthetic-private-new-refresh-token'),
      refreshTokenExpiresAt: '2026-09-07T10:00:00.000Z',
      scopes: Object.freeze(['im:message:send_as_user', 'offline_access']),
    })
  )

class RecordingLeaseManager extends FeishuRuntimeLeaseManager {
  #held = false
  #entries = 0

  held() {
    return this.#held
  }

  entries() {
    return this.#entries
  }

  /**
   * @override
   * @template TResult
   * @param {unknown} configuration
   * @param {AbortSignal} signal
   * @param {(lease: import('../packages/plugin-feishu/dist/index.js').FeishuRuntimeLease) => Promise<TResult> | TResult} use
   * @returns {Promise<TResult>}
   */
  async withLease(configuration, signal, use) {
    if (signal.aborted) return super.withLease(configuration, signal, use)
    assert.deepEqual(configuration, CONFIGURATION)
    assert.equal(this.#held, false)
    this.#held = true
    this.#entries += 1
    const lease = {
      assertHeld: () => {
        if (!this.#held) throw new Error('The synthetic lease is not held.')
      },
    }
    try {
      return await use(lease)
    } finally {
      this.#held = false
    }
  }
}

/**
 * @param {import('node:test').TestContext} context
 * @param {string} prefix
 */
async function temporaryDirectory(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-${prefix}`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * @param {FeishuOAuthRotationJournal} journal
 * @param {{onVerify?: (token: Uint8Array) => Promise<void> | void, onReplace?: (bundle: Uint8Array) => Promise<void> | void}} [options]
 */
function coordinator(journal, options = {}) {
  return new FeishuOAuthReauthorizationCoordinator({
    journal,
    now: () => Date.parse(TOKEN_SET.obtainedAt),
    persister: new FeishuOAuthInitialCredentialPersister({
      verifier: new FeishuOAuthUserPrincipalVerifier({
        client: {
          async get(request) {
            await options.onVerify?.(request.accessToken)
            return { openId: CONFIGURATION.user.principalId }
          },
        },
      }),
      replacer: new FeishuSystemKeychainSecretReplacer({
        platform: 'darwin',
        runner: {
          async replace(_request, bundle) {
            await options.onReplace?.(bundle)
          },
        },
      }),
    }),
  })
}

/** @param {FeishuOAuthRotationJournal} journal */
async function block(journal) {
  const reservation = await journal.reserve('2026-08-31T09:00:00.000Z', '2026-08-31T09:30:00.000Z')
  await journal.settle(reservation.sequence, 'reauthorization_required', '2026-08-31T09:30:00.000Z')
}

test('Workbench holds one Feishu lease across verified blocked-state replacement', async (context) => {
  const root = await temporaryDirectory(context, 'workbench-reauthorization-')
  const journalPath = join(root, 'rotation.jsonl')
  const journal = new FeishuOAuthRotationJournal(journalPath)
  await block(journal)
  const clientSecret = new TextEncoder().encode('synthetic-private-client-secret')
  /** @type {Uint8Array | undefined} */
  let verificationToken
  /** @type {Uint8Array | undefined} */
  let replacementBundle
  /** @type {Uint8Array | undefined} */
  let storedBundle
  let verifications = 0
  let replacements = 0
  const leaseManager = new RecordingLeaseManager()
  const host = createWorkbenchFeishuOAuthReauthorizationHost({
    configuration: CONFIGURATION,
    leaseManager,
    coordinator: coordinator(journal, {
      onVerify(token) {
        verifications += 1
        verificationToken = token
        assert.equal(leaseManager.held(), true)
      },
      onReplace(bundle) {
        replacements += 1
        replacementBundle = bundle
        storedBundle = new Uint8Array(bundle)
        assert.equal(leaseManager.held(), true)
      },
    }),
  })

  assert.deepEqual(await host.replace(clientSecret, TOKEN_SET, new AbortController().signal), {
    status: 'reauthorized',
    obtainedAt: TOKEN_SET.obtainedAt,
  })
  assert.deepEqual({ verifications, replacements }, { verifications: 1, replacements: 1 })
  assert.equal(leaseManager.entries(), 1)
  assert.equal(leaseManager.held(), false)
  assert.equal((await journal.inspect())?.state, 'reauthorized')
  assert.ok(verificationToken instanceof Uint8Array)
  assert.ok(replacementBundle instanceof Uint8Array)
  assert.ok(storedBundle instanceof Uint8Array)
  assert.equal(
    verificationToken.every((byte) => byte === 0),
    true,
  )
  assert.equal(
    replacementBundle.every((byte) => byte === 0),
    true,
  )
  assert.equal(
    storedBundle.every((byte) => byte === 0),
    false,
  )
  const journalDocument = await readFile(journalPath, 'utf8')
  for (const privateValue of [
    CONFIGURATION.appId,
    CONFIGURATION.user.principalId,
    CONFIGURATION.user.credentialReference.id,
    new TextDecoder().decode(clientSecret),
    new TextDecoder().decode(TOKEN_SET.accessToken),
    new TextDecoder().decode(TOKEN_SET.refreshToken),
  ]) {
    assert.equal(journalDocument.includes(privateValue), false)
  }
})

test('Workbench preserves uncertain Keychain recovery when cancellation follows write start', async (context) => {
  const root = await temporaryDirectory(context, 'workbench-reauthorization-uncertain-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  const controller = new AbortController()
  const leaseManager = new RecordingLeaseManager()
  /** @type {Uint8Array | undefined} */
  let replacementBundle
  const host = createWorkbenchFeishuOAuthReauthorizationHost({
    configuration: CONFIGURATION,
    leaseManager,
    coordinator: coordinator(journal, {
      onReplace(bundle) {
        assert.equal(leaseManager.held(), true)
        replacementBundle = bundle
        controller.abort()
      },
    }),
  })

  await assert.rejects(
    host.replace(
      new TextEncoder().encode('synthetic-private-client-secret'),
      TOKEN_SET,
      controller.signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReauthorizationError &&
      error.code === 'persistence_uncertain' &&
      error.recovery === 'reconcile_keychain',
  )
  assert.ok(replacementBundle instanceof Uint8Array)
  assert.equal(
    replacementBundle.every((byte) => byte === 0),
    true,
  )
  assert.equal((await journal.inspect())?.state, 'reauthorization_required')
  assert.equal(leaseManager.entries(), 1)
  assert.equal(leaseManager.held(), false)
})

test('Workbench cancellation occurs before reauthorization replacement', async (context) => {
  const root = await temporaryDirectory(context, 'workbench-reauthorization-cancelled-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  let verifications = 0
  const leaseManager = new RecordingLeaseManager()
  const host = createWorkbenchFeishuOAuthReauthorizationHost({
    configuration: CONFIGURATION,
    leaseManager,
    coordinator: coordinator(journal, {
      onVerify() {
        verifications += 1
      },
    }),
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    host.replace(new Uint8Array([1]), TOKEN_SET, controller.signal),
    (error) => error instanceof FeishuRuntimeLeaseError && error.code === 'cancelled',
  )
  assert.equal(verifications, 0)
  assert.equal(leaseManager.entries(), 0)
  assert.equal(await journal.inspect(), undefined)
})

test('Workbench rejects missing User composition and hostile options without invoking accessors', () => {
  let accessorCalls = 0
  const hostile = Object.defineProperty({}, 'configuration', {
    get() {
      accessorCalls += 1
      return CONFIGURATION
    },
  })
  assert.throws(
    () => createWorkbenchFeishuOAuthReauthorizationHost(/** @type {any} */ (hostile)),
    /runtime is invalid/,
  )
  assert.equal(accessorCalls, 0)

  const current = coordinator(
    new FeishuOAuthRotationJournal(
      join(tmpdir(), 'twindesk-unused-workbench-reauthorization-runtime.jsonl'),
    ),
  )
  assert.throws(
    () =>
      createWorkbenchFeishuOAuthReauthorizationHost({
        configuration: {
          ...CONFIGURATION,
          user: undefined,
          bot: {
            principalId: 'bot:synthetic',
            displayName: 'Synthetic Bot',
            credentialReference: {
              kind: 'secret_reference',
              schemaVersion: 1,
              id: 'secret-ref:synthetic-bot',
              store: 'system_keychain',
              purpose: 'connector_app_credential',
            },
          },
        },
        coordinator: current,
      }),
    /runtime is invalid/,
  )
})
