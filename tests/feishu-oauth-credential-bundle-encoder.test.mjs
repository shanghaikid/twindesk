import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuCredentialBundleParser,
  FeishuOAuthCredentialBundleEncoder,
  FeishuOAuthCredentialBundleEncoderError,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_rotation_encoder'
const USER_PRINCIPAL = 'ou_synthetic_rotation_user'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-rotation-client-secret'
const PRIVATE_OLD_ACCESS_TOKEN = 'synthetic-private-old-access-token'
const PRIVATE_OLD_REFRESH_TOKEN = 'synthetic-private-old-refresh-token'
const PRIVATE_NEW_ACCESS_TOKEN = 'synthetic-private-new-access-token'
const PRIVATE_NEW_REFRESH_TOKEN = 'synthetic-private-new-refresh-token'

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
    accountId: 'feishu-account:synthetic-rotation-encoder',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Rotation User',
      principalId: USER_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-rotation-encoder',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {Record<string, unknown>} [changes] */
function credential(changes = {}) {
  return {
    kind: 'feishu_user_oauth_credential_bundle',
    schemaVersion: 1,
    appId: APP_ID,
    principalId: USER_PRINCIPAL,
    clientSecret: bytes(PRIVATE_CLIENT_SECRET),
    tokenType: 'Bearer',
    accessToken: bytes(PRIVATE_OLD_ACCESS_TOKEN),
    accessTokenStatus: 'refresh_required',
    obtainedAt: '2026-08-28T07:00:00.000Z',
    accessTokenExpiresAt: '2026-08-28T09:00:00.000Z',
    refreshToken: bytes(PRIVATE_OLD_REFRESH_TOKEN),
    refreshTokenExpiresAt: '2026-09-04T07:00:00.000Z',
    scopes: ['im:message', 'offline_access'],
    ...changes,
  }
}

/** @param {Record<string, unknown>} [changes] */
function tokenSet(changes = {}) {
  return {
    tokenType: 'Bearer',
    accessToken: bytes(PRIVATE_NEW_ACCESS_TOKEN),
    obtainedAt: '2026-08-28T10:00:00.000Z',
    accessTokenExpiresAt: '2026-08-28T12:00:00.000Z',
    refreshToken: bytes(PRIVATE_NEW_REFRESH_TOKEN),
    refreshTokenExpiresAt: '2026-09-04T10:00:00.000Z',
    scopes: ['im:message', 'im:message:readonly', 'offline_access'],
    ...changes,
  }
}

test('rotated tokens encode as one exact version 1 bundle and parse under the same identity', async () => {
  const current = credential()
  const rotated = tokenSet()
  /** @type {Uint8Array | undefined} */
  let observedBundle
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuUserOAuthCredentialBundle | undefined} */
  let parsedCredential
  const result = await new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
    /** @type {never} */ (current),
    /** @type {never} */ (rotated),
    new AbortController().signal,
    async (bundle) => {
      observedBundle = bundle
      const text = decoded(bundle)
      assert.equal(text.includes(PRIVATE_CLIENT_SECRET), true)
      assert.equal(text.includes(PRIVATE_NEW_ACCESS_TOKEN), true)
      assert.equal(text.includes(PRIVATE_NEW_REFRESH_TOKEN), true)
      assert.equal(text.includes(PRIVATE_OLD_ACCESS_TOKEN), false)
      assert.equal(text.includes(PRIVATE_OLD_REFRESH_TOKEN), false)
      return new FeishuCredentialBundleParser({
        now: () => Date.parse('2026-08-28T10:30:00.000Z'),
      }).withCredential(configuration(), 'user', bundle, new AbortController().signal, (parsed) => {
        assert.equal(parsed.kind, 'feishu_user_oauth_credential_bundle')
        if (parsed.kind !== 'feishu_user_oauth_credential_bundle') return undefined
        parsedCredential = parsed
        assert.equal(decoded(parsed.clientSecret), PRIVATE_CLIENT_SECRET)
        assert.equal(decoded(parsed.accessToken), PRIVATE_NEW_ACCESS_TOKEN)
        assert.equal(decoded(parsed.refreshToken), PRIVATE_NEW_REFRESH_TOKEN)
        assert.equal(parsed.accessTokenStatus, 'usable')
        assert.deepEqual(parsed.scopes, ['im:message', 'im:message:readonly', 'offline_access'])
        return 'encoded'
      })
    },
  )
  assert.equal(result, 'encoded')
  assert.ok(observedBundle !== undefined && zeroed(observedBundle))
  assert.ok(parsedCredential !== undefined && zeroed(parsedCredential.clientSecret))
  assert.ok(parsedCredential !== undefined && zeroed(parsedCredential.accessToken))
  assert.ok(parsedCredential !== undefined && zeroed(parsedCredential.refreshToken))
})

