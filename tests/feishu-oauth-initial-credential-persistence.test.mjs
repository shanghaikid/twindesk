import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuCredentialBundleParser,
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthCredentialBundleEncoder,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthInitialPersistenceError,
  FeishuOAuthUserPrincipalVerifier,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_initial_persistence'
const PRINCIPAL_ID = 'ou_synthetic_initial_persistence'
const OTHER_PRINCIPAL_ID = 'ou_synthetic_initial_other'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-initial-client-secret'
const PRIVATE_ACCESS_TOKEN = 'synthetic-private-initial-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-initial-refresh-token'
const REDIRECT_URI = 'http://127.0.0.1:43120/oauth/feishu/callback'
const NOW = Date.parse('2026-08-28T14:00:00.000Z')

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {Uint8Array} value */
function decoded(value) {
  return Buffer.from(value).toString('utf8')
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-initial-persistence',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Initial Persistence User',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-initial-persistence',
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
    obtainedAt: '2026-08-28T14:00:00.000Z',
    accessTokenExpiresAt: '2026-08-28T16:00:00.000Z',
    refreshToken: bytes(PRIVATE_REFRESH_TOKEN),
    refreshTokenExpiresAt: '2026-09-04T14:00:00.000Z',
    scopes: ['im:message', 'im:message:readonly', 'offline_access'],
    ...changes,
  }
}

function tokenResponse() {
  return bytes(
    JSON.stringify({
      code: 0,
      access_token: PRIVATE_ACCESS_TOKEN,
      expires_in: 7200,
      refresh_token: PRIVATE_REFRESH_TOKEN,
      refresh_token_expires_in: 604800,
      scope: 'offline_access im:message:readonly im:message',
      token_type: 'Bearer',
    }),
  )
}

function matchingVerifier() {
  return new FeishuOAuthUserPrincipalVerifier({
    client: { get: async () => ({ openId: PRINCIPAL_ID }) },
  })
}

test('authorization exchange verifies open_id, writes one exact initial bundle, and restarts', async () => {
  const identityConfiguration = configuration()
  const clientSecret = bytes(PRIVATE_CLIENT_SECRET)
  const response = tokenResponse()
  /** @type {Uint8Array | undefined} */
  let userInfoToken
  /** @type {Uint8Array | undefined} */
  let stored
  let randomCall = 0
  const verifier = new FeishuOAuthUserPrincipalVerifier({
    client: {
      async get(request) {
        userInfoToken = request.accessToken
        return { openId: PRINCIPAL_ID }
      },
    },
  })
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier,
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: {
        async replace(request, secret) {
          assert.deepEqual(request.arguments.slice(-2), [
            identityConfiguration.user.credentialReference.id,
            '-w',
          ])
          stored = new Uint8Array(secret)
        },
      },
    }),
  })
  const flow = new FeishuOAuthAuthorizationFlow({
    now: () => NOW,
    randomBytes(length) {
      randomCall += 1
      return new Uint8Array(length).fill(randomCall)
    },
    transport: { send: async () => ({ status: 200, body: response }) },
  })
  const session = flow.start({
    clientId: APP_ID,
    clientSecret,
    redirectUri: REDIRECT_URI,
    scopes: ['offline_access', 'im:message', 'im:message:readonly'],
  })
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  await session.complete(
    `${REDIRECT_URI}?code=synthetic_initial_code&state=${state}`,
    new AbortController().signal,
    (freshTokenSet) =>
      persister.persist(
        identityConfiguration,
        clientSecret,
        freshTokenSet,
        new AbortController().signal,
      ),
  )

  assert.ok(userInfoToken !== undefined && zeroed(userInfoToken))
  assert.ok(zeroed(response))
  assert.ok(stored !== undefined)
  const persisted = stored
  const restarted = await new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: { run: async () => new Uint8Array(persisted) },
  }).withSecret(
    identityConfiguration.user.credentialReference,
    new AbortController().signal,
    (bundle) =>
      new FeishuCredentialBundleParser({ now: () => NOW + 30 * 60 * 1000 }).withCredential(
        identityConfiguration,
        'user',
        bundle,
        new AbortController().signal,
        (credential) => {
          assert.equal(credential.kind, 'feishu_user_oauth_credential_bundle')
          if (credential.kind !== 'feishu_user_oauth_credential_bundle') return undefined
          assert.equal(decoded(credential.clientSecret), PRIVATE_CLIENT_SECRET)
          assert.equal(decoded(credential.accessToken), PRIVATE_ACCESS_TOKEN)
          assert.equal(decoded(credential.refreshToken), PRIVATE_REFRESH_TOKEN)
          assert.equal(credential.accessTokenStatus, 'usable')
          assert.deepEqual(credential.scopes, [
            'im:message',
            'im:message:readonly',
            'offline_access',
          ])
          return credential.principalId
        },
      ),
  )
  assert.equal(restarted, PRINCIPAL_ID)
  persisted.fill(0)
  clientSecret.fill(0)
})

