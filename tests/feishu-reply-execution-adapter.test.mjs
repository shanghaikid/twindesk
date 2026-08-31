import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FEISHU_BOT_INFO_URL,
  FEISHU_BOT_TENANT_TOKEN_URL,
  FeishuBotIdentityScopeHttpClient,
  FeishuBotKeychainScopeProbe,
  FeishuBotTenantTokenAcquirer,
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationError,
  FeishuOAuthRotationJournal,
  FeishuOAuthV3TokenRefresher,
  FeishuReplyExecutionAdapter,
  FeishuReplyExecutionClientError,
  FeishuReplyHttpClient,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
} from '../packages/plugin-feishu/dist/index.js'

const ACCOUNT_ID = 'feishu-account:synthetic-reply-adapter'
const APP_ID = 'cli_synthetic_reply_adapter'
const BOT_PRINCIPAL_ID = 'ou_synthetic_reply_adapter_bot'
const USER_PRINCIPAL_ID = 'ou_synthetic_reply_adapter_user'
const PRIVATE_APP_SECRET = 'synthetic-private-reply-adapter-app-secret'
const PRIVATE_ACCESS_TOKEN = 'u-synthetic-private-reply-adapter-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-reply-adapter-refresh-token'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-reply-adapter-client-secret'
const PRIVATE_TENANT_TOKEN = 't-synthetic-private-reply-adapter-tenant-token'
const PRIVATE_CONTENT = 'Synthetic approved reply from the production adapter.'
const TARGET_MESSAGE_ID = 'om_synthetic_reply_adapter_target'
const RESULT_MESSAGE_ID = 'om_synthetic_reply_adapter_result'
const IDEMPOTENCY_KEY = `tdfr1:${'b'.repeat(40)}`
const NOW = Date.parse('2026-08-28T17:00:00.000Z')
const SENT_MILLISECONDS = NOW + 1_000

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {Uint8Array} value */
function decoded(value) {
  return new TextDecoder().decode(value)
}

/** @param {unknown} value */
function encoded(value) {
  return bytes(`${JSON.stringify(value)}\n`)
}

/** @param {unknown} value */
function jsonResponse(value) {
  const body = bytes(JSON.stringify(value))
  return {
    body,
    response: new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(body)
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    ),
  }
}

function userConfiguration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Reply Adapter User',
      principalId: USER_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-reply-adapter-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

function botConfiguration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Reply Adapter Bot',
      principalId: BOT_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-reply-adapter-bot',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
  }
}

