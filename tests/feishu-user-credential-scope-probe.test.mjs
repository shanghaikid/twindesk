import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
  FeishuOperationScopeAuthorizationError,
  FeishuOperationScopeAuthorizer,
  FeishuOperationScopeProbeClientError,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  requiredFeishuOperationScopes,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_user_scope_probe'
const ACCOUNT_ID = 'feishu-account:synthetic-user-scope-probe'
const USER_PRINCIPAL_ID = 'ou_synthetic_user_scope_probe'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-user-scope-client-secret'
const PRIVATE_ACCESS_TOKEN = 'synthetic-private-user-scope-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-user-scope-refresh-token'
const NOW = Date.parse('2026-08-28T16:00:00.000Z')
const OBSERVED_AT = new Date(NOW).toISOString()

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic User Scope Probe',
      principalId: USER_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-user-scope-probe',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {Record<string, unknown>} [changes] */
function bundle(changes = {}) {
  return {
    kind: 'feishu_user_oauth_credential_bundle',
    schemaVersion: 1,
    appId: APP_ID,
    principalId: USER_PRINCIPAL_ID,
    clientSecret: PRIVATE_CLIENT_SECRET,
    tokenType: 'Bearer',
    accessToken: PRIVATE_ACCESS_TOKEN,
    obtainedAt: '2026-08-28T15:00:00.000Z',
    accessTokenExpiresAt: '2026-08-28T17:00:00.000Z',
    refreshToken: PRIVATE_REFRESH_TOKEN,
    refreshTokenExpiresAt: '2026-09-04T15:00:00.000Z',
    scopes: ['im:chat:read', 'im:message:readonly', 'offline_access', 'search:message'],
    ...changes,
  }
}

/** @param {unknown} value */
function encoded(value) {
  return new Uint8Array(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
}

/**
 * @param {{bundleChanges?: Record<string, unknown>, run?: () => Promise<Uint8Array>, now?: () => number}} [options]
 */
function fixture(options = {}) {
  let reads = 0
  /** @type {Uint8Array[]} */
  const resolved = []
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        reads += 1
        const value =
          options.run === undefined ? encoded(bundle(options.bundleChanges)) : await options.run()
        resolved.push(value)
        return value
      },
    },
  })
  const probe = new FeishuUserCredentialScopeProbe({
    configuration: configuration(),
    resolver,
    now: options.now ?? (() => NOW),
  })
  return {
    probe,
    authorizer: new FeishuOperationScopeAuthorizer({
      configuration: configuration(),
      client: probe,
      now: options.now ?? (() => NOW),
    }),
    counts: () => ({ reads }),
    resolved,
  }
}

