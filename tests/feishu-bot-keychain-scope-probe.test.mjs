import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_BOT_INFO_URL,
  FEISHU_BOT_TENANT_TOKEN_URL,
  FeishuBotIdentityScopeHttpClient,
  FeishuBotKeychainScopeProbe,
  FeishuBotTenantTokenAcquirer,
  FeishuOperationScopeAuthorizationError,
  FeishuOperationScopeAuthorizer,
  FeishuOperationScopeProbeClientError,
  FeishuSystemKeychainSecretResolver,
  requiredFeishuOperationScopes,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_bot_keychain_scope'
const ACCOUNT_ID = 'feishu-account:synthetic-bot-keychain-scope'
const PRINCIPAL_ID = 'ou_synthetic_bot_keychain_scope'
const PRIVATE_APP_SECRET = 'synthetic-private-bot-keychain-secret'
const PRIVATE_TENANT_TOKEN = 't-synthetic-private-bot-keychain-token'
const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const OBSERVED_AT = new Date(NOW + 1_000).toISOString()

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {Uint8Array} value */
function decoded(value) {
  return new TextDecoder().decode(value)
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Bot Keychain Scope',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-bot-keychain-scope',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
  }
}

/** @param {Record<string, unknown>} [changes] */
function bundle(changes = {}) {
  return {
    kind: 'feishu_app_credential_bundle',
    schemaVersion: 1,
    appId: APP_ID,
    appSecret: PRIVATE_APP_SECRET,
    ...changes,
  }
}

/** @param {unknown} value */
function encoded(value) {
  return bytes(`${JSON.stringify(value)}\n`)
}

/**
 * @param {{
 *   keychainError?: unknown,
 *   bundleChanges?: Record<string, unknown>,
 *   tokenResponse?: Record<string, unknown>,
 *   principalId?: string,
 *   scopes?: Array<{scope: string, token_types: string[]}>,
 *   now?: () => number,
 * }} [options]
 */