/** @param {'bot' | 'user'} identityType */
function request(identityType) {
  const identity = identityType === 'bot' ? botConfiguration().bot : userConfiguration().user
  return /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuReplyExecutionRequest} */ ({
    kind: 'feishu_reply_execution_request',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    identityType,
    principalId: identity.principalId,
    credentialReference: identity.credentialReference,
    targetMessageId: TARGET_MESSAGE_ID,
    content: PRIVATE_CONTENT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
}

/** @param {{lost?: boolean, delegate?: import('../packages/plugin-feishu/dist/index.js').FeishuRuntimeLease}} [options] */
function leaseFixture(options = {}) {
  let checks = 0
  return {
    lease: {
      assertHeld() {
        checks += 1
        if (options.lost) throw new Error(PRIVATE_ACCESS_TOKEN)
        options.delegate?.assertHeld()
      },
    },
    checks: () => checks,
  }
}

/**
 * @param {{scopes?: string[], scopesByRead?: string[][], accessTokenExpiresAt?: string, lostLease?: boolean, replyFailure?: 'network', rotationError?: 'rotation_pending' | 'rotation_uncertain' | 'reauthorization_required', runtimeLease?: import('../packages/plugin-feishu/dist/index.js').FeishuRuntimeLease}} [options]
 */
function userFixture(options = {}) {
  const configuration = userConfiguration()
  /** @type {Uint8Array[]} */
  const resolved = []
  let keychainReads = 0
  let replyCalls = 0
  /** @type {string | null | undefined} */
  let authorization
  /** @type {Uint8Array | undefined} */
  let replyRequestBody
  /** @type {unknown} */
  let parsedReplyRequest
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        keychainReads += 1
        const value = encoded({
          kind: 'feishu_user_oauth_credential_bundle',
          schemaVersion: 1,
          appId: APP_ID,
          principalId: USER_PRINCIPAL_ID,
          clientSecret: PRIVATE_CLIENT_SECRET,
          tokenType: 'Bearer',
          accessToken: PRIVATE_ACCESS_TOKEN,
          obtainedAt: '2026-08-28T16:00:00.000Z',
          accessTokenExpiresAt: options.accessTokenExpiresAt ?? '2026-08-28T18:00:00.000Z',
          refreshToken: PRIVATE_REFRESH_TOKEN,
          refreshTokenExpiresAt: '2026-09-04T16:00:00.000Z',
          scopes: options.scopesByRead?.[keychainReads - 1] ??
            options.scopes ?? ['im:message:send_as_user', 'offline_access'],
        })
        resolved.push(value)
        return value
      },
    },
  })
  const userScopeProbe = new FeishuUserCredentialScopeProbe({
    configuration,
    resolver,
    now: () => NOW,
  })
  let userRotationCoordinator
  const rotationError = options.rotationError
  if (rotationError !== undefined) {
    userRotationCoordinator = new FeishuOAuthRotationCoordinator({
      resolver,
      refresher: new FeishuOAuthV3TokenRefresher({
        now: () => NOW,
        transport: {
          async send() {
            return { status: 200, body: encoded({}) }
          },
        },
      }),
      replacer: new FeishuSystemKeychainSecretReplacer({
        platform: 'darwin',
        runner: { async replace() {} },
      }),
      journal: new FeishuOAuthRotationJournal(
        join(tmpdir(), 'twindesk-unused-reply-adapter-rotation.jsonl'),
      ),
      now: () => NOW,
    })
    Object.defineProperty(userRotationCoordinator, 'refreshIfNeeded', {
      value: async () => {
        throw new FeishuOAuthRotationError(rotationError, 'Synthetic private rotation detail.')
      },
    })
  }
  /** @type {Uint8Array[]} */
  const replyResponses = []
  const replyClient = new FeishuReplyHttpClient({
    fetch: async (_url, init) => {
      replyCalls += 1
      assert.ok(init !== undefined)
      authorization = new Headers(init.headers).get('authorization')
      assert.ok(init.body instanceof Uint8Array)
      replyRequestBody = init.body
      parsedReplyRequest = JSON.parse(decoded(init.body))
      if (options.replyFailure === 'network') throw new Error(PRIVATE_ACCESS_TOKEN)
      const current = jsonResponse({
        code: 0,
        msg: 'success',
        data: { message_id: RESULT_MESSAGE_ID, create_time: String(SENT_MILLISECONDS) },
      })
      replyResponses.push(current.body)
      return current.response
    },
  })
  const lease = leaseFixture({
    ...(options.lostLease === undefined ? {} : { lost: options.lostLease }),
    ...(options.runtimeLease === undefined ? {} : { delegate: options.runtimeLease }),
  })
  return {
    adapter: new FeishuReplyExecutionAdapter({
      configuration,
      lease: lease.lease,
      resolver,
      replyClient,
      userScopeProbe,
      ...(userRotationCoordinator === undefined ? {} : { userRotationCoordinator }),
      now: () => NOW,
    }),
    diagnostics: () => ({ keychainReads, replyCalls, leaseChecks: lease.checks() }),
    resolved,
    replyResponses,
    captured: () => ({ authorization, replyRequestBody, parsedReplyRequest }),
  }
}

test('User reply composition holds the lease, checks scope, and keeps tokens callback-scoped', async () => {
  const current = userFixture()
  const result = await current.adapter.send(request('user'), new AbortController().signal)

  assert.deepEqual(result, {
    status: 'found',
    accountId: ACCOUNT_ID,
    identityType: 'user',
    idempotencyKey: IDEMPOTENCY_KEY,
    targetMessageId: TARGET_MESSAGE_ID,
    messageId: RESULT_MESSAGE_ID,
    sentAt: new Date(SENT_MILLISECONDS).toISOString(),
  })
  assert.deepEqual(current.diagnostics(), { keychainReads: 2, replyCalls: 1, leaseChecks: 3 })
  const captured = current.captured()
  assert.equal(captured.authorization, `Bearer ${PRIVATE_ACCESS_TOKEN}`)
  assert.deepEqual(captured.parsedReplyRequest, {
    content: JSON.stringify({ text: PRIVATE_CONTENT }),
    msg_type: 'text',
    uuid: IDEMPOTENCY_KEY,
  })
  assert.ok(captured.replyRequestBody instanceof Uint8Array)
  for (const value of [...current.resolved, ...current.replyResponses, captured.replyRequestBody]) {
    assert.equal(
      value.every((byte) => byte === 0),
      true,
    )
  }
})

