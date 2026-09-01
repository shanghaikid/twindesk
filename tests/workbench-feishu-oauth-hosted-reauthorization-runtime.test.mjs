import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WorkbenchFeishuOAuthHostedReauthorizationError,
  createWorkbenchFeishuOAuthHostedReauthorizationHost,
  loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost,
  loadWorkbenchFeishuOAuthHostedReauthorizationHost,
} from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthLoopbackCallbackHost,
  FeishuOAuthRotationJournal,
  FeishuOAuthUserPrincipalVerifier,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
} from '../packages/plugin-feishu/dist/index.js'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const CLIENT_SECRET = 'synthetic-private-hosted-reauthorization-secret'
const ACCESS_TOKEN = 'synthetic-private-hosted-reauthorization-access'
const REFRESH_TOKEN = 'synthetic-private-hosted-reauthorization-refresh'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-hosted-reauthorization',
  appId: 'cli_synthetic_hosted_reauthorization',
  user: Object.freeze({
    identityType: 'user',
    principalId: 'ou_synthetic_hosted_reauthorization',
    displayName: 'Synthetic Hosted User',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-hosted-reauthorization',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

function tokenResponse() {
  return bytes(
    JSON.stringify({
      code: 0,
      access_token: ACCESS_TOKEN,
      expires_in: 3600,
      refresh_token: REFRESH_TOKEN,
      refresh_token_expires_in: 604800,
      scope: 'offline_access im:message:readonly',
      token_type: 'Bearer',
    }),
  )
}

class RecordingLeaseManager extends FeishuRuntimeLeaseManager {
  held = false
  entries = 0

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
    assert.equal(this.held, false)
    this.held = true
    this.entries += 1
    try {
      return await use({
        assertHeld: () => {
          if (!this.held) throw new Error('The synthetic reauthorization lease is not held.')
        },
      })
    } finally {
      this.held = false
    }
  }
}

/** @param {FeishuOAuthRotationJournal} journal */
async function block(journal) {
  const reservation = await journal.reserve('2026-08-31T11:00:00.000Z', '2026-08-31T11:30:00.000Z')
  await journal.settle(reservation.sequence, 'reauthorization_required', '2026-08-31T11:30:00.000Z')
}

/**
 * @param {{leaseManager: RecordingLeaseManager, onTransport?: (body: Uint8Array) => void, onVerify?: (token: Uint8Array) => void, onReplace?: (bundle: Uint8Array) => void}} options
 */
function collaborators(options) {
  let randomCall = 0
  return {
    leaseManager: options.leaseManager,
    flow: new FeishuOAuthAuthorizationFlow({
      now: () => NOW,
      randomBytes(length) {
        randomCall += 1
        return new Uint8Array(length).fill(randomCall)
      },
      transport: {
        async send(request) {
          options.onTransport?.(request.body)
          return { status: 200, body: tokenResponse() }
        },
      },
    }),
    persister: new FeishuOAuthInitialCredentialPersister({
      verifier: new FeishuOAuthUserPrincipalVerifier({
        client: {
          async get(request) {
            options.onVerify?.(request.accessToken)
            return { openId: CONFIGURATION.user.principalId }
          },
        },
      }),
      replacer: new FeishuSystemKeychainSecretReplacer({
        platform: 'darwin',
        runner: {
          async replace(_request, bundle) {
            options.onReplace?.(bundle)
          },
        },
      }),
    }),
  }
}

/** @param {import('node:test').TestContext} context @param {string} prefix */
async function temporaryDirectory(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-${prefix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  return root
}

/** @returns {Promise<{host: FeishuOAuthLoopbackCallbackHost, redirectUri: string}>} */
async function callbackHost() {
  const probe = await new FeishuOAuthLoopbackCallbackHost().listen(new AbortController().signal)
  const redirectUri = probe.redirectUri
  await probe.close()
  const redirect = new URL(redirectUri)
  return {
    host: new FeishuOAuthLoopbackCallbackHost({
      port: Number(redirect.port),
      path: '/oauth/feishu/callback',
      timeoutMs: 2_000,
    }),
    redirectUri: `http://127.0.0.1:${redirect.port}/oauth/feishu/callback`,
  }
}

test('Workbench holds one lease across blocked-state callback, exchange, and replacement', async (context) => {
  const root = await temporaryDirectory(context, 'hosted-reauthorization')
  const journalPath = join(root, 'rotation.jsonl')
  const journal = new FeishuOAuthRotationJournal(journalPath)
  await block(journal)
  const callback = await callbackHost()
  const leaseManager = new RecordingLeaseManager()
  /** @type {Uint8Array | undefined} */
  let exchangeBody
  /** @type {Uint8Array | undefined} */
  let verificationToken
  /** @type {Uint8Array | undefined} */
  let replacementBundle
  const host = createWorkbenchFeishuOAuthHostedReauthorizationHost({
    configuration: CONFIGURATION,
    authorization: {
      kind: 'feishu_oauth_authorization_configuration',
      schemaVersion: 1,
      connectorId: 'feishu',
      appId: CONFIGURATION.appId,
      redirectUri: callback.redirectUri,
      scopes: ['im:message:readonly', 'offline_access'],
    },
    journal,
    callbackHost: callback.host,
    ...collaborators({
      leaseManager,
      onTransport(body) {
        assert.equal(leaseManager.held, true)
        exchangeBody = body
      },
      onVerify(token) {
        assert.equal(leaseManager.held, true)
        verificationToken = token
      },
      onReplace(bundle) {
        assert.equal(leaseManager.held, true)
        replacementBundle = bundle
      },
    }),
  })
  const clientSecret = bytes(CLIENT_SECRET)
  const result = await host.reauthorize(
    clientSecret,
    new AbortController().signal,
    async (request) => {
      assert.equal(leaseManager.held, true)
      assert.equal(request.redirectUri, callback.redirectUri)
      const state = new URL(request.authorizationUrl).searchParams.get('state')
      assert.ok(state !== null)
      assert.equal(
        (await fetch(`${request.redirectUri}?code=synthetic_reauthorization_code&state=${state}`))
          .status,
        200,
      )
    },
  )

  assert.deepEqual(result, { status: 'reauthorized', obtainedAt: '2026-08-31T12:00:00.000Z' })
  assert.equal((await journal.inspect())?.state, 'reauthorized')
  assert.deepEqual(
    { entries: leaseManager.entries, held: leaseManager.held },
    { entries: 1, held: false },
  )
  assert.equal(new TextDecoder().decode(clientSecret), CLIENT_SECRET)
  for (const transient of [exchangeBody, verificationToken, replacementBundle]) {
    assert.ok(transient instanceof Uint8Array)
    assert.equal(
      transient.every((value) => value === 0),
      true,
    )
  }
  const document = await readFile(journalPath, 'utf8')
  for (const privateValue of [
    CONFIGURATION.appId,
    CONFIGURATION.user.principalId,
    CONFIGURATION.user.credentialReference.id,
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
  ]) {
    assert.equal(document.includes(privateValue), false)
  }
})

test('Workbench rejects a non-pending journal before callback or exchange', async () => {
  const journal = new FeishuOAuthRotationJournal(
    join(tmpdir(), `twindesk-non-pending-hosted-reauthorization-${randomUUID()}.jsonl`),
  )
  const callback = await callbackHost()
  const leaseManager = new RecordingLeaseManager()
  let transports = 0
  let presentations = 0
  const host = createWorkbenchFeishuOAuthHostedReauthorizationHost({
    configuration: CONFIGURATION,
    authorization: {
      kind: 'feishu_oauth_authorization_configuration',
      schemaVersion: 1,
      connectorId: 'feishu',
      appId: CONFIGURATION.appId,
      redirectUri: callback.redirectUri,
      scopes: ['offline_access'],
    },
    journal,
    callbackHost: callback.host,
    ...collaborators({
      leaseManager,
      onTransport() {
        transports += 1
      },
    }),
  })
  await assert.rejects(
    host.reauthorize(bytes(CLIENT_SECRET), new AbortController().signal, () => {
      presentations += 1
    }),
    (error) =>
      error instanceof WorkbenchFeishuOAuthHostedReauthorizationError &&
      error.code === 'reauthorization_not_pending' &&
      error.recovery === 'do_not_retry',
  )
  assert.deepEqual(
    { transports, presentations, entries: leaseManager.entries, held: leaseManager.held },
    { transports: 0, presentations: 0, entries: 1, held: false },
  )
})

test('Workbench reloads Settings and the blocked journal before hosted reauthorization', async (context) => {
  const root = await temporaryDirectory(context, 'hosted-reauthorization-restart')
  const identityPath = join(root, 'identity.json')
  const authorizationPath = join(root, 'authorization.json')
  const journalPath = join(root, 'rotation.jsonl')
  const callback = await callbackHost()
  await new FeishuIdentityConfigurationStore(identityPath).write(CONFIGURATION)
  await new FeishuOAuthAuthorizationConfigurationStore(authorizationPath).write({
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: CONFIGURATION.appId,
    redirectUri: callback.redirectUri,
    scopes: ['offline_access'],
  })
  await block(new FeishuOAuthRotationJournal(journalPath))
  const productionHost = await loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost({
    identityStore: new FeishuIdentityConfigurationStore(identityPath),
    authorizationStore: new FeishuOAuthAuthorizationConfigurationStore(authorizationPath),
    journal: new FeishuOAuthRotationJournal(journalPath),
  })
  assert.equal(typeof productionHost.reauthorize, 'function')
  const leaseManager = new RecordingLeaseManager()
  const host = await loadWorkbenchFeishuOAuthHostedReauthorizationHost({
    identityStore: new FeishuIdentityConfigurationStore(identityPath),
    authorizationStore: new FeishuOAuthAuthorizationConfigurationStore(authorizationPath),
    journal: new FeishuOAuthRotationJournal(journalPath),
    ...collaborators({ leaseManager }),
  })
  const result = await host.reauthorize(
    bytes(CLIENT_SECRET),
    new AbortController().signal,
    async (request) => {
      const state = new URL(request.authorizationUrl).searchParams.get('state')
      assert.ok(state !== null)
      await fetch(`${request.redirectUri}?code=synthetic_restart_code&state=${state}`)
    },
  )
  assert.equal(result.status, 'reauthorized')
  assert.equal((await new FeishuOAuthRotationJournal(journalPath).inspect())?.state, 'reauthorized')
})

test('hosted reauthorization rejects missing Settings and hostile options before access', async (context) => {
  const root = await temporaryDirectory(context, 'hosted-reauthorization-invalid')
  const callback = await callbackHost()
  const leaseManager = new RecordingLeaseManager()
  const collaboratorsValue = collaborators({ leaseManager })
  await assert.rejects(
    loadWorkbenchFeishuOAuthHostedReauthorizationHost({
      identityStore: new FeishuIdentityConfigurationStore(join(root, 'identity.json')),
      authorizationStore: new FeishuOAuthAuthorizationConfigurationStore(
        join(root, 'authorization.json'),
      ),
      journal: new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl')),
      ...collaboratorsValue,
    }),
    (error) =>
      error instanceof WorkbenchFeishuOAuthHostedReauthorizationError &&
      error.code === 'identity_configuration_missing',
  )

  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'configuration', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-hosted-reauthorization-option')
    },
  })
  assert.throws(
    () => createWorkbenchFeishuOAuthHostedReauthorizationHost(/** @type {never} */ (hostile)),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
  assert.equal(leaseManager.entries, 0)
})
