import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WorkbenchFeishuOAuthAuthorizationError,
  createWorkbenchFeishuOAuthAuthorizationHost,
} from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthLoopbackCallbackError,
  FeishuOAuthLoopbackCallbackHost,
  FeishuOAuthUserPrincipalVerifier,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const CLIENT_SECRET = 'synthetic-private-authorization-runtime-secret'
const ACCESS_TOKEN = 'synthetic-private-authorization-runtime-access'
const REFRESH_TOKEN = 'synthetic-private-authorization-runtime-refresh'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-authorization-runtime',
  appId: 'cli_synthetic_authorization_runtime',
  user: Object.freeze({
    identityType: 'user',
    principalId: 'ou_synthetic_authorization_runtime',
    displayName: 'Synthetic User',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-authorization-runtime',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

function missingError() {
  return Object.assign(new Error('synthetic missing credential'), { code: 44 })
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
          if (!this.held) throw new Error('The synthetic lease is not held.')
        },
      })
    } finally {
      this.held = false
    }
  }
}

/**
 * @param {{leaseManager: RecordingLeaseManager, resolver: FeishuSystemKeychainSecretResolver, authorizationAppId?: string, callbackHost?: FeishuOAuthLoopbackCallbackHost, onTransport?: (request: import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TransportRequest) => void, onVerify?: (token: Uint8Array) => void, onReplace?: (bundle: Uint8Array) => void}} options
 */
async function runtime(options) {
  const probe = await new FeishuOAuthLoopbackCallbackHost().listen(new AbortController().signal)
  const port = Number(new URL(probe.redirectUri).port)
  await probe.close()
  let randomCall = 0
  return createWorkbenchFeishuOAuthAuthorizationHost({
    configuration: CONFIGURATION,
    authorization: {
      kind: 'feishu_oauth_authorization_configuration',
      schemaVersion: 1,
      connectorId: 'feishu',
      appId: options.authorizationAppId ?? CONFIGURATION.appId,
      redirectUri: `http://127.0.0.1:${port}/oauth/feishu/callback`,
      scopes: ['im:message:readonly', 'offline_access'],
    },
    leaseManager: options.leaseManager,
    resolver: options.resolver,
    callbackHost:
      options.callbackHost ?? new FeishuOAuthLoopbackCallbackHost({ port, timeoutMs: 2_000 }),
    flow: new FeishuOAuthAuthorizationFlow({
      now: () => NOW,
      randomBytes(length) {
        randomCall += 1
        return new Uint8Array(length).fill(randomCall)
      },
      transport: {
        async send(request) {
          options.onTransport?.(request)
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
  })
}

test('Workbench holds one lease from loopback capture through verified initial persistence', async () => {
  const leaseManager = new RecordingLeaseManager()
  let absenceChecks = 0
  /** @type {Uint8Array | undefined} */
  let exchangeBody
  /** @type {Uint8Array | undefined} */
  let verificationToken
  /** @type {Uint8Array | undefined} */
  let replacementBundle
  /** @type {Uint8Array | undefined} */
  let storedBundle
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        absenceChecks += 1
        assert.equal(leaseManager.held, true)
        throw missingError()
      },
    },
  })
  const host = await runtime({
    leaseManager,
    resolver,
    onTransport(request) {
      assert.equal(leaseManager.held, true)
      exchangeBody = request.body
    },
    onVerify(token) {
      assert.equal(leaseManager.held, true)
      verificationToken = token
    },
    onReplace(bundle) {
      assert.equal(leaseManager.held, true)
      replacementBundle = bundle
      storedBundle = new Uint8Array(bundle)
    },
  })
  const clientSecret = bytes(CLIENT_SECRET)
  let presented = 0
  const result = await host.authorize(
    clientSecret,
    new AbortController().signal,
    async (request) => {
      presented += 1
      assert.equal(leaseManager.held, true)
      assert.equal(Object.isFrozen(request), true)
      assert.equal(request.redirectUri.startsWith('http://127.0.0.1:'), true)
      const authorization = new URL(request.authorizationUrl)
      assert.equal(authorization.searchParams.get('client_id'), CONFIGURATION.appId)
      assert.equal(authorization.searchParams.get('redirect_uri'), request.redirectUri)
      assert.equal(authorization.searchParams.get('scope'), 'im:message:readonly offline_access')
      const state = authorization.searchParams.get('state')
      assert.ok(state !== null)
      assert.equal(
        (await fetch(`${request.redirectUri}?code=synthetic_runtime_code&state=${state}`)).status,
        200,
      )
    },
  )

  assert.deepEqual(result, { status: 'persisted', obtainedAt: '2026-08-31T12:00:00.000Z' })
  assert.deepEqual(
    { absenceChecks, presented, leaseEntries: leaseManager.entries, held: leaseManager.held },
    { absenceChecks: 2, presented: 1, leaseEntries: 1, held: false },
  )
  assert.equal(new TextDecoder().decode(clientSecret), CLIENT_SECRET)
  for (const transient of [exchangeBody, verificationToken, replacementBundle]) {
    assert.ok(transient instanceof Uint8Array)
    assert.equal(
      transient.every((byte) => byte === 0),
      true,
    )
  }
  assert.ok(storedBundle instanceof Uint8Array)
  assert.equal(
    storedBundle.every((byte) => byte === 0),
    false,
  )
})