test('User scope, refresh, lease, and request failures occur before reply HTTP', async () => {
  /**
   * @param {ReturnType<typeof userFixture>} current
   * @param {unknown} value
   * @param {string} expectedCode
   * @param {number} expectedReads
   */
  async function rejectsBeforeReply(current, value, expectedCode, expectedReads) {
    await assert.rejects(
      current.adapter.send(/** @type {any} */ (value), new AbortController().signal),
      (error) =>
        error instanceof FeishuReplyExecutionClientError &&
        error.code === expectedCode &&
        !error.message.includes(PRIVATE_ACCESS_TOKEN) &&
        !error.message.includes(PRIVATE_CONTENT),
    )
    assert.equal(current.diagnostics().keychainReads, expectedReads)
    assert.equal(current.diagnostics().replyCalls, 0)
  }

  await rejectsBeforeReply(
    userFixture({ scopes: ['offline_access'] }),
    request('user'),
    'scope_missing',
    1,
  )
  await rejectsBeforeReply(
    userFixture({ accessTokenExpiresAt: new Date(NOW).toISOString() }),
    request('user'),
    'preflight_unavailable',
    1,
  )
  await rejectsBeforeReply(
    userFixture({ lostLease: true }),
    request('user'),
    'preflight_unavailable',
    0,
  )
  await rejectsBeforeReply(
    userFixture({
      scopesByRead: [['im:message:send_as_user', 'offline_access'], ['offline_access']],
    }),
    request('user'),
    'scope_missing',
    2,
  )
  await rejectsBeforeReply(
    userFixture(),
    { ...request('user'), principalId: 'ou_synthetic_wrong_user' },
    'invalid_response',
    0,
  )
})

test('User rotation recovery classes stay payload-free and never reach scope or reply HTTP', async () => {
  const scenarios = [
    ['rotation_pending', 'preflight_unavailable'],
    ['rotation_uncertain', 'credential_rotation_uncertain'],
    ['reauthorization_required', 'credential_reauthorization_required'],
  ]
  for (const [rotationError, expectedCode] of scenarios) {
    const current = userFixture({
      rotationError:
        /** @type {'rotation_pending' | 'rotation_uncertain' | 'reauthorization_required'} */ (
          rotationError
        ),
    })
    await assert.rejects(
      current.adapter.prepare(request('user'), new AbortController().signal),
      (error) =>
        error instanceof FeishuReplyExecutionClientError &&
        error.code === expectedCode &&
        !error.message.includes('Synthetic private rotation detail.'),
    )
    assert.deepEqual(current.diagnostics(), { keychainReads: 0, replyCalls: 0, leaseChecks: 1 })
  }
})

test('post-dispatch network ambiguity remains distinct from retryable preflight failure', async () => {
  const current = userFixture({ replyFailure: 'network' })
  await assert.rejects(
    current.adapter.send(request('user'), new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyExecutionClientError &&
      error.code === 'network' &&
      !error.message.includes(PRIVATE_ACCESS_TOKEN),
  )
  assert.deepEqual(current.diagnostics(), { keychainReads: 2, replyCalls: 1, leaseChecks: 3 })
  const captured = current.captured()
  assert.ok(captured.replyRequestBody instanceof Uint8Array)
  assert.equal(
    captured.replyRequestBody.every((byte) => byte === 0),
    true,
  )
})

function botFixture() {
  const configuration = botConfiguration()
  /** @type {Uint8Array[]} */
  const resolved = []
  /** @type {Uint8Array[]} */
  const transientBodies = []
  /** @type {string[]} */
  const calls = []
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        calls.push('keychain')
        const value = encoded({
          kind: 'feishu_app_credential_bundle',
          schemaVersion: 1,
          appId: APP_ID,
          appSecret: PRIVATE_APP_SECRET,
        })
        resolved.push(value)
        return value
      },
    },
  })
  const tokenAcquirer = new FeishuBotTenantTokenAcquirer({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(url, FEISHU_BOT_TENANT_TOKEN_URL)
      calls.push('token')
      assert.ok(init?.body instanceof Uint8Array)
      assert.deepEqual(JSON.parse(decoded(init.body)), {
        app_id: APP_ID,
        app_secret: PRIVATE_APP_SECRET,
      })
      transientBodies.push(init.body)
      const current = jsonResponse({
        code: 0,
        msg: 'success',
        tenant_access_token: PRIVATE_TENANT_TOKEN,
        expire: 7140,
      })
      transientBodies.push(current.body)
      return current.response
    },
  })
  let scopeCall = 0
  const scopeClient = new FeishuBotIdentityScopeHttpClient({
    fetch: async (url, init) => {
      calls.push(scopeCall === 0 ? 'bot_info' : 'app_info')
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        `Bearer ${PRIVATE_TENANT_TOKEN}`,
      )
      const value =
        scopeCall++ === 0
          ? {
              code: 0,
              msg: 'success',
              bot: { open_id: BOT_PRINCIPAL_ID, app_name: 'Synthetic Bot' },
            }
          : {
              code: 0,
              msg: 'success',
              data: {
                app: {
                  app_id: APP_ID,
                  scopes: [{ scope: 'im:message:send_as_bot', token_types: ['tenant'] }],
                },
              },
            }
      assert.equal(
        url,
        scopeCall === 1
          ? FEISHU_BOT_INFO_URL
          : `https://open.feishu.cn/open-apis/application/v6/applications/${APP_ID}?lang=zh_cn`,
      )
      const current = jsonResponse(value)
      transientBodies.push(current.body)
      return current.response
    },
  })
  const botScopeProbe = new FeishuBotKeychainScopeProbe({
    configuration,
    resolver,
    tokenAcquirer,
    scopeClient,
    now: () => NOW,
  })
  const replyClient = new FeishuReplyHttpClient({
    fetch: async (_url, init) => {
      calls.push('reply')
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        `Bearer ${PRIVATE_TENANT_TOKEN}`,
      )
      assert.ok(init?.body instanceof Uint8Array)
      transientBodies.push(init.body)
      const current = jsonResponse({
        code: 0,
        msg: 'success',
        data: { message_id: RESULT_MESSAGE_ID, create_time: String(SENT_MILLISECONDS) },
      })
      transientBodies.push(current.body)
      return current.response
    },
  })
  const lease = leaseFixture()
  return {
    adapter: new FeishuReplyExecutionAdapter({
      configuration,
      lease: lease.lease,
      resolver,
      replyClient,
      botScopeProbe,
      botTokenAcquirer: tokenAcquirer,
      now: () => NOW,
    }),
    calls,
    resolved,
    transientBodies,
    lease,
  }
}

