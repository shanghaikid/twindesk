import assert from 'node:assert/strict'
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationError,
  FeishuOAuthRotationJournal,
  FeishuOAuthV3TokenRefresher,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_rotation_coordinator'
const PRINCIPAL_ID = 'ou_synthetic_rotation_coordinator'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-coordinator-client-secret'
const PRIVATE_OLD_ACCESS_TOKEN = 'synthetic-private-coordinator-old-access'
const PRIVATE_OLD_REFRESH_TOKEN = 'synthetic-private-coordinator-old-refresh'
const PRIVATE_NEW_ACCESS_TOKEN = 'synthetic-private-coordinator-new-access'
const PRIVATE_NEW_REFRESH_TOKEN = 'synthetic-private-coordinator-new-refresh'
const SOURCE_OBTAINED_AT = '2026-08-28T07:00:00.000Z'
const ROTATED_OBTAINED_AT = '2026-08-28T10:00:00.000Z'
const NOW = Date.parse(ROTATED_OBTAINED_AT)

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
    accountId: 'feishu-account:synthetic-rotation-coordinator',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Rotation Coordinator User',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-rotation-coordinator',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {{rotated?: boolean}} [options] */
function bundle(options = {}) {
  const rotated = options.rotated === true
  return new Uint8Array(
    Buffer.from(
      JSON.stringify({
        kind: 'feishu_user_oauth_credential_bundle',
        schemaVersion: 1,
        appId: APP_ID,
        principalId: PRINCIPAL_ID,
        clientSecret: PRIVATE_CLIENT_SECRET,
        tokenType: 'Bearer',
        accessToken: rotated ? PRIVATE_NEW_ACCESS_TOKEN : PRIVATE_OLD_ACCESS_TOKEN,
        obtainedAt: rotated ? ROTATED_OBTAINED_AT : SOURCE_OBTAINED_AT,
        accessTokenExpiresAt: rotated ? '2026-08-28T12:00:00.000Z' : '2026-08-28T09:00:00.000Z',
        refreshToken: rotated ? PRIVATE_NEW_REFRESH_TOKEN : PRIVATE_OLD_REFRESH_TOKEN,
        refreshTokenExpiresAt: rotated ? '2026-09-04T10:00:00.000Z' : '2026-09-04T07:00:00.000Z',
        scopes: ['im:message', 'offline_access'],
      }),
      'utf8',
    ),
  )
}

function successBody() {
  return new Uint8Array(
    Buffer.from(
      JSON.stringify({
        code: 0,
        access_token: PRIVATE_NEW_ACCESS_TOKEN,
        expires_in: 7200,
        refresh_token: PRIVATE_NEW_REFRESH_TOKEN,
        refresh_token_expires_in: 604800,
        scope: 'offline_access im:message',
        token_type: 'Bearer',
      }),
      'utf8',
    ),
  )
}

/**
 * @param {string} journalPath
 * @param {{value: Uint8Array}} keychain
 * @param {(request: unknown, signal: AbortSignal) => Promise<{status: number, body: Uint8Array}>} send
 * @param {FeishuOAuthRotationJournal} [journal]
 */
function coordinatorOptions(journalPath, keychain, send, journal) {
  return {
    now: () => NOW,
    journal: journal ?? new FeishuOAuthRotationJournal(journalPath),
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          return new Uint8Array(keychain.value)
        },
      },
    }),
    refresher: new FeishuOAuthV3TokenRefresher({ now: () => NOW, transport: { send } }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: {
        async replace(_request, secret) {
          keychain.value = new Uint8Array(secret)
        },
      },
    }),
  }
}

/**
 * @param {string} journalPath
 * @param {{value: Uint8Array}} keychain
 * @param {(request: unknown, signal: AbortSignal) => Promise<{status: number, body: Uint8Array}>} send
 * @param {FeishuOAuthRotationJournal} [journal]
 */
function coordinator(journalPath, keychain, send, journal) {
  return new FeishuOAuthRotationCoordinator(
    coordinatorOptions(journalPath, keychain, send, journal),
  )
}