test('verification and persistence share one owned token snapshot', async () => {
  const source = tokenSet()
  /** @type {Uint8Array | undefined} */
  let observedVerificationToken
  /** @type {Uint8Array | undefined} */
  let stored
  /** @type {() => void} */
  let signalVerificationStarted = () => {
    throw new Error('Verification-start signal was not initialized.')
  }
  /** @type {Promise<void>} */
  const verificationStarted = new Promise((resolve) => {
    signalVerificationStarted = () => resolve()
  })
  /** @type {() => void} */
  let finishVerification = () => {
    throw new Error('Verification-finish signal was not initialized.')
  }
  /** @type {Promise<void>} */
  const verificationMayFinish = new Promise((resolve) => {
    finishVerification = () => resolve()
  })
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get(request) {
          observedVerificationToken = request.accessToken
          signalVerificationStarted()
          await verificationMayFinish
          return { openId: PRINCIPAL_ID }
        },
      },
    }),
    replacer: /** @type {never} */ ({
      /** @param {unknown} _reference @param {Uint8Array} bundle */
      async replace(_reference, bundle) {
        stored = new Uint8Array(bundle)
      },
    }),
  })

  const pending = persister.persist(
    configuration(),
    bytes(PRIVATE_CLIENT_SECRET),
    /** @type {never} */ (source),
    new AbortController().signal,
  )
  await verificationStarted
  source.accessToken.fill(0x58)
  source.refreshToken.fill(0x59)
  source.obtainedAt = '2026-08-28T15:00:00.000Z'
  source.accessTokenExpiresAt = '2026-08-28T17:00:00.000Z'
  source.refreshTokenExpiresAt = '2026-09-04T15:00:00.000Z'
  source.scopes = ['offline_access']
  finishVerification()
  await pending

  assert.ok(observedVerificationToken !== undefined && zeroed(observedVerificationToken))
  assert.ok(stored !== undefined)
  const bundle = JSON.parse(decoded(stored))
  assert.equal(bundle.accessToken, PRIVATE_ACCESS_TOKEN)
  assert.equal(bundle.refreshToken, PRIVATE_REFRESH_TOKEN)
  assert.equal(bundle.obtainedAt, '2026-08-28T14:00:00.000Z')
  assert.deepEqual(bundle.scopes, ['im:message', 'im:message:readonly', 'offline_access'])
  stored.fill(0)
})

test('a different principal never encodes or writes the initial credential', async () => {
  let writes = 0
  let observedToken
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get(request) {
          observedToken = request.accessToken
          return { openId: OTHER_PRINCIPAL_ID }
        },
      },
    }),
    replacer: /** @type {never} */ ({
      async replace() {
        writes += 1
      },
    }),
  })
  await assert.rejects(
    persister.persist(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthInitialPersistenceError &&
      error.code === 'identity_mismatch' &&
      error.recovery === 'reauthorize' &&
      !error.message.includes(OTHER_PRINCIPAL_ID),
  )
  assert.equal(writes, 0)
  assert.ok(observedToken !== undefined && zeroed(observedToken))
})

test('a malformed or unavailable post-code identity check requires fresh authorization', async () => {
  for (const get of [
    async () => ({ openId: PRINCIPAL_ID, privateName: PRIVATE_ACCESS_TOKEN }),
    async () => Promise.reject(new Error(PRIVATE_ACCESS_TOKEN)),
  ]) {
    let writes = 0
    await assert.rejects(
      new FeishuOAuthInitialCredentialPersister({
        verifier: new FeishuOAuthUserPrincipalVerifier({ client: { get } }),
        replacer: /** @type {never} */ ({
          async replace() {
            writes += 1
          },
        }),
      }).persist(
        configuration(),
        bytes(PRIVATE_CLIENT_SECRET),
        /** @type {never} */ (tokenSet()),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthInitialPersistenceError &&
        error.code === 'verification_unavailable' &&
        error.recovery === 'reauthorize' &&
        !error.message.includes(PRIVATE_ACCESS_TOKEN),
    )
    assert.equal(writes, 0)
  }
})

test('an uncertain Keychain replacement remains explicit and clears the encoded bundle', async () => {
  /** @type {Uint8Array | undefined} */
  let observedBundle
  const privateFailure = new Error(PRIVATE_REFRESH_TOKEN)
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: matchingVerifier(),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: {
        async replace(_request, bundle) {
          observedBundle = bundle
          throw privateFailure
        },
      },
    }),
  })
  await assert.rejects(
    persister.persist(
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthInitialPersistenceError &&
      error.code === 'persistence_uncertain' &&
      error.recovery === 'reconcile_keychain' &&
      !error.message.includes(PRIVATE_REFRESH_TOKEN),
  )
  assert.ok(observedBundle !== undefined && zeroed(observedBundle))
})

