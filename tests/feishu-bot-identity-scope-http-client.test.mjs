import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES,
  FEISHU_BOT_INFO_URL,
  FeishuBotIdentityScopeHttpClient,
  FeishuOperationScopeProbeClientError,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_bot_scope'
const PRINCIPAL_ID = 'ou_synthetic_bot_scope'
const PRIVATE_TOKEN = 't-synthetic-private-bot-scope-token'
const APPLICATION_URL = `https://open.feishu.cn/open-apis/application/v6/applications/${APP_ID}?lang=zh_cn`

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {unknown} value */
function json(value) {
  return bytes(JSON.stringify(value))
}

/**
 * @param {BodyInit | null} body
 * @param {{status?: number, headers?: HeadersInit}} [options]
 */
function response(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** @param {Record<string, unknown>} [changes] */
function botBody(changes = {}) {
  return json({
    code: 0,
    msg: 'success',
    bot: { open_id: PRINCIPAL_ID, app_name: 'Synthetic Bot' },
    ...changes,
  })
}

/** @param {Record<string, unknown>} [changes] */
function scopeBody(changes = {}) {
  return json({
    code: 0,
    msg: 'success',
    data: {
      app: {
        app_id: APP_ID,
        scopes: [
          { scope: 'im:message:send_as_bot', token_types: ['tenant'] },
          { scope: 'im:chat:read', token_types: ['user', 'tenant'] },
          { scope: 'search:message', token_types: ['user'] },
        ],
      },
    },
    ...changes,
  })
}

test('Bot scope HTTP inspection verifies the exact principal and returns tenant scopes only', async () => {
  const bot = botBody()
  const app = scopeBody()
  const botFirst = bot.slice(0, 19)
  const botSecond = bot.slice(19)
  const appFirst = app.slice(0, 31)
  const appSecond = app.slice(31)
  /** @type {Array<{url: string, init: RequestInit}>} */
  const calls = []
  const client = new FeishuBotIdentityScopeHttpClient({
    fetch: async (url, init) => {
      assert.ok(init !== undefined)
      calls.push({ url: String(url), init })
      const chunks = url === FEISHU_BOT_INFO_URL ? [botFirst, botSecond] : [appFirst, appSecond]
      return response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
      )
    },
  })
  const token = bytes(PRIVATE_TOKEN)
  const observation = await client.inspect(
    { appId: APP_ID, accessToken: token },
    new AbortController().signal,
  )

  assert.deepEqual(observation, {
    kind: 'feishu_bot_identity_scope_observation',
    schemaVersion: 1,
    appId: APP_ID,
    principalId: PRINCIPAL_ID,
    grantedScopes: ['im:chat:read', 'im:message:send_as_bot'],
  })
  assert.equal(Object.isFrozen(observation), true)
  assert.equal(Object.isFrozen(observation.grantedScopes), true)
  assert.deepEqual(
    calls.map(({ url }) => url),
    [FEISHU_BOT_INFO_URL, APPLICATION_URL],
  )
  for (const { init } of calls) {
    assert.equal(init.method, 'GET')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    assert.equal(init.referrerPolicy, 'no-referrer')
    assert.equal(new Headers(init.headers).get('accept'), 'application/json')
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${PRIVATE_TOKEN}`)
    assert.ok(init.signal instanceof AbortSignal)
  }
  assert.equal(new TextDecoder().decode(token), PRIVATE_TOKEN)
  for (const chunk of [botFirst, botSecond, appFirst, appSecond]) {
    assert.equal(
      chunk.every((value) => value === 0),
      true,
    )
  }
  token.fill(0)
})

test('Bot scope inspection maps HTTP and application failures without response payloads', async () => {
  /** @type {Array<[number, Record<string, unknown>, string]>} */
  const cases = [
    [401, { code: 0 }, 'not_authorized'],
    [429, { code: 0 }, 'rate_limited'],
    [503, { code: 0 }, 'unavailable'],
    [200, { code: 99991400, msg: PRIVATE_TOKEN }, 'rate_limited'],
    [200, { code: 99991663, msg: PRIVATE_TOKEN }, 'not_authorized'],
    [200, { code: 123456789, msg: PRIVATE_TOKEN }, 'invalid_response'],
  ]
  for (const [status, value, expectedCode] of cases) {
    const token = bytes(PRIVATE_TOKEN)
    await assert.rejects(
      new FeishuBotIdentityScopeHttpClient({
        fetch: async () => response(json(value), { status }),
      }).inspect({ appId: APP_ID, accessToken: token }, new AbortController().signal),
      (error) =>
        error instanceof FeishuOperationScopeProbeClientError &&
        error.code === expectedCode &&
        !error.message.includes(PRIVATE_TOKEN),
    )
    assert.equal(new TextDecoder().decode(token), PRIVATE_TOKEN)
    token.fill(0)
  }
})

test('Bot scope inspection rejects malformed identity and application scope responses', async () => {
  const malformed = [
    json({ code: 0, msg: 'success', bot: { open_id: '' } }),
    bytes(`{"code":0,"msg":"success","bot":{"open_id":"first","open_id":"${PRINCIPAL_ID}"}}`),
    json({ code: 0, msg: 'success', bot: { open_id: PRINCIPAL_ID }, extra: PRIVATE_TOKEN }),
  ]
  for (const body of malformed) {
    await assert.rejects(
      new FeishuBotIdentityScopeHttpClient({ fetch: async () => response(body) }).inspect(
        { appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) },
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOperationScopeProbeClientError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_TOKEN),
    )
  }

  const badScopes = [
    [{ scope: 'im:message:send_as_bot', token_types: [] }],
    [
      { scope: 'im:message:send_as_bot', token_types: ['tenant'] },
      { scope: 'im:message:send_as_bot', token_types: ['user'] },
    ],
    [{ scope: 'im:message:send_as_bot', token_types: ['tenant', 'tenant'] }],
    [{ scope: 'bad scope', token_types: ['tenant'] }],
  ]
  for (const scopes of badScopes) {
    let call = 0
    await assert.rejects(
      new FeishuBotIdentityScopeHttpClient({
        fetch: async () =>
          response(call++ === 0 ? botBody() : scopeBody({ data: { app: { scopes } } })),
      }).inspect(
        { appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) },
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
    )
  }
})

test('Bot scope inspection rejects declared and streamed responses over its bound', async () => {
  let cancelled = false
  await assert.rejects(
    new FeishuBotIdentityScopeHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES + 1),
              'content-type': 'application/json',
            },
          },
        ),
    }).inspect({ appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) }, new AbortController().signal),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
  )
  assert.equal(cancelled, true)

  const oversized = new Uint8Array(FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES + 1)
  await assert.rejects(
    new FeishuBotIdentityScopeHttpClient({
      fetch: async () =>
        response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized)
            },
          }),
        ),
    }).inspect({ appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) }, new AbortController().signal),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
  )
  assert.equal(
    oversized.every((value) => value === 0),
    true,
  )
})

test('Bot scope inspection propagates caller cancellation and bounds a stalled request', async () => {
  const caller = new AbortController()
  const cancelled = new FeishuBotIdentityScopeHttpClient({
    fetch: (_url, init) => {
      assert.ok(init?.signal instanceof AbortSignal)
      const signal = init.signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }).inspect({ appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) }, caller.signal)
  caller.abort(new Error('synthetic cancellation'))
  await assert.rejects(cancelled, /synthetic cancellation/u)

  await assert.rejects(
    new FeishuBotIdentityScopeHttpClient({
      timeoutMilliseconds: 5,
      fetch: (_url, init) => {
        assert.ok(init?.signal instanceof AbortSignal)
        const signal = init.signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }).inspect({ appId: APP_ID, accessToken: bytes(PRIVATE_TOKEN) }, new AbortController().signal),
    (error) => error instanceof FeishuOperationScopeProbeClientError && error.code === 'network',
  )
})

test('Bot scope client rejects hostile options and requests without invoking accessors or Fetch', async () => {
  let reads = 0
  const hostileOptions = {}
  Object.defineProperty(hostileOptions, 'fetch', {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(PRIVATE_TOKEN)
    },
  })
  assert.throws(
    () => new FeishuBotIdentityScopeHttpClient(/** @type {any} */ (hostileOptions)),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError && error.code === 'invalid_response',
  )

  let fetchCalls = 0
  const hostileRequest = {}
  Object.defineProperty(hostileRequest, 'accessToken', {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(PRIVATE_TOKEN)
    },
  })
  await assert.rejects(
    new FeishuBotIdentityScopeHttpClient({
      fetch: async () => {
        fetchCalls += 1
        return response(botBody())
      },
    }).inspect(/** @type {any} */ (hostileRequest), new AbortController().signal),
    (error) =>
      error instanceof FeishuOperationScopeProbeClientError &&
      error.code === 'invalid_response' &&
      !error.message.includes(PRIVATE_TOKEN),
  )
  assert.equal(reads, 0)
  assert.equal(fetchCalls, 0)
})