test('an encoded Keychain replacement is readable through fresh primitive instances', async () => {
  const current = credential()
  const rotated = tokenSet()
  /** @type {Uint8Array | undefined} */
  let stored
  const identityConfiguration = configuration()
  const userIdentity = identityConfiguration.user
  assert.ok(userIdentity !== undefined)
  await new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
    /** @type {never} */ (current),
    /** @type {never} */ (rotated),
    new AbortController().signal,
    (bundle) =>
      new FeishuSystemKeychainSecretReplacer({
        platform: 'darwin',
        runner: {
          async replace(_request, secret) {
            stored = new Uint8Array(secret)
          },
        },
      }).replace(userIdentity.credentialReference, bundle, new AbortController().signal),
  )
  assert.ok(stored !== undefined)
  const storedAfterWrite = stored
  const result = await new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        return storedAfterWrite
      },
    },
  }).withSecret(
    identityConfiguration.user.credentialReference,
    new AbortController().signal,
    (bundle) =>
      new FeishuCredentialBundleParser({
        now: () => Date.parse('2026-08-28T10:30:00.000Z'),
      }).withCredential(
        identityConfiguration,
        'user',
        bundle,
        new AbortController().signal,
        (parsed) => {
          assert.equal(parsed.kind, 'feishu_user_oauth_credential_bundle')
          if (parsed.kind !== 'feishu_user_oauth_credential_bundle') return undefined
          assert.equal(decoded(parsed.accessToken), PRIVATE_NEW_ACCESS_TOKEN)
          assert.equal(decoded(parsed.refreshToken), PRIVATE_NEW_REFRESH_TOKEN)
          return parsed.accessTokenStatus
        },
      ),
  )
  assert.equal(result, 'usable')
  assert.ok(zeroed(storedAfterWrite))
})

test('encoder rejects malformed, stale, sparse, accessor, and oversized rotation data', async () => {
  const sparseScopes = ['im:message', 'im:message:readonly', 'offline_access']
  delete sparseScopes[1]
  let accessed = false
  const hostile = Object.defineProperty(tokenSet(), 'accessToken', {
    enumerable: true,
    get() {
      accessed = true
      return bytes(PRIVATE_NEW_ACCESS_TOKEN)
    },
  })
  const largeScopes = Array.from(
    { length: 127 },
    (_, index) => `a${String(index).padStart(3, '0')}${'x'.repeat(252)}`,
  )
  largeScopes.push('offline_access')
  const cases = [
    { current: credential({ unknown: PRIVATE_OLD_REFRESH_TOKEN }), rotated: tokenSet() },
    {
      current: credential(),
      rotated: tokenSet({ obtainedAt: '2026-08-28T06:00:00.000Z' }),
    },
    {
      current: credential(),
      rotated: tokenSet({ obtainedAt: '2026-08-28T07:00:00.000Z' }),
    },
    {
      current: credential(),
      rotated: tokenSet({ refreshToken: bytes(PRIVATE_OLD_REFRESH_TOKEN) }),
    },
    { current: credential(), rotated: tokenSet({ scopes: sparseScopes }) },
    { current: credential(), rotated: hostile },
    { current: credential(), rotated: tokenSet({ scopes: largeScopes }), code: 'bundle_too_large' },
  ]
  for (const item of cases) {
    let used = false
    await assert.rejects(
      new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
        /** @type {never} */ (item.current),
        /** @type {never} */ (item.rotated),
        new AbortController().signal,
        () => {
          used = true
        },
      ),
      (error) =>
        error instanceof FeishuOAuthCredentialBundleEncoderError &&
        (item.code === undefined || error.code === item.code) &&
        !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN) &&
        !error.message.includes(PRIVATE_NEW_ACCESS_TOKEN),
    )
    assert.equal(used, false)
  }
  assert.equal(accessed, false)
})

test('cancellation and consumer failure clear the encoded bundle without changing failures', async () => {
  const preCancelled = new AbortController()
  preCancelled.abort()
  await assert.rejects(
    new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
      /** @type {never} */ (credential()),
      /** @type {never} */ (tokenSet()),
      preCancelled.signal,
      () => undefined,
    ),
    { name: 'AbortError' },
  )

  /** @type {Uint8Array | undefined} */
  let observed
  const failure = new Error('synthetic-encoder-consumer-failure')
  await assert.rejects(
    new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
      /** @type {never} */ (credential()),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
      (bundle) => {
        observed = bundle
        throw failure
      },
    ),
    (error) => error === failure,
  )
  assert.ok(observed !== undefined && zeroed(observed))

  await assert.rejects(
    new FeishuOAuthCredentialBundleEncoder().withEncodedBundle(
      /** @type {never} */ (credential()),
      /** @type {never} */ (tokenSet()),
      new AbortController().signal,
      /** @type {never} */ (null),
    ),
    (error) =>
      error instanceof FeishuOAuthCredentialBundleEncoderError && error.code === 'invalid_consumer',
  )
})