test('the persister owns and clears a non-iterated client-secret copy', async () => {
  const source = bytes(PRIVATE_CLIENT_SECRET)
  let iterated = false
  Object.defineProperty(source, Symbol.iterator, {
    value() {
      iterated = true
      throw new Error(PRIVATE_CLIENT_SECRET)
    },
  })
  /** @type {Uint8Array | undefined} */
  let observedCopy
  const encoder = new FeishuOAuthCredentialBundleEncoder()
  await new FeishuOAuthInitialCredentialPersister({
    verifier: matchingVerifier(),
    encoder: /** @type {never} */ ({
      /**
       * @param {unknown} configurationValue
       * @param {Uint8Array} clientSecretValue
       * @param {import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet} tokens
       * @param {AbortSignal} signal
       * @param {(bundle: Uint8Array) => unknown} use
       */
      withEncodedInitialBundle(configurationValue, clientSecretValue, tokens, signal, use) {
        observedCopy = clientSecretValue
        return encoder.withEncodedInitialBundle(
          configurationValue,
          clientSecretValue,
          tokens,
          signal,
          use,
        )
      },
    }),
    replacer: /** @type {never} */ ({ replace: async () => undefined }),
  }).persist(
    configuration(),
    source,
    /** @type {never} */ (tokenSet()),
    new AbortController().signal,
  )

  assert.equal(iterated, false)
  assert.ok(observedCopy !== undefined && observedCopy !== source && zeroed(observedCopy))
  assert.equal(decoded(source), PRIVATE_CLIENT_SECRET)
  Uint8Array.prototype.fill.call(source, 0)
})

test('invalid and hostile inputs fail before verification or persistence', async () => {
  let verifies = 0
  let writes = 0
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: /** @type {never} */ ({
      async withVerifiedPrincipal() {
        verifies += 1
      },
    }),
    replacer: /** @type {never} */ ({
      async replace() {
        writes += 1
      },
    }),
  })
  for (const [configured, secret, tokens] of [
    [{ ...configuration(), user: undefined }, bytes(PRIVATE_CLIENT_SECRET), tokenSet()],
    [configuration(), new Uint8Array(new SharedArrayBuffer(32)), tokenSet()],
    [configuration(), new Uint8Array(), tokenSet()],
    [
      configuration(),
      bytes(PRIVATE_CLIENT_SECRET),
      { ...tokenSet(), unknown: PRIVATE_ACCESS_TOKEN },
    ],
  ]) {
    await assert.rejects(
      persister.persist(
        configured,
        /** @type {never} */ (secret),
        /** @type {never} */ (tokens),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthInitialPersistenceError && error.code === 'invalid_request',
    )
  }
  assert.equal(verifies, 0)
  assert.equal(writes, 0)

  let accessed = false
  const hostile = Object.defineProperties(
    {},
    {
      verifier: {
        enumerable: true,
        get() {
          accessed = true
          return matchingVerifier()
        },
      },
      replacer: {
        enumerable: true,
        value: { replace: async () => undefined },
      },
    },
  )
  assert.throws(
    () => new FeishuOAuthInitialCredentialPersister(/** @type {never} */ (hostile)),
    (error) =>
      error instanceof FeishuOAuthInitialPersistenceError && error.code === 'invalid_request',
  )
  assert.equal(accessed, false)
})

test('a successful replacer result stays authoritative if cancellation arrives during it', async () => {
  const controller = new AbortController()
  const result = await new FeishuOAuthInitialCredentialPersister({
    verifier: matchingVerifier(),
    replacer: /** @type {never} */ ({
      async replace() {
        controller.abort()
      },
    }),
  }).persist(
    configuration(),
    bytes(PRIVATE_CLIENT_SECRET),
    /** @type {never} */ (tokenSet()),
    controller.signal,
  )
  assert.equal(result, undefined)
})
