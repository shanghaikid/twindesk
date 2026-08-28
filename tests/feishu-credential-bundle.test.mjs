import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES,
  FEISHU_OAUTH_TOKEN_MAX_LENGTH,
  FeishuCredentialBundleError,
  FeishuCredentialBundleParser,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_credential_bundle'
const BOT_PRINCIPAL = 'ou_synthetic_bundle_bot'
const USER_PRINCIPAL = 'ou_synthetic_bundle_user'
const PRIVATE_APP_SECRET = 'synthetic-private-app-secret-value'
const PRIVATE_ACCESS_TOKEN = 'synthetic-private-user-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-user-refresh-token'
const NOW = '2026-08-28T08:00:00.000Z'

function configuration(includeUser = true) {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-credential-bundle',
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Credential Bot',
      principalId: BOT_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-credential-app',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    ...(includeUser
      ? {
          user: {
            identityType: 'user',
            displayName: 'Synthetic Credential User',
            principalId: USER_PRINCIPAL,
            credentialReference: {
              kind: 'secret_reference',
              schemaVersion: 1,
              id: 'secret-ref:synthetic-credential-oauth',
              store: 'system_keychain',
              purpose: 'connector_oauth',
            },
          },
        }
      : {}),
  }
}

function appBundle(changes = {}) {
  return {
    kind: 'feishu_app_credential_bundle',
    schemaVersion: 1,
    appId: APP_ID,
    appSecret: PRIVATE_APP_SECRET,
    ...changes,
  }
}

function userBundle(changes = {}) {
  return {
    kind: 'feishu_user_oauth_credential_bundle',
    schemaVersion: 1,
    appId: APP_ID,
    principalId: USER_PRINCIPAL,
    clientSecret: PRIVATE_APP_SECRET,
    tokenType: 'Bearer',
    accessToken: PRIVATE_ACCESS_TOKEN,
    obtainedAt: '2026-08-28T07:00:00.000Z',
    accessTokenExpiresAt: '2026-08-28T09:00:00.000Z',
    refreshToken: PRIVATE_REFRESH_TOKEN,
    refreshTokenExpiresAt: '2026-09-04T07:00:00.000Z',
    scopes: ['im:message', 'im:message:readonly', 'offline_access'],
    ...changes,
  }
}

/**
 * @param {unknown} value
 * @param {boolean} [newline]
 */
function encoded(value, newline = true) {
  return new Uint8Array(Buffer.from(`${JSON.stringify(value)}${newline ? '\n' : ''}`, 'utf8'))
}

function parser(now = NOW) {
  return new FeishuCredentialBundleParser({ now: () => Date.parse(now) })
}

/** @param {Uint8Array} secret */
function decoded(secret) {
  return Buffer.from(secret).toString('utf8')
}

/** @param {Uint8Array} secret */
function isZeroed(secret) {
  return secret.every((value) => value === 0)
}

test('application credentials are app-bound, callback-scoped, frozen, and zeroed', async () => {
  const source = new Uint8Array(Buffer.from(`${JSON.stringify(appBundle())}\r\n`, 'utf8'))
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuAppCredentialBundle }} */
  const observed = {}
  const result = await parser().withCredential(
    configuration(),
    'bot',
    source,
    new AbortController().signal,
    (credential) => {
      assert.equal(credential.kind, 'feishu_app_credential_bundle')
      if (credential.kind !== 'feishu_app_credential_bundle') return undefined
      observed.value = credential
      assert.equal(credential.schemaVersion, 1)
      assert.equal(credential.appId, APP_ID)
      assert.equal(decoded(credential.appSecret), PRIVATE_APP_SECRET)
      assert.equal(Object.isFrozen(credential), true)
      return 'synthetic-app-result'
    },
  )
  assert.equal(result, 'synthetic-app-result')
  assert.ok(observed.value !== undefined && isZeroed(observed.value.appSecret))
  assert.ok(source.every((value) => value === 0))
})

