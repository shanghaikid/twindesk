import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthReauthorizationCoordinator,
  FeishuOAuthReauthorizationError,
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationError,
  FeishuOAuthRotationJournal,
  FeishuOAuthUserPrincipalVerifier,
  FeishuOAuthV3TokenRefresher,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_reauthorization'
const PRINCIPAL_ID = 'ou_synthetic_reauthorization'
const OTHER_PRINCIPAL_ID = 'ou_synthetic_reauthorization_other'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-reauthorization-client-secret'
const PRIVATE_ACCESS_TOKEN = 'synthetic-private-reauthorization-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-reauthorization-refresh-token'
const SOURCE_OBTAINED_AT = '2026-08-28T07:00:00.000Z'
const REAUTHORIZED_AT = '2026-08-28T14:00:00.000Z'
const NOW = Date.parse(REAUTHORIZED_AT)

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {import('node:test').TestContext} context @param {string} prefix */
async function temporaryDirectory(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-${prefix}`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-reauthorization',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Reauthorization User',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-reauthorization',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {Record<string, unknown>} [changes] */
function tokenSet(changes = {}) {
  return {
    tokenType: 'Bearer',
    accessToken: bytes(PRIVATE_ACCESS_TOKEN),
    obtainedAt: REAUTHORIZED_AT,
    accessTokenExpiresAt: '2026-08-28T16:00:00.000Z',
    refreshToken: bytes(PRIVATE_REFRESH_TOKEN),
    refreshTokenExpiresAt: '2026-09-04T14:00:00.000Z',
    scopes: ['im:message', 'offline_access'],
    ...changes,
  }
}

function credentialBundle() {
  return bytes(
    JSON.stringify({
      kind: 'feishu_user_oauth_credential_bundle',
      schemaVersion: 1,
      appId: APP_ID,
      principalId: PRINCIPAL_ID,
      clientSecret: PRIVATE_CLIENT_SECRET,
      tokenType: 'Bearer',
      accessToken: PRIVATE_ACCESS_TOKEN,
      obtainedAt: REAUTHORIZED_AT,
      accessTokenExpiresAt: '2026-08-28T16:00:00.000Z',
      refreshToken: PRIVATE_REFRESH_TOKEN,
      refreshTokenExpiresAt: '2026-09-04T14:00:00.000Z',
      scopes: ['im:message', 'offline_access'],
    }),
  )
}

/** @param {FeishuOAuthRotationJournal} journal */
async function block(journal) {
  const reservation = await journal.reserve(SOURCE_OBTAINED_AT, REAUTHORIZED_AT)
  await journal.settle(reservation.sequence, 'reauthorization_required', REAUTHORIZED_AT)
}

/**
 * @param {FeishuOAuthRotationJournal} journal
 * @param {{openId?: string, replace?: (_request: unknown, bundle: Uint8Array) => Promise<void> | void}} [options]
 */
function fixture(journal, options = {}) {
  const keychain = { value: /** @type {Uint8Array | undefined} */ (undefined) }
  let verifications = 0
  let writes = 0
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get() {
          verifications += 1
          return { openId: options.openId ?? PRINCIPAL_ID }
        },
      },
    }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: {
        async replace(request, bundle) {
          writes += 1
          await options.replace?.(request, bundle)
          keychain.value = new Uint8Array(bundle)
        },
      },
    }),
  })
  return {
    coordinator: new FeishuOAuthReauthorizationCoordinator({
      journal,
      persister,
      now: () => NOW,
    }),
    keychain,
    persister,
    counts: () => ({ verifications, writes }),
  }
}

test('verified reauthorization writes once, records an explicit terminal state, and restarts', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-')
  const path = join(root, 'rotation.jsonl')
  const journal = new FeishuOAuthRotationJournal(path)
  await block(journal)
  const current = fixture(journal)

  assert.deepEqual(
    await current.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    { status: 'reauthorized', obtainedAt: REAUTHORIZED_AT },
  )
  assert.deepEqual(current.counts(), { verifications: 1, writes: 1 })
  assert.equal((await journal.inspect())?.state, 'reauthorized')
  const journalDocument = await readFile(path, 'utf8')
  for (const privateValue of [
    APP_ID,
    PRINCIPAL_ID,
    PRIVATE_CLIENT_SECRET,
    PRIVATE_ACCESS_TOKEN,
    PRIVATE_REFRESH_TOKEN,
    configuration().user.credentialReference.id,
  ]) {
    assert.equal(journalDocument.includes(privateValue), false)
  }
  if (current.keychain.value === undefined) assert.fail('The replacement bundle was not stored.')
  const persistedBundle = current.keychain.value

  let refreshCalls = 0
  const restarted = new FeishuOAuthRotationCoordinator({
    now: () => NOW + 30 * 60 * 1000,
    journal: new FeishuOAuthRotationJournal(path),
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => new Uint8Array(persistedBundle) },
    }),
    refresher: new FeishuOAuthV3TokenRefresher({
      transport: {
        async send() {
          refreshCalls += 1
          throw new Error(PRIVATE_REFRESH_TOKEN)
        },
      },
    }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: { replace: async () => assert.fail('A usable replacement must not be rewritten.') },
    }),
  })
  assert.deepEqual(await restarted.refreshIfNeeded(configuration(), new AbortController().signal), {
    status: 'not_required',
    obtainedAt: REAUTHORIZED_AT,
  })
  assert.equal(refreshCalls, 0)
})

test('version 1 and 2 blocks upgrade through a durable version 3 replacement reservation', async (context) => {
  for (const previousVersion of [1, 2]) {
    const root = await temporaryDirectory(context, `feishu-reauthorization-v${previousVersion}-`)
    const path = join(root, 'rotation.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: previousVersion,
        sequence: 1,
        state: 'reserved',
        sourceObtainedAt: SOURCE_OBTAINED_AT,
        recordedAt: REAUTHORIZED_AT,
      })}\n${JSON.stringify({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: previousVersion,
        sequence: 1,
        state: 'reauthorization_required',
        sourceObtainedAt: SOURCE_OBTAINED_AT,
        recordedAt: REAUTHORIZED_AT,
      })}\n`,
    )
    await chmod(path, 0o600)
    const current = fixture(new FeishuOAuthRotationJournal(path))
    await current.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    )

    const events = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      events.map((event) => [event.schemaVersion, event.state]),
      [
        [previousVersion, 'reserved'],
        [previousVersion, 'reauthorization_required'],
        [3, 'reauthorization_reserved'],
        [3, 'reauthorized'],
      ],
    )
    assert.equal((await new FeishuOAuthRotationJournal(path).inspect())?.state, 'reauthorized')
  }
})