function fixture(options = {}) {
  /** @type {Uint8Array[]} */
  const resolved = []
  /** @type {Uint8Array[]} */
  const tokenRequestBodies = []
  /** @type {Uint8Array[]} */
  const tokenResponses = []
  /** @type {Uint8Array[]} */
  const scopeResponses = []
  /** @type {string[]} */
  const calls = []
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        if (options.keychainError !== undefined) throw options.keychainError
        const value = encoded(bundle(options.bundleChanges))
        resolved.push(value)
        return value
      },
    },
  })
  const tokenAcquirer = new FeishuBotTenantTokenAcquirer({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(url, FEISHU_BOT_TENANT_TOKEN_URL)
      assert.ok(init !== undefined)
      calls.push('token')
      assert.ok(init.body instanceof Uint8Array)
      tokenRequestBodies.push(init.body)
      assert.deepEqual(JSON.parse(decoded(init.body)), {
        app_id: APP_ID,
        app_secret: PRIVATE_APP_SECRET,
      })
      const body = bytes(
        JSON.stringify(
          options.tokenResponse ?? {
            code: 0,
            msg: 'success',
            tenant_access_token: PRIVATE_TENANT_TOKEN,
            expire: 7140,
          },
        ),
      )
      tokenResponses.push(body)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(body)
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  let scopeCall = 0
  const scopeClient = new FeishuBotIdentityScopeHttpClient({
    fetch: async (url, init) => {
      assert.ok(init !== undefined)
      calls.push(scopeCall === 0 ? 'bot_info' : 'app_info')
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${PRIVATE_TENANT_TOKEN}`)
      const value =
        scopeCall++ === 0
          ? {
              code: 0,
              msg: 'success',
              bot: { open_id: options.principalId ?? PRINCIPAL_ID, app_name: 'Synthetic Bot' },
            }
          : {
              code: 0,
              msg: 'success',
              data: {
                app: {
                  app_id: APP_ID,
                  scopes: options.scopes ?? [
                    { scope: 'im:message:send_as_bot', token_types: ['tenant'] },
                    { scope: 'search:message', token_types: ['user'] },
                  ],
                },
              },
            }
      if (scopeCall === 1) assert.equal(url, FEISHU_BOT_INFO_URL)
      const body = bytes(JSON.stringify(value))
      scopeResponses.push(body)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(body)
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const probe = new FeishuBotKeychainScopeProbe({
    configuration: configuration(),
    resolver,
    tokenAcquirer,
    scopeClient,
    now: options.now ?? (() => NOW + 1_000),
  })
  return {
    probe,
    authorizer: new FeishuOperationScopeAuthorizer({
      configuration: configuration(),
      client: probe,
      now: () => NOW + 1_000,
    }),
    resolved,
    tokenRequestBodies,
    tokenResponses,
    scopeResponses,
    calls,
  }
}

/** @param {Record<string, unknown>} [changes] */
function request(changes = {}) {
  const config = configuration()
  return /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuOperationScopeProbeRequest} */ ({
    kind: 'feishu_operation_scope_probe_request',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    identityType: 'bot',
    principalId: PRINCIPAL_ID,
    credentialReference: config.bot.credentialReference,
    operation: 'bot_reply',
    requiredScopes: requiredFeishuOperationScopes('bot_reply'),
    ...changes,
  })
}

test('Bot Keychain probe composes credential, token, principal, and tenant scope checks', async () => {
  const current = fixture()
  const authorization = await current.authorizer.withAuthorizedOperation(
    'bot_reply',
    new AbortController().signal,
    async (value) => value,
  )

  assert.deepEqual(authorization, {
    kind: 'feishu_operation_scope_authorization',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    identityType: 'bot',
    operation: 'bot_reply',
    requiredScopes: ['im:message:send_as_bot'],
    grantedScopes: ['im:message:send_as_bot'],
    observedAt: OBSERVED_AT,
  })
  assert.deepEqual(current.calls, ['token', 'bot_info', 'app_info'])
  for (const secretBuffer of [
    ...current.resolved,
    ...current.tokenRequestBodies,
    ...current.tokenResponses,
    ...current.scopeResponses,
  ]) {
    assert.equal(
      secretBuffer.every((value) => value === 0),
      true,
    )
  }
  const serialized = JSON.stringify(authorization)
  for (const privateValue of [
    PRINCIPAL_ID,
    configuration().bot.credentialReference.id,
    PRIVATE_APP_SECRET,
    PRIVATE_TENANT_TOKEN,
    'search:message',
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('User-only app scopes cannot authorize a Bot reply', async () => {
  const current = fixture({
    scopes: [{ scope: 'im:message:send_as_bot', token_types: ['user'] }],
  })
  let consumed = 0
  await assert.rejects(
    current.authorizer.withAuthorizedOperation(
      'bot_reply',
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

test('a remote Bot principal mismatch requires configuration repair', async () => {
  const current = fixture({ principalId: 'ou_synthetic_other_bot' })
  await assert.rejects(
    current.authorizer.withAuthorizedOperation(
      'bot_reply',
      new AbortController().signal,
      async () => assert.fail('A mismatched Bot must not reach the operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError &&
      error.code === 'not_authorized' &&
      error.recovery === 'repair_configuration' &&
      !error.message.includes(PRIVATE_TENANT_TOKEN),
  )
})

test('Bot credential and tenant-token failures remain typed and payload-free', async () => {
  const notFound = new Error(PRIVATE_APP_SECRET)
  Object.defineProperty(notFound, 'code', { value: 44 })
  /** @type {Array<[ReturnType<typeof fixture>, string, string]>} */
  const cases = [
    [fixture({ keychainError: notFound }), 'not_authorized', 'repair_configuration'],
    [
      fixture({ bundleChanges: { appId: 'cli_synthetic_other_app' } }),
      'invalid_client',
      'do_not_retry',
    ],
    [
      fixture({ tokenResponse: { code: 10014, msg: PRIVATE_APP_SECRET } }),
      'not_authorized',
      'repair_configuration',
    ],
    [
      fixture({ tokenResponse: { code: 99991400, msg: PRIVATE_APP_SECRET } }),
      'probe_unavailable',
      'retry',
    ],
  ]
  for (const [current, code, recovery] of cases) {
    await assert.rejects(
      current.authorizer.withAuthorizedOperation(
        'bot_reply',
        new AbortController().signal,
        async () => assert.fail('A failed probe must not reach the operation.'),
      ),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === code &&
        error.recovery === recovery &&
        !error.message.includes(PRIVATE_APP_SECRET),
    )
  }
})

test('Bot probe rejects substituted operation evidence before Keychain access', async () => {
  const current = fixture()
  for (const changes of [
    { identityType: 'user' },
    { principalId: 'ou_synthetic_other_bot' },
    { operation: 'user_reply' },
    { requiredScopes: ['im:message:readonly'] },
    {
      credentialReference: {
        ...configuration().bot.credentialReference,
        id: 'secret-ref:synthetic-other-bot',
      },
    },
  ]) {
    await assert.rejects(
      current.probe.inspectCurrentScopes(request(changes), new AbortController().signal),
      (error) =>
        error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
    )
  }
  assert.equal(current.calls.length, 0)
  assert.equal(current.resolved.length, 0)
})

test('Bot probe rejects hostile requests before access and an invalid observation clock after probing', async () => {
  const current = fixture()
  let reads = 0
  const hostile = {}
  Object.defineProperty(hostile, 'principalId', {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(PRIVATE_APP_SECRET)
    },
  })
  await assert.rejects(
    current.probe.inspectCurrentScopes(/** @type {any} */ (hostile), new AbortController().signal),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError &&
      error.code === 'invalid_response' &&
      !error.message.includes(PRIVATE_APP_SECRET),
  )
  assert.equal(reads, 0)
  assert.equal(current.calls.length, 0)

  const invalidClock = fixture({ now: () => Number.NaN })
  await assert.rejects(
    invalidClock.authorizer.withAuthorizedOperation(
      'bot_reply',
      new AbortController().signal,
      async () => assert.fail('An invalid probe clock must not reach the operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError &&
      error.code === 'invalid_client' &&
      error.recovery === 'do_not_retry',
  )
  assert.deepEqual(invalidClock.calls, ['token', 'bot_info', 'app_info'])
})

test('Bot probe propagates cancellation without invoking the operation', async () => {
  const current = fixture()
  const controller = new AbortController()
  controller.abort(new Error('synthetic cancellation'))
  await assert.rejects(
    current.authorizer.withAuthorizedOperation(
      'bot_reply',
      controller.signal,
      async () => undefined,
    ),
    /synthetic cancellation/u,
  )
  assert.equal(current.calls.length, 0)
  assert.equal(current.resolved.length, 0)
})