test('User discovery resolves one exact Keychain bundle and exposes only current scope metadata', async () => {
  const current = fixture()
  const authorization = await current.authorizer.withAuthorizedOperation(
    'user_message_discovery',
    new AbortController().signal,
    async (value) => value,
  )

  assert.deepEqual(authorization, {
    kind: 'feishu_operation_scope_authorization',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    identityType: 'user',
    operation: 'user_message_discovery',
    requiredScopes: ['im:chat:read', 'im:message:readonly', 'search:message'],
    grantedScopes: ['im:chat:read', 'im:message:readonly', 'offline_access', 'search:message'],
    observedAt: OBSERVED_AT,
  })
  assert.equal(current.counts().reads, 1)
  assert.equal(Object.isFrozen(authorization), true)
  assert.equal(current.resolved.length, 1)
  assert.equal(
    current.resolved[0]?.every((value) => value === 0),
    true,
  )
  const serialized = JSON.stringify(authorization)
  for (const privateValue of [
    USER_PRINCIPAL_ID,
    configuration().user.credentialReference.id,
    PRIVATE_CLIENT_SECRET,
    PRIVATE_ACCESS_TOKEN,
    PRIVATE_REFRESH_TOKEN,
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('User reply uses its distinct fixed scope and rejects a discovery-only credential', async () => {
  const allowed = fixture({
    bundleChanges: { scopes: ['im:message:send_as_user', 'offline_access'] },
  })
  assert.equal(
    await allowed.authorizer.withAuthorizedOperation(
      'user_reply',
      new AbortController().signal,
      async () => 'allowed',
    ),
    'allowed',
  )

  const denied = fixture()
  let consumed = 0
  await assert.rejects(
    denied.authorizer.withAuthorizedOperation(
      'user_reply',
      new AbortController().signal,
      async () => {
        consumed += 1
      },
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError &&
      error.code === 'scope_missing' &&
      error.recovery === 'grant_scope',
  )
  assert.equal(consumed, 0)
})

test('an expired access token requires rotation before scope authorization', async () => {
  const current = fixture({
    bundleChanges: { accessTokenExpiresAt: OBSERVED_AT },
  })
  await assert.rejects(
    current.authorizer.withAuthorizedOperation(
      'user_message_discovery',
      new AbortController().signal,
      async () => assert.fail('A refresh-required credential must not authorize an operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError &&
      error.code === 'credential_refresh_required' &&
      error.recovery === 'refresh_credential',
  )
  assert.equal(
    current.resolved[0]?.every((value) => value === 0),
    true,
  )
})

test('expired refresh authorization and a missing Keychain item require reauthorization', async () => {
  for (const current of [
    fixture({ bundleChanges: { refreshTokenExpiresAt: OBSERVED_AT } }),
    fixture({
      run: async () => {
        const error = new Error(PRIVATE_ACCESS_TOKEN)
        Object.defineProperty(error, 'code', { value: 44 })
        throw error
      },
    }),
  ]) {
    await assert.rejects(
      current.authorizer.withAuthorizedOperation(
        'user_reply',
        new AbortController().signal,
        async () => assert.fail('Missing User authorization must not reach an operation.'),
      ),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === 'not_authorized' &&
        error.recovery === 'reauthorize' &&
        !error.message.includes(PRIVATE_ACCESS_TOKEN),
    )
  }
})

test('identity-mismatched and malformed bundles fail without exposing their values', async () => {
  for (const bundleChanges of [
    { principalId: 'ou_synthetic_other_user' },
    { appId: 'cli_synthetic_other_app' },
    { unknownPrivateField: PRIVATE_REFRESH_TOKEN },
  ]) {
    const current = fixture({ bundleChanges })
    await assert.rejects(
      current.authorizer.withAuthorizedOperation(
        'user_message_discovery',
        new AbortController().signal,
        async () => assert.fail('An invalid credential must not authorize an operation.'),
      ),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === 'invalid_client' &&
        !error.message.includes(PRIVATE_REFRESH_TOKEN),
    )
    assert.equal(
      current.resolved[0]?.every((value) => value === 0),
      true,
    )
  }
})

test('corrupt local Keychain values do not retry while transient lookup failure may retry', async () => {
  for (const source of [
    new Uint8Array(),
    new Uint8Array(FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES + 1),
  ]) {
    const current = fixture({ run: async () => source })
    await assert.rejects(
      current.authorizer.withAuthorizedOperation(
        'user_reply',
        new AbortController().signal,
        async () => assert.fail('A corrupt Keychain value must not reach an operation.'),
      ),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === 'invalid_client' &&
        error.recovery === 'do_not_retry',
    )
    assert.equal(
      source.every((value) => value === 0),
      true,
    )
  }

  const unavailable = fixture({
    run: async () => {
      throw new Error(PRIVATE_CLIENT_SECRET)
    },
  })
  await assert.rejects(
    unavailable.authorizer.withAuthorizedOperation(
      'user_reply',
      new AbortController().signal,
      async () => assert.fail('An unavailable Keychain must not reach an operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError &&
      error.code === 'probe_unavailable' &&
      error.recovery === 'retry' &&
      !error.message.includes(PRIVATE_CLIENT_SECRET),
  )
})

test('direct Bot, policy-mismatched, and hostile requests fail before Keychain access', async () => {
  const current = fixture()
  const baseRequest = {
    kind: 'feishu_operation_scope_probe_request',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    identityType: 'user',
    principalId: USER_PRINCIPAL_ID,
    credentialReference: configuration().user.credentialReference,
    operation: 'user_reply',
    requiredScopes: requiredFeishuOperationScopes('user_reply'),
  }
  for (const request of [
    { ...baseRequest, identityType: 'bot', operation: 'bot_reply' },
    { ...baseRequest, requiredScopes: ['offline_access'] },
    { ...baseRequest, principalId: 'ou_synthetic_other_user' },
  ]) {
    await assert.rejects(
      current.probe.inspectCurrentScopes(
        /** @type {never} */ (request),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
    )
  }

  let accessed = false
  const hostile = Object.defineProperty({ ...baseRequest }, 'requiredScopes', {
    enumerable: true,
    get() {
      accessed = true
      return ['im:message:send_as_user']
    },
  })
  await assert.rejects(
    current.probe.inspectCurrentScopes(
      /** @type {never} */ (hostile),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
  )
  assert.equal(accessed, false)
  assert.equal(current.counts().reads, 0)

  let optionAccessed = false
  const hostileOptions = Object.defineProperty({ configuration: configuration() }, 'resolver', {
    enumerable: true,
    get() {
      optionAccessed = true
      return new FeishuSystemKeychainSecretResolver({ platform: 'darwin' })
    },
  })
  assert.throws(
    () => new FeishuUserCredentialScopeProbe(/** @type {never} */ (hostileOptions)),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
  )
  assert.equal(optionAccessed, false)
})

test('invalid clocks and cancellation fail before or immediately after Keychain resolution', async () => {
  const invalidClock = fixture({ now: () => Number.NaN })
  await assert.rejects(
    invalidClock.authorizer.withAuthorizedOperation(
      'user_reply',
      new AbortController().signal,
      async () => assert.fail('An invalid clock must not reach an operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError && error.code === 'invalid_request',
  )
  assert.equal(invalidClock.counts().reads, 0)

  const controller = new AbortController()
  const source = encoded(bundle())
  const cancelled = fixture({
    run: async () => {
      controller.abort()
      return source
    },
  })
  await assert.rejects(
    cancelled.authorizer.withAuthorizedOperation(
      'user_message_discovery',
      controller.signal,
      async () => assert.fail('Cancellation must not reach an operation.'),
    ),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(
    source.every((value) => value === 0),
    true,
  )
})
