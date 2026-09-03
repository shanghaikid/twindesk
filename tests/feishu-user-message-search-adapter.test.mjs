import assert from 'node:assert/strict'
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
  FeishuUserCredentialScopeProbe,
  FeishuUserMessageSearchAdapter,
  FeishuUserMessageSearchClientError,
  FeishuUserMessageSearchHttpClient,
} from '../packages/plugin-feishu/dist/index.js'

const ACCOUNT_ID = 'feishu-account:synthetic-search-adapter'
const APP_ID = 'cli_synthetic_search_adapter'
const TENANT_KEY = 'tenant_synthetic_search_adapter'
const USER_PRINCIPAL_ID = 'ou_synthetic_search_adapter_user'
const PRIVATE_ACCESS_TOKEN = 'u-synthetic-private-search-adapter-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-search-adapter-refresh-token'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-search-adapter-client-secret'
const NOW = Date.parse('2026-09-03T02:00:00.000Z')

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {unknown} value */
function encoded(value) {
  return bytes(`${JSON.stringify(value)}\n`)
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Search Adapter User',
      principalId: USER_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-search-adapter-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {Record<string, unknown>} [changes] @returns {any} */
function request(changes = {}) {
  return {
    identityType: 'user',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    userPrincipalId: USER_PRINCIPAL_ID,
    startTime: '2026-09-03T01:00:00.000Z',
    endTime: '2026-09-03T01:59:30.000Z',
    pageSize: 25,
    ...changes,
  }
}

/**
 * @param {{scopes?: string[], rotationError?: 'reauthorization_required' | 'rotation_pending' | 'rotation_uncertain', loseAtCheck?: number}} [options]
 */
function fixture(options = {}) {
  /** @type {string[]} */
  const events = []
  /** @type {Uint8Array[]} */
  const resolvedBundles = []
  /** @type {Uint8Array[]} */
  const deliveredTokens = []
  /** @type {Array<import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchHttpRequest>} */
  const deliveredRequests = []
  let leaseChecks = 0
  let httpCalls = 0
  const configured = configuration()
  const scopes = options.scopes ?? [
    'im:chat:read',
    'im:message:readonly',
    'offline_access',
    'search:message',
  ]
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        events.push('keychain')
        const value = encoded({
          kind: 'feishu_user_oauth_credential_bundle',
          schemaVersion: 1,
          appId: APP_ID,
          principalId: USER_PRINCIPAL_ID,
          clientSecret: PRIVATE_CLIENT_SECRET,
          tokenType: 'Bearer',
          accessToken: PRIVATE_ACCESS_TOKEN,
          obtainedAt: '2026-09-03T01:00:00.000Z',
          accessTokenExpiresAt: '2026-09-03T03:00:00.000Z',
          refreshToken: PRIVATE_REFRESH_TOKEN,
          refreshTokenExpiresAt: '2026-09-10T01:00:00.000Z',
          scopes,
        })
        resolvedBundles.push(value)
        return value
      },
    },
  })
  const scopeProbe = new FeishuUserCredentialScopeProbe({
    configuration: configured,
    resolver,
    now: () => NOW,
  })
  const rotationCoordinator = new FeishuOAuthRotationCoordinator({
    resolver,
    refresher: new FeishuOAuthV3TokenRefresher({
      now: () => NOW,
      transport: {
        async send() {
          return { status: 500, body: encoded({}) }
        },
      },
    }),
    replacer: new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: { async replace() {} },
    }),
    journal: new FeishuOAuthRotationJournal(
      join(tmpdir(), 'twindesk-unused-user-search-adapter-rotation.jsonl'),
    ),
    now: () => NOW,
  })
  Object.defineProperty(rotationCoordinator, 'refreshIfNeeded', {
    value: async () => {
      events.push('rotation')
      if (options.rotationError !== undefined) {
        throw new FeishuOAuthRotationError(
          options.rotationError,
          'Synthetic private rotation failure.',
        )
      }
      return { status: 'not_required', obtainedAt: '2026-09-03T01:00:00.000Z' }
    },
  })
  const httpClient = new FeishuUserMessageSearchHttpClient({ fetch: async () => new Response() })
  Object.defineProperty(httpClient, 'search', {
    /**
     * @param {import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchHttpRequest} value
     * @param {AbortSignal} signal
     */
    value: async (value, signal) => {
      signal.throwIfAborted()
      events.push('http')
      httpCalls += 1
      deliveredTokens.push(value.accessToken)
      deliveredRequests.push(value)
      assert.equal(new TextDecoder().decode(value.accessToken), PRIVATE_ACCESS_TOKEN)
      return Object.freeze({
        kind: 'feishu_user_message_search_page',
        schemaVersion: 1,
        identityType: 'user',
        accountId: value.accountId,
        appId: value.appId,
        tenantKey: value.tenantKey,
        userPrincipalId: value.userPrincipalId,
        messages: Object.freeze([]),
        unavailableMessageIds: Object.freeze([]),
        hasMore: false,
      })
    },
  })
  const adapter = new FeishuUserMessageSearchAdapter({
    configuration: configured,
    tenantKey: TENANT_KEY,
    lease: {
      assertHeld() {
        leaseChecks += 1
        events.push('lease')
        if (leaseChecks === options.loseAtCheck) throw new Error('Synthetic private lease loss.')
      },
    },
    resolver,
    scopeProbe,
    rotationCoordinator,
    httpClient,
    now: () => NOW,
  })
  return {
    adapter,
    events,
    resolvedBundles,
    deliveredTokens,
    deliveredRequests,
    httpCalls: () => httpCalls,
  }
}