test('a durable reservation precedes one refresh and the completed bundle survives restart', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-rotation-')
  const journalPath = join(root, 'rotation.jsonl')
  const keychain = { value: bundle() }
  let calls = 0
  const first = coordinator(journalPath, keychain, async () => {
    calls += 1
    const journal = await readFile(journalPath, 'utf8')
    assert.match(journal, /"state":"reserved"/u)
    return { status: 200, body: successBody() }
  })
  assert.deepEqual(await first.refreshIfNeeded(configuration(), new AbortController().signal), {
    status: 'rotated',
    obtainedAt: ROTATED_OBTAINED_AT,
  })
  assert.equal(calls, 1)
  const stored = Buffer.from(keychain.value).toString('utf8')
  assert.match(stored, new RegExp(PRIVATE_NEW_REFRESH_TOKEN, 'u'))
  assert.doesNotMatch(stored, new RegExp(PRIVATE_OLD_REFRESH_TOKEN, 'u'))

  const restarted = coordinator(journalPath, keychain, async () => {
    calls += 1
    return { status: 200, body: successBody() }
  })
  assert.deepEqual(await restarted.refreshIfNeeded(configuration(), new AbortController().signal), {
    status: 'not_required',
    obtainedAt: ROTATED_OBTAINED_AT,
  })
  assert.equal(calls, 1)
  const journal = await readFile(journalPath, 'utf8')
  assert.match(journal, /"state":"completed"/u)
  for (const privateValue of [
    APP_ID,
    PRINCIPAL_ID,
    'secret-ref:synthetic-rotation-coordinator',
    PRIVATE_CLIENT_SECRET,
    PRIVATE_OLD_REFRESH_TOKEN,
    PRIVATE_NEW_REFRESH_TOKEN,
  ]) {
    assert.doesNotMatch(journal, new RegExp(privateValue, 'u'))
  }
})

test('restart reconciles a Keychain update committed after only the reservation was durable', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-recovery-')
  const originalPath = join(root, 'reserved.jsonl')
  await new FeishuOAuthRotationJournal(originalPath).reserve(
    SOURCE_OBTAINED_AT,
    ROTATED_OBTAINED_AT,
  )
  const restartedPath = join(root, 'restarted.jsonl')
  await copyFile(originalPath, restartedPath)
  const keychain = { value: bundle({ rotated: true }) }
  let calls = 0
  const result = await coordinator(restartedPath, keychain, async () => {
    calls += 1
    return { status: 200, body: successBody() }
  }).refreshIfNeeded(configuration(), new AbortController().signal)
  assert.deepEqual(result, { status: 'recovered', obtainedAt: ROTATED_OBTAINED_AT })
  assert.equal(calls, 0)
  assert.equal((await new FeishuOAuthRotationJournal(restartedPath).inspect())?.state, 'completed')
})

test('an unproven remote outcome stays uncertain across restart and never reuses the old token', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-uncertain-')
  const journalPath = join(root, 'rotation.jsonl')
  const keychain = { value: bundle() }
  let calls = 0
  const active = coordinator(journalPath, keychain, async () => {
    calls += 1
    throw new Error(PRIVATE_OLD_REFRESH_TOKEN)
  })
  await assert.rejects(
    active.refreshIfNeeded(configuration(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthRotationError &&
      error.code === 'rotation_uncertain' &&
      !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
  )
  assert.equal(calls, 1)
  assert.equal((await new FeishuOAuthRotationJournal(journalPath).inspect())?.state, 'uncertain')

  await assert.rejects(
    coordinator(journalPath, keychain, async () => {
      calls += 1
      return { status: 200, body: successBody() }
    }).refreshIfNeeded(configuration(), new AbortController().signal),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'rotation_uncertain',
  )
  assert.equal(calls, 1)
})

test('explicit invalid refresh state is durable and requires new authorization', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-reauthorize-')
  const journalPath = join(root, 'rotation.jsonl')
  const keychain = { value: bundle() }
  let calls = 0
  await assert.rejects(
    coordinator(journalPath, keychain, async () => {
      calls += 1
      return {
        status: 400,
        body: new Uint8Array(
          Buffer.from(
            JSON.stringify({
              code: 20037,
              error: 'invalid_grant',
              error_description: PRIVATE_OLD_REFRESH_TOKEN,
            }),
          ),
        ),
      }
    }).refreshIfNeeded(configuration(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthRotationError &&
      error.code === 'reauthorization_required' &&
      !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
  )
  assert.equal(calls, 1)
  assert.equal(
    (await new FeishuOAuthRotationJournal(journalPath).inspect())?.state,
    'reauthorization_required',
  )
})

test('concurrent refresh attempts share one reservation and make one remote call', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-concurrent-')
  const journalPath = join(root, 'rotation.jsonl')
  const keychain = { value: bundle() }
  let calls = 0
  /** @type {() => void} */
  let release = () => assert.fail('release callback was not initialized')
  /** @type {() => void} */
  let started = () => assert.fail('start callback was not initialized')
  const startedPromise = new Promise((resolve) => {
    started = () => resolve(undefined)
  })
  const releasePromise = new Promise((resolve) => {
    release = () => resolve(undefined)
  })
  const active = coordinator(journalPath, keychain, async () => {
    calls += 1
    started()
    await releasePromise
    return { status: 200, body: successBody() }
  })
  const first = active.refreshIfNeeded(configuration(), new AbortController().signal)
  await startedPromise
  await assert.rejects(
    active.refreshIfNeeded(configuration(), new AbortController().signal),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'rotation_pending',
  )
  release()
  assert.equal((await first).status, 'rotated')
  assert.equal(calls, 1)
})

test('cancellation after reservation persists uncertainty before propagating', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-cancel-')
  const journalPath = join(root, 'rotation.jsonl')
  const keychain = { value: bundle() }
  const controller = new AbortController()
  const active = coordinator(journalPath, keychain, async (_request, signal) => {
    controller.abort()
    signal.throwIfAborted()
    return { status: 200, body: successBody() }
  })
  await assert.rejects(active.refreshIfNeeded(configuration(), controller.signal), {
    name: 'AbortError',
  })
  assert.equal((await new FeishuOAuthRotationJournal(journalPath).inspect())?.state, 'uncertain')
})