test('Workbench refuses initial authorization when a credential already exists', async () => {
  const leaseManager = new RecordingLeaseManager()
  const existing = bytes('synthetic-private-existing-credential')
  let presented = 0
  let transports = 0
  const host = await runtime({
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => existing },
    }),
    onTransport() {
      transports += 1
    },
  })

  await assert.rejects(
    host.authorize(bytes(CLIENT_SECRET), new AbortController().signal, () => {
      presented += 1
    }),
    (error) =>
      error instanceof WorkbenchFeishuOAuthAuthorizationError &&
      error.code === 'credential_exists' &&
      error.recovery === 'use_reauthorization',
  )
  assert.deepEqual(
    { presented, transports, leaseEntries: leaseManager.entries, held: leaseManager.held },
    { presented: 0, transports: 0, leaseEntries: 1, held: false },
  )
  assert.equal(
    existing.every((byte) => byte === 0),
    true,
  )
})

test('Workbench rejects app and listener mismatches before presentation', async () => {
  let resolverReads = 0
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        resolverReads += 1
        throw missingError()
      },
    },
  })
  await assert.rejects(
    runtime({
      leaseManager: new RecordingLeaseManager(),
      resolver,
      authorizationAppId: 'cli_other_registered_app',
    }),
    TypeError,
  )

  let presented = 0
  const leaseManager = new RecordingLeaseManager()
  const host = await runtime({
    leaseManager,
    resolver,
    callbackHost: new FeishuOAuthLoopbackCallbackHost({ timeoutMs: 2_000 }),
  })
  await assert.rejects(
    host.authorize(bytes(CLIENT_SECRET), new AbortController().signal, () => {
      presented += 1
    }),
    (error) =>
      error instanceof WorkbenchFeishuOAuthAuthorizationError &&
      error.code === 'redirect_mismatch' &&
      error.recovery === 'correct_configuration',
  )
  assert.equal(presented, 0)
  assert.equal(resolverReads, 0)
  assert.equal(leaseManager.held, false)
})

test('Workbench rechecks absence after callback and before consuming the code', async () => {
  const leaseManager = new RecordingLeaseManager()
  const lateCredential = bytes('synthetic-private-late-credential')
  let checks = 0
  let transports = 0
  let replacements = 0
  const host = await runtime({
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          checks += 1
          if (checks === 1) throw missingError()
          return lateCredential
        },
      },
    }),
    onTransport() {
      transports += 1
    },
    onReplace() {
      replacements += 1
    },
  })

  await assert.rejects(
    host.authorize(bytes(CLIENT_SECRET), new AbortController().signal, async (request) => {
      const state = new URL(request.authorizationUrl).searchParams.get('state')
      assert.ok(state !== null)
      assert.equal(
        (await fetch(`${request.redirectUri}?code=synthetic_late_code&state=${state}`)).status,
        200,
      )
    }),
    (error) =>
      error instanceof WorkbenchFeishuOAuthAuthorizationError && error.code === 'credential_exists',
  )
  assert.deepEqual(
    { checks, transports, replacements, held: leaseManager.held },
    { checks: 2, transports: 0, replacements: 0, held: false },
  )
  assert.equal(
    lateCredential.every((byte) => byte === 0),
    true,
  )
})

test('Workbench rechecks lease ownership immediately before Keychain replacement', async () => {
  const leaseManager = new RecordingLeaseManager()
  let replacements = 0
  const host = await runtime({
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => Promise.reject(missingError()) },
    }),
    onVerify() {
      leaseManager.held = false
    },
    onReplace() {
      replacements += 1
    },
  })

  await assert.rejects(
    host.authorize(bytes(CLIENT_SECRET), new AbortController().signal, async (request) => {
      const state = new URL(request.authorizationUrl).searchParams.get('state')
      assert.ok(state !== null)
      assert.equal(
        (await fetch(`${request.redirectUri}?code=synthetic_lost_lease&state=${state}`)).status,
        200,
      )
    }),
    (error) => error instanceof Error && error.message === 'The synthetic lease is not held.',
  )
  assert.equal(replacements, 0)
  assert.equal(leaseManager.held, false)
})

test('Workbench closes the callback listener when presentation fails', async () => {
  const leaseManager = new RecordingLeaseManager()
  let absenceChecks = 0
  let redirectUri = ''
  const host = await runtime({
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          absenceChecks += 1
          throw missingError()
        },
      },
    }),
  })
  const presentationFailure = new Error('synthetic presentation failure')
  await assert.rejects(
    host.authorize(bytes(CLIENT_SECRET), new AbortController().signal, (request) => {
      redirectUri = request.redirectUri
      throw presentationFailure
    }),
    (error) => error === presentationFailure,
  )
  assert.equal(absenceChecks, 1)
  assert.equal(leaseManager.held, false)
  const port = Number(new URL(redirectUri).port)
  const restarted = await new FeishuOAuthLoopbackCallbackHost({ port }).listen(
    new AbortController().signal,
  )
  await restarted.close()
})

test('Workbench cancellation does not wait for a stalled presenter', async () => {
  const leaseManager = new RecordingLeaseManager()
  const controller = new AbortController()
  let redirectUri = ''
  const host = await runtime({
    leaseManager,
    resolver: new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => Promise.reject(missingError()) },
    }),
  })
  const pending = host.authorize(bytes(CLIENT_SECRET), controller.signal, (request) => {
    redirectUri = request.redirectUri
    controller.abort()
    return new Promise(() => undefined)
  })
  await assert.rejects(
    pending,
    (error) => error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'cancelled',
  )
  assert.equal(leaseManager.held, false)
  const restarted = await new FeishuOAuthLoopbackCallbackHost({
    port: Number(new URL(redirectUri).port),
  }).listen(new AbortController().signal)
  await restarted.close()
})