test('configured User search rotates, authorizes exact scopes, rereads Keychain, then calls HTTP', async () => {
  const setup = fixture()
  const pageToken = 'opaque+/=synthetic-page-token'
  /** @type {any} */
  const result = await setup.adapter.search(request({ pageToken }), new AbortController().signal)

  assert.equal(result.kind, 'feishu_user_message_search_page')
  assert.deepEqual(setup.events, [
    'lease',
    'rotation',
    'lease',
    'keychain',
    'lease',
    'keychain',
    'lease',
    'http',
    'lease',
  ])
  assert.equal(setup.httpCalls(), 1)
  assert.equal(setup.deliveredRequests[0]?.pageToken, pageToken)
  assert.equal(
    setup.resolvedBundles.every((value) => value.every((byte) => byte === 0)),
    true,
  )
  assert.equal(
    setup.deliveredTokens.every((value) => value.every((byte) => byte === 0)),
    true,
  )
})

test('missing discovery scope fails before final credential delivery or HTTP', async () => {
  const setup = fixture({
    scopes: ['im:message:readonly', 'offline_access', 'search:message'],
  })
  await assert.rejects(
    setup.adapter.search(request(), new AbortController().signal),
    (error) =>
      error instanceof FeishuUserMessageSearchClientError && error.code === 'scope_missing',
  )
  assert.deepEqual(setup.events, ['lease', 'rotation', 'lease', 'keychain'])
  assert.equal(setup.httpCalls(), 0)
})

test('rotation recovery states remain payload-free and never read or call HTTP', async () => {
  /** @type {Array<['reauthorization_required' | 'rotation_pending' | 'rotation_uncertain', 'not_authorized' | 'unknown']>} */
  const cases = [
    ['reauthorization_required', 'not_authorized'],
    ['rotation_pending', 'unknown'],
    ['rotation_uncertain', 'unknown'],
  ]
  for (const [rotationError, expectedCode] of cases) {
    const setup = fixture({ rotationError })
    await assert.rejects(
      setup.adapter.search(request(), new AbortController().signal),
      (error) =>
        error instanceof FeishuUserMessageSearchClientError &&
        error.code === expectedCode &&
        !error.message.includes('Synthetic private'),
    )
    assert.deepEqual(setup.events, ['lease', 'rotation'])
    assert.equal(setup.httpCalls(), 0)
  }
})

test('lease loss after rotation stops before Keychain or HTTP access', async () => {
  const setup = fixture({ loseAtCheck: 2 })
  await assert.rejects(
    setup.adapter.search(request(), new AbortController().signal),
    (error) => error instanceof FeishuUserMessageSearchClientError && error.code === 'unknown',
  )
  assert.deepEqual(setup.events, ['lease', 'rotation', 'lease'])
  assert.equal(setup.httpCalls(), 0)
})

test('lease loss after the HTTP read suppresses the page and still clears credentials', async () => {
  const setup = fixture({ loseAtCheck: 5 })
  await assert.rejects(
    setup.adapter.search(request(), new AbortController().signal),
    (error) => error instanceof FeishuUserMessageSearchClientError && error.code === 'unknown',
  )
  assert.deepEqual(setup.events, [
    'lease',
    'rotation',
    'lease',
    'keychain',
    'lease',
    'keychain',
    'lease',
    'http',
    'lease',
  ])
  assert.equal(setup.httpCalls(), 1)
  assert.equal(
    setup.resolvedBundles.every((value) => value.every((byte) => byte === 0)),
    true,
  )
  assert.equal(
    setup.deliveredTokens.every((value) => value.every((byte) => byte === 0)),
    true,
  )
})

test('identity substitution, unknown fields, and cancellation fail before rotation', async () => {
  for (const invalid of [
    request({ tenantKey: 'tenant_other' }),
    request({ userPrincipalId: 'ou_other' }),
    request({ authority: 'expanded' }),
  ]) {
    const setup = fixture()
    await assert.rejects(
      setup.adapter.search(invalid, new AbortController().signal),
      (error) =>
        error instanceof FeishuUserMessageSearchClientError && error.code === 'invalid_response',
    )
    assert.deepEqual(setup.events, [])
  }

  const setup = fixture()
  const controller = new AbortController()
  controller.abort(new Error('Synthetic cancellation.'))
  await assert.rejects(
    setup.adapter.search(request(), controller.signal),
    /Synthetic cancellation/u,
  )
  assert.deepEqual(setup.events, [])
})