test('an ambiguous completion commit is not followed by a contradictory settlement', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-completion-')
  const journalPath = join(root, 'rotation.jsonl')
  class AmbiguousCompletionJournal extends FeishuOAuthRotationJournal {
    /** @param {string} path */
    constructor(path) {
      super(path)
      /** @type {string[]} */
      this.states = []
    }

    /**
     * @override
     * @param {number} sequence
     * @param {'completed' | 'uncertain' | 'reauthorization_required'} state
     * @param {string} recordedAt
     * @param {string} [resultObtainedAt]
     */
    async settle(sequence, state, recordedAt, resultObtainedAt) {
      this.states.push(state)
      const result = await super.settle(sequence, state, recordedAt, resultObtainedAt)
      if (state === 'completed') throw new Error(PRIVATE_NEW_REFRESH_TOKEN)
      return result
    }
  }
  const journal = new AmbiguousCompletionJournal(journalPath)
  await assert.rejects(
    coordinator(
      journalPath,
      { value: bundle() },
      async () => ({ status: 200, body: successBody() }),
      journal,
    ).refreshIfNeeded(configuration(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthRotationError &&
      error.code === 'rotation_uncertain' &&
      !error.message.includes(PRIVATE_NEW_REFRESH_TOKEN),
  )
  assert.deepEqual(journal.states, ['completed'])
  assert.equal((await journal.inspect())?.state, 'completed')
})

test('coordinator options and timestamps fail closed without invoking accessors', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-validation-')
  const journalPath = join(root, 'rotation.jsonl')
  const options = coordinatorOptions(journalPath, { value: bundle() }, async () => ({
    status: 200,
    body: successBody(),
  }))
  for (const invalid of [
    { ...options, now: null },
    { ...options, resolver: {} },
    { ...options, unknown: PRIVATE_OLD_REFRESH_TOKEN },
  ]) {
    assert.throws(
      () => new FeishuOAuthRotationCoordinator(/** @type {never} */ (invalid)),
      (error) =>
        error instanceof FeishuOAuthRotationError &&
        error.code === 'invalid_request' &&
        !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
    )
  }

  let accessed = false
  const hostile = Object.defineProperty({ ...options }, 'journal', {
    enumerable: true,
    get() {
      accessed = true
      return options.journal
    },
  })
  assert.throws(
    () => new FeishuOAuthRotationCoordinator(hostile),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'invalid_request',
  )
  assert.equal(accessed, false)

  await assert.rejects(
    options.journal.reserve('2026-99-28T07:00:00.000Z', ROTATED_OBTAINED_AT),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'invalid_request',
  )
})

test('journal recovery repairs a torn tail and rejects unsafe storage', async (context) => {
  const root = await temporaryDirectory(context, 'feishu-oauth-journal-')
  const path = join(root, 'rotation.jsonl')
  const journal = new FeishuOAuthRotationJournal(path)
  await journal.reserve(SOURCE_OBTAINED_AT, ROTATED_OBTAINED_AT)
  await appendFile(path, '{"kind":"feishu_oauth_rotation_event"')
  const copied = join(root, 'copied.jsonl')
  await copyFile(path, copied)
  assert.equal((await new FeishuOAuthRotationJournal(copied).inspect())?.state, 'reserved')
  assert.equal((await readFile(copied)).at(-1), 0x0a)

  const publicPath = join(root, 'public.jsonl')
  await copyFile(copied, publicPath)
  await chmod(publicPath, 0o644)
  await assert.rejects(
    new FeishuOAuthRotationJournal(publicPath).inspect(),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'unsafe_file',
  )

  const target = join(root, 'target.jsonl')
  await mkdir(join(root, 'links'))
  await copyFile(copied, target)
  const link = join(root, 'links', 'rotation.jsonl')
  await symlink(target, link)
  await assert.rejects(
    new FeishuOAuthRotationJournal(link).inspect(),
    (error) => error instanceof FeishuOAuthRotationError && error.code === 'unsafe_file',
  )
})