test('version 3 refuses terminal reauthorization without a durable replacement reservation', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-reservation-required-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  await assert.rejects(
    journal.settle(1, 'reauthorized', REAUTHORIZED_AT, REAUTHORIZED_AT),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'invalid_request',
  )
  assert.equal((await journal.inspect())?.state, 'reauthorization_required')
})

test('a newer Keychain bundle reconciles version 1 and 2 blocked histories after restart', async (context) => {
  for (const previousVersion of [1, 2]) {
    const root = await temporaryDirectory(
      context,
      `feishu-reauthorization-v${previousVersion}-recovery-`,
    )
    const path = join(root, 'rotation.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: previousVersion,
        sequence: 1,
        state: 'reserved',
        sourceObtainedAt: SOURCE_OBTAINED_AT,
        recordedAt: REAUTHORIZED_AT,
      })}\n${JSON.stringify({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: previousVersion,
        sequence: 1,
        state: 'reauthorization_required',
        sourceObtainedAt: SOURCE_OBTAINED_AT,
        recordedAt: REAUTHORIZED_AT,
      })}\n`,
    )
    await chmod(path, 0o600)
    let refreshCalls = 0
    const restarted = new FeishuOAuthRotationCoordinator({
      now: () => NOW + 30 * 60 * 1000,
      journal: new FeishuOAuthRotationJournal(path),
      resolver: new FeishuSystemKeychainSecretResolver({
        platform: 'darwin',
        runner: { run: async () => credentialBundle() },
      }),
      refresher: new FeishuOAuthV3TokenRefresher({
        transport: {
          async send() {
            refreshCalls += 1
            throw new Error(PRIVATE_REFRESH_TOKEN)
          },
        },
      }),
      replacer: new FeishuSystemKeychainSecretReplacer({
        platform: 'darwin',
        runner: { replace: async () => assert.fail('Recovery must not rewrite Keychain.') },
      }),
    })

    assert.deepEqual(
      await restarted.refreshIfNeeded(configuration(), new AbortController().signal),
      {
        status: 'reauthorized',
        obtainedAt: REAUTHORIZED_AT,
      },
    )
    assert.equal(refreshCalls, 0)
    const events = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(events.at(-1), {
      kind: 'feishu_oauth_rotation_event',
      schemaVersion: 3,
      sequence: 1,
      state: 'reauthorized',
      sourceObtainedAt: SOURCE_OBTAINED_AT,
      recordedAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
      resultObtainedAt: REAUTHORIZED_AT,
    })
  }
})

test('restart reconciles a newer Keychain bundle when journal completion was not proven', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-recovery-')
  const path = join(root, 'rotation.jsonl')
  const journal = new FeishuOAuthRotationJournal(path)
  await block(journal)
  const interrupted = fixture(journal, {
    replace: async () => {
      throw new Error(PRIVATE_REFRESH_TOKEN)
    },
  })
  await assert.rejects(
    interrupted.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReauthorizationError && error.recovery === 'reconcile_keychain',
  )
  assert.equal((await journal.inspect())?.state, 'reauthorization_reserved')
  let refreshCalls = 0
  const restarted = new FeishuOAuthRotationCoordinator({
    now: () => NOW + 30 * 60 * 1000,
    journal: new FeishuOAuthRotationJournal(path),
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => credentialBundle() },
    }),
    refresher: new FeishuOAuthV3TokenRefresher({
      transport: {
        async send() {
          refreshCalls += 1
          throw new Error(PRIVATE_REFRESH_TOKEN)
        },
      },
    }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: { replace: async () => assert.fail('Recovery must not rewrite Keychain.') },
    }),
  })

  assert.deepEqual(await restarted.refreshIfNeeded(configuration(), new AbortController().signal), {
    status: 'reauthorized',
    obtainedAt: REAUTHORIZED_AT,
  })
  assert.equal(refreshCalls, 0)
  assert.equal((await new FeishuOAuthRotationJournal(path).inspect())?.state, 'reauthorized')
})

test('identity mismatch and stale replacement tokens never alter Keychain or journal state', async (context) => {
  /** @type {Array<[string, string, ReturnType<typeof tokenSet>]>} */
  const invalidReplacements = [
    ['identity', OTHER_PRINCIPAL_ID, tokenSet()],
    ['chronology', PRINCIPAL_ID, tokenSet({ obtainedAt: SOURCE_OBTAINED_AT })],
  ]
  for (const [suffix, openId, tokens] of invalidReplacements) {
    const root = await temporaryDirectory(context, `feishu-reauthorization-${suffix}-`)
    const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
    await block(journal)
    const current = fixture(journal, { openId })
    await assert.rejects(
      current.coordinator.replace(
        configuration(),
        bytes(PRIVATE_CLIENT_SECRET),
        /** @type {never} */ (tokens),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthReauthorizationError &&
        (error.code === 'authorization_failed' || error.code === 'invalid_request') &&
        !error.message.includes(OTHER_PRINCIPAL_ID),
    )
    assert.equal(current.counts().writes, 0)
    assert.equal((await journal.inspect())?.state, 'reauthorization_required')
  }
})

test('a replacement token newer than the trusted journal clock is rejected before write', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-future-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  const current = fixture(journal)
  const coordinator = new FeishuOAuthReauthorizationCoordinator({
    journal,
    persister: current.persister,
    now: () => NOW - 60 * 60 * 1000,
  })
  await assert.rejects(
    coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuOAuthReauthorizationError && error.code === 'invalid_request',
  )
  assert.deepEqual(current.counts(), { verifications: 0, writes: 0 })
  assert.equal((await journal.inspect())?.state, 'reauthorization_required')
})

test('only one concurrent replacement can verify or write', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-concurrent-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  /** @type {() => void} */
  let started = () => assert.fail('Verification start was not initialized.')
  /** @type {Promise<void>} */
  const didStart = new Promise((resolve) => {
    started = () => resolve()
  })
  /** @type {() => void} */
  let release = () => assert.fail('Verification release was not initialized.')
  /** @type {Promise<void>} */
  const mayFinish = new Promise((resolve) => {
    release = () => resolve()
  })
  let verifications = 0
  let writes = 0
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get() {
          verifications += 1
          started()
          await mayFinish
          return { openId: PRINCIPAL_ID }
        },
      },
    }),
    replacer: /** @type {never} */ ({
      async replace() {
        writes += 1
      },
    }),
  })
  const coordinator = new FeishuOAuthReauthorizationCoordinator({
    journal,
    persister,
    now: () => NOW,
  })
  const first = coordinator.replace(
    configuration(),
    bytes(PRIVATE_CLIENT_SECRET),
    /** @type {never} */ (tokenSet()),
    new AbortController().signal,
  )
  await didStart
  const second = coordinator.replace(
    configuration(),
    bytes(PRIVATE_CLIENT_SECRET),
    /** @type {never} */ (tokenSet()),
    new AbortController().signal,
  )
  release()
  assert.equal((await first).status, 'reauthorized')
  await assert.rejects(
    second,
    (error) =>
      error instanceof FeishuOAuthReauthorizationError &&
      error.code === 'reauthorization_not_pending',
  )
  assert.equal(verifications, 1)
  assert.equal(writes, 1)
})

test('a confirmed replacement remains authoritative when cancellation arrives during the write', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-cancelled-write-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  const controller = new AbortController()
  let writes = 0
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: { get: async () => ({ openId: PRINCIPAL_ID }) },
    }),
    replacer: /** @type {never} */ ({
      async replace() {
        writes += 1
        controller.abort()
      },
    }),
  })
  const coordinator = new FeishuOAuthReauthorizationCoordinator({
    journal,
    persister,
    now: () => NOW,
  })

  assert.deepEqual(
    await coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      controller.signal,
    ),
    { status: 'reauthorized', obtainedAt: REAUTHORIZED_AT },
  )
  assert.equal(writes, 1)
  assert.equal((await journal.inspect())?.state, 'reauthorized')
})

test('pre-write cancellation restores the durable reauthorization requirement', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-cancelled-verify-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  const controller = new AbortController()
  let writes = 0
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get() {
          controller.abort()
          controller.signal.throwIfAborted()
          return { openId: PRINCIPAL_ID }
        },
      },
    }),
    replacer: /** @type {never} */ ({
      async replace() {
        writes += 1
      },
    }),
  })
  const coordinator = new FeishuOAuthReauthorizationCoordinator({
    journal,
    persister,
    now: () => NOW,
  })

  await assert.rejects(
    coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      controller.signal,
    ),
    { name: 'AbortError' },
  )
  assert.equal(writes, 0)
  assert.equal((await journal.inspect())?.state, 'reauthorization_required')
})

test('uncertain Keychain and post-write journal failures require explicit reconciliation', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-uncertain-')
  const keychainJournal = new FeishuOAuthRotationJournal(join(root, 'keychain.jsonl'))
  await block(keychainJournal)
  const uncertainKeychain = fixture(keychainJournal, {
    replace: async () => {
      throw new Error(PRIVATE_REFRESH_TOKEN)
    },
  })
  await assert.rejects(
    uncertainKeychain.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReauthorizationError &&
      error.code === 'persistence_uncertain' &&
      error.recovery === 'reconcile_keychain' &&
      !error.message.includes(PRIVATE_REFRESH_TOKEN),
  )
  assert.equal((await keychainJournal.inspect())?.state, 'reauthorization_reserved')

  class AmbiguousJournal extends FeishuOAuthRotationJournal {
    /**
     * @override
     * @param {string} recordedAt
     * @param {(blocked: import('../packages/plugin-feishu/dist/index.js').FeishuOAuthRotationSnapshot) => Promise<Readonly<{recordedAt: string, resultObtainedAt: string}>>} replace
     * @returns {Promise<import('../packages/plugin-feishu/dist/index.js').FeishuOAuthRotationSnapshot>}
     */
    async replaceAfterReauthorization(recordedAt, replace) {
      await super.replaceAfterReauthorization(recordedAt, replace)
      throw new Error(PRIVATE_ACCESS_TOKEN)
    }
  }
  const journal = new AmbiguousJournal(join(root, 'journal.jsonl'))
  await block(journal)
  const uncertainJournal = fixture(journal)
  await assert.rejects(
    uncertainJournal.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReauthorizationError &&
      error.code === 'journal_uncertain' &&
      error.recovery === 'reconcile_rotation' &&
      !error.message.includes(PRIVATE_ACCESS_TOKEN),
  )
  assert.equal((await journal.inspect())?.state, 'reauthorized')
})

test('a journal that is not blocked rejects before verification or persistence', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-not-pending-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  const current = fixture(journal)
  await assert.rejects(
    current.coordinator.replace(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthReauthorizationError &&
      error.code === 'reauthorization_not_pending',
  )
  assert.deepEqual(current.counts(), { verifications: 0, writes: 0 })
  assert.equal(await journal.inspect(), undefined)
})

test('hostile options and replacement evidence fail without evaluating accessors or writing', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-reauthorization-hostile-')
  const journal = new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
  await block(journal)
  const current = fixture(journal)

  let optionAccessed = false
  const hostileOptions = Object.defineProperty(
    { persister: current.persister, now: () => NOW },
    'journal',
    {
      enumerable: true,
      get() {
        optionAccessed = true
        return journal
      },
    },
  )
  assert.throws(
    () => new FeishuOAuthReauthorizationCoordinator(/** @type {never} */ (hostileOptions)),
    (error) => error instanceof FeishuOAuthReauthorizationError && error.code === 'invalid_request',
  )
  assert.equal(optionAccessed, false)

  let evidenceAccessed = false
  await assert.rejects(
    journal.replaceAfterReauthorization(
      REAUTHORIZED_AT,
      async () =>
        /** @type {never} */ (
          Object.defineProperty({ resultObtainedAt: REAUTHORIZED_AT }, 'recordedAt', {
            enumerable: true,
            get() {
              evidenceAccessed = true
              return REAUTHORIZED_AT
            },
          })
        ),
    ),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'invalid_request',
  )
  assert.equal(evidenceAccessed, false)
  assert.equal(current.counts().writes, 0)
  assert.equal((await journal.inspect())?.state, 'reauthorization_reserved')
})