test('OAuth credentials bind the exact user and expose explicit refresh state', async () => {
  for (const [accessTokenExpiresAt, expectedStatus] of [
    ['2026-08-28T09:00:00.000Z', 'usable'],
    ['2026-08-28T08:00:00.000Z', 'refresh_required'],
  ]) {
    const source = encoded(userBundle({ accessTokenExpiresAt }))
    /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuUserOAuthCredentialBundle }} */
    const observed = {}
    await parser().withCredential(
      configuration(),
      'user',
      source,
      new AbortController().signal,
      (credential) => {
        assert.equal(credential.kind, 'feishu_user_oauth_credential_bundle')
        if (credential.kind !== 'feishu_user_oauth_credential_bundle') return
        observed.value = credential
        assert.equal(credential.appId, APP_ID)
        assert.equal(credential.principalId, USER_PRINCIPAL)
        assert.equal(decoded(credential.clientSecret), PRIVATE_APP_SECRET)
        assert.equal(decoded(credential.accessToken), PRIVATE_ACCESS_TOKEN)
        assert.equal(decoded(credential.refreshToken), PRIVATE_REFRESH_TOKEN)
        assert.equal(credential.accessTokenStatus, expectedStatus)
        assert.deepEqual(credential.scopes, ['im:message', 'im:message:readonly', 'offline_access'])
        assert.equal(Object.isFrozen(credential), true)
        assert.equal(Object.isFrozen(credential.scopes), true)
      },
    )
    assert.equal(observed.value?.kind, 'feishu_user_oauth_credential_bundle')
    if (observed.value !== undefined) {
      assert.ok(isZeroed(observed.value.clientSecret))
      assert.ok(isZeroed(observed.value.accessToken))
      assert.ok(isZeroed(observed.value.refreshToken))
    }
    assert.ok(source.every((value) => value === 0))
  }
})

test('the Keychain resolver composes without extending either secret lifetime', async () => {
  const keychainBytes = encoded(userBundle())
  const signal = new AbortController().signal
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuUserOAuthCredentialBundle }} */
  const observed = {}
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      run: async () => keychainBytes,
    },
  })
  const identityConfiguration = configuration()
  assert.notEqual(identityConfiguration.user, undefined)
  if (identityConfiguration.user === undefined) return
  const result = await resolver.withSecret(
    identityConfiguration.user.credentialReference,
    signal,
    (bundle) =>
      parser().withCredential(configuration(), 'user', bundle, signal, (credential) => {
        assert.equal(credential.kind, 'feishu_user_oauth_credential_bundle')
        if (credential.kind !== 'feishu_user_oauth_credential_bundle') return undefined
        observed.value = credential
        assert.equal(decoded(credential.accessToken), PRIVATE_ACCESS_TOKEN)
        return credential.accessTokenStatus
      }),
  )
  assert.equal(result, 'usable')
  assert.ok(keychainBytes.every((value) => value === 0))
  assert.equal(observed.value?.kind, 'feishu_user_oauth_credential_bundle')
  if (observed.value !== undefined) {
    assert.ok(isZeroed(observed.value.clientSecret))
    assert.ok(isZeroed(observed.value.accessToken))
    assert.ok(isZeroed(observed.value.refreshToken))
  }
})

test('identity, lifetime, scope, token, and JSON shape failures are payload-free', async () => {
  const cases = [
    {
      bundle: appBundle({ appId: 'cli_synthetic_other_app' }),
      type: 'bot',
      code: 'identity_mismatch',
    },
    {
      bundle: userBundle({ principalId: 'ou_synthetic_other_user' }),
      type: 'user',
      code: 'identity_mismatch',
    },
    { bundle: userBundle({ tokenType: 'Basic' }), type: 'user', code: 'invalid_bundle' },
    {
      bundle: userBundle({ scopes: ['offline_access', 'im:message:readonly', 'im:message'] }),
      type: 'user',
      code: 'invalid_bundle',
    },
    { bundle: userBundle({ scopes: ['im:message'] }), type: 'user', code: 'invalid_bundle' },
    {
      bundle: userBundle({ scopes: ['im:message', 'im:message', 'offline_access'] }),
      type: 'user',
      code: 'invalid_bundle',
    },
    {
      bundle: userBundle({ obtainedAt: '2026-08-28T08:01:00.000Z' }),
      type: 'user',
      code: 'invalid_bundle',
    },
    {
      bundle: userBundle({ accessTokenExpiresAt: '2026-08-28T07:00:00.000Z' }),
      type: 'user',
      code: 'invalid_bundle',
    },
    {
      bundle: userBundle({ refreshTokenExpiresAt: NOW }),
      type: 'user',
      code: 'credential_expired',
    },
    {
      bundle: userBundle({ accessToken: 'x'.repeat(FEISHU_OAUTH_TOKEN_MAX_LENGTH + 1) }),
      type: 'user',
      code: 'invalid_bundle',
    },
    {
      bundle: { ...appBundle(), unknownPrivateField: PRIVATE_ACCESS_TOKEN },
      type: 'bot',
      code: 'invalid_bundle',
    },
  ]
  for (const item of cases) {
    const source = encoded(item.bundle)
    await assert.rejects(
      parser().withCredential(
        configuration(),
        /** @type {'bot' | 'user'} */ (item.type),
        source,
        new AbortController().signal,
        () => undefined,
      ),
      (error) =>
        error instanceof FeishuCredentialBundleError &&
        error.code === item.code &&
        !error.message.includes(PRIVATE_APP_SECRET) &&
        !error.message.includes(PRIVATE_ACCESS_TOKEN) &&
        !error.message.includes(PRIVATE_REFRESH_TOKEN),
    )
    assert.ok(source.every((value) => value === 0))
  }

  const duplicate = new Uint8Array(
    Buffer.from(
      `{"kind":"feishu_app_credential_bundle","schemaVersion":1,"appId":"${APP_ID}","appSecret":"first","appSecret":"${PRIVATE_APP_SECRET}"}`,
      'utf8',
    ),
  )
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      duplicate,
      new AbortController().signal,
      () => undefined,
    ),
    (error) => error instanceof FeishuCredentialBundleError && error.code === 'invalid_bundle',
  )
  assert.ok(duplicate.every((value) => value === 0))
})