test('Bot reply composition verifies current tenant scope before obtaining a send token', async () => {
  const current = botFixture()
  const result = await current.adapter.send(request('bot'), new AbortController().signal)

  assert.deepEqual(result, {
    status: 'found',
    accountId: ACCOUNT_ID,
    identityType: 'bot',
    idempotencyKey: IDEMPOTENCY_KEY,
    targetMessageId: TARGET_MESSAGE_ID,
    messageId: RESULT_MESSAGE_ID,
    sentAt: new Date(SENT_MILLISECONDS).toISOString(),
  })
  assert.deepEqual(current.calls, [
    'keychain',
    'token',
    'bot_info',
    'app_info',
    'keychain',
    'token',
    'reply',
  ])
  assert.equal(current.lease.checks(), 3)
  for (const value of [...current.resolved, ...current.transientBodies]) {
    assert.equal(
      value.every((byte) => byte === 0),
      true,
    )
  }
})

test('adapter construction rejects incomplete identity composition without reading credentials', () => {
  const configuration = userConfiguration()
  let reads = 0
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        reads += 1
        return encoded({})
      },
    },
  })
  assert.throws(
    () =>
      new FeishuReplyExecutionAdapter(
        /** @type {any} */ ({
          configuration,
          lease: leaseFixture().lease,
          resolver,
          replyClient: new FeishuReplyHttpClient({ fetch: async () => assert.fail() }),
        }),
      ),
    (error) =>
      error instanceof FeishuReplyExecutionClientError && error.code === 'invalid_response',
  )
  assert.equal(reads, 0)
})

test('adapter cancellation is observed before lease, credential, scope, or HTTP access', async () => {
  const current = userFixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(current.adapter.send(request('user'), controller.signal), {
    name: 'AbortError',
  })
  assert.deepEqual(current.diagnostics(), { keychainReads: 0, replyCalls: 0, leaseChecks: 0 })
})

test('the real Host lease owns the adapter lifetime and rejects use after release', async () => {
  const manager = new FeishuRuntimeLeaseManager()
  /** @type {ReturnType<typeof userFixture> | undefined} */
  let current
  await manager.withLease(
    userConfiguration(),
    new AbortController().signal,
    async (runtimeLease) => {
      current = userFixture({ runtimeLease })
      const result = await current.adapter.send(request('user'), new AbortController().signal)
      assert.equal(/** @type {any} */ (result).status, 'found')
      assert.deepEqual(current.diagnostics(), {
        keychainReads: 2,
        replyCalls: 1,
        leaseChecks: 3,
      })
    },
  )
  assert.ok(current !== undefined)
  await assert.rejects(
    current.adapter.send(request('user'), new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyExecutionClientError && error.code === 'preflight_unavailable',
  )
  assert.deepEqual(current.diagnostics(), { keychainReads: 2, replyCalls: 1, leaseChecks: 4 })
})