test('invalid encoding, size, identity slots, clocks, and consumers fail closed', async () => {
  const invalidEncoding = new Uint8Array([0xc3, 0x28])
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      invalidEncoding,
      new AbortController().signal,
      () => undefined,
    ),
    (error) => error instanceof FeishuCredentialBundleError && error.code === 'invalid_bundle',
  )
  assert.ok(invalidEncoding.every((value) => value === 0))

  const oversized = new Uint8Array(FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES + 1).fill(7)
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      oversized,
      new AbortController().signal,
      () => undefined,
    ),
    (error) => error instanceof FeishuCredentialBundleError && error.code === 'invalid_bundle',
  )
  assert.ok(oversized.every((value) => value === 0))

  for (const [bundle, config, identityType, code] of [
    [userBundle(), configuration(false), 'user', 'identity_not_configured'],
    [appBundle(), configuration(), 'unknown', 'identity_mismatch'],
  ]) {
    const source = encoded(bundle)
    await assert.rejects(
      parser().withCredential(
        config,
        /** @type {'bot' | 'user'} */ (identityType),
        source,
        new AbortController().signal,
        () => undefined,
      ),
      (error) => error instanceof FeishuCredentialBundleError && error.code === code,
    )
    assert.ok(source.every((value) => value === 0))
  }

  for (const now of [Number.NaN, -1]) {
    const source = encoded(userBundle())
    await assert.rejects(
      new FeishuCredentialBundleParser({ now: () => now }).withCredential(
        configuration(),
        'user',
        source,
        new AbortController().signal,
        () => undefined,
      ),
      (error) => error instanceof FeishuCredentialBundleError && error.code === 'invalid_clock',
    )
    assert.ok(source.every((value) => value === 0))
  }

  const invalidConsumer = encoded(appBundle())
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      invalidConsumer,
      new AbortController().signal,
      /** @type {(credential: unknown) => void} */ (/** @type {unknown} */ (null)),
    ),
    (error) => error instanceof FeishuCredentialBundleError && error.code === 'invalid_consumer',
  )
  assert.ok(invalidConsumer.every((value) => value === 0))
})

test('cancellation and consumer failures zero bytes without changing the failure', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  const preCancelled = encoded(appBundle())
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      preCancelled,
      cancelled.signal,
      () => undefined,
    ),
    { name: 'AbortError' },
  )
  assert.ok(preCancelled.every((value) => value === 0))

  const cancelledDuringUse = new AbortController()
  const cancelledSource = encoded(appBundle())
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuAppCredentialBundle }} */
  const cancelledObserved = {}
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      cancelledSource,
      cancelledDuringUse.signal,
      (credential) => {
        assert.equal(credential.kind, 'feishu_app_credential_bundle')
        if (credential.kind !== 'feishu_app_credential_bundle') return undefined
        cancelledObserved.value = credential
        cancelledDuringUse.abort()
        return 'must-not-escape-cancellation'
      },
    ),
    { name: 'AbortError' },
  )
  assert.ok(cancelledObserved.value !== undefined && isZeroed(cancelledObserved.value.appSecret))
  assert.ok(cancelledSource.every((value) => value === 0))

  const source = encoded(appBundle())
  const failure = new Error('synthetic-credential-consumer-failure')
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuAppCredentialBundle }} */
  const observed = {}
  await assert.rejects(
    parser().withCredential(
      configuration(),
      'bot',
      source,
      new AbortController().signal,
      (credential) => {
        assert.equal(credential.kind, 'feishu_app_credential_bundle')
        if (credential.kind !== 'feishu_app_credential_bundle') return undefined
        observed.value = credential
        assert.equal(decoded(credential.appSecret), PRIVATE_APP_SECRET)
        throw failure
      },
    ),
    (error) => error === failure,
  )
  assert.ok(observed.value !== undefined && isZeroed(observed.value.appSecret))
  assert.ok(source.every((value) => value === 0))
})
