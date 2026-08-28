import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_BOT_TENANT_TOKEN_MAX_LIFETIME_SECONDS,
  FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES,
  FEISHU_BOT_TENANT_TOKEN_URL,
  FeishuBotTenantTokenAcquirer,
  FeishuBotTenantTokenAcquisitionError,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_bot_token'
const PRIVATE_APP_SECRET = 'synthetic-"bot\\secret'
const PRIVATE_TENANT_TOKEN = 't-synthetic-private-tenant-token'
const NOW = Date.parse('2026-08-28T10:00:00.000Z')

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {Uint8Array} value */
function decoded(value) {
  return new TextDecoder().decode(value)
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

/** @param {Record<string, unknown>} [changes] */
function successBody(changes = {}) {
  return bytes(
    JSON.stringify({
      code: 0,
      msg: 'success',
      tenant_access_token: PRIVATE_TENANT_TOKEN,
      expire: 7140,
      ...changes,
    }),
  )
}

test('Bot tenant-token acquisition uses one fixed bounded request and callback-scoped token', async () => {
  const appSecret = bytes(PRIVATE_APP_SECRET)
  const response = successBody()
  const first = response.slice(0, 23)
  const second = response.slice(23)
  /** @type {Uint8Array | undefined} */
  let requestBody
  /** @type {Uint8Array | undefined} */
  let observedToken
  /** @type {RequestInit | undefined} */
  let observedInit
  const acquirer = new FeishuBotTenantTokenAcquirer({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(url, FEISHU_BOT_TENANT_TOKEN_URL)
      assert.ok(init?.body instanceof Uint8Array)
      requestBody = init.body
      observedInit = init
      assert.deepEqual(JSON.parse(decoded(init.body)), {
        app_id: APP_ID,
        app_secret: PRIVATE_APP_SECRET,
      })
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first)
            controller.enqueue(second)
            controller.close()
          },
        }),
        {
          status: 200,
          headers: {
            'content-length': String(response.byteLength),
            'content-type': 'application/json; charset=utf-8',
          },
        },
      )
    },
  })

  const result = await acquirer.acquire(
    { appId: APP_ID, appSecret },
    new AbortController().signal,
    (token) => {
      observedToken = token.accessToken
      assert.equal(token.tokenType, 'Bearer')
      assert.equal(decoded(token.accessToken), PRIVATE_TENANT_TOKEN)
      assert.equal(token.obtainedAt, '2026-08-28T10:00:00.000Z')
      assert.equal(token.expiresAt, '2026-08-28T11:59:00.000Z')
      assert.equal(Object.isFrozen(token), true)
      return 'acquired'
    },
  )

  assert.equal(result, 'acquired')
  assert.ok(observedInit !== undefined)
  assert.equal(observedInit.method, 'POST')
  assert.equal(observedInit.cache, 'no-store')
  assert.equal(observedInit.credentials, 'omit')
  assert.equal(observedInit.redirect, 'error')
  assert.equal(observedInit.referrerPolicy, 'no-referrer')
  assert.ok(observedInit.signal instanceof AbortSignal)
  assert.equal(new Headers(observedInit.headers).get('accept'), 'application/json')
  assert.equal(
    new Headers(observedInit.headers).get('content-type'),
    'application/json; charset=utf-8',
  )
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(observedToken !== undefined && zeroed(observedToken))
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
  assert.equal(decoded(appSecret), PRIVATE_APP_SECRET)
  appSecret.fill(0)
  response.fill(0)
})

test('rejected Bot credentials require configuration repair without exposing payloads', async () => {
  const privateResponse = bytes(
    JSON.stringify({ code: 10014, msg: `rejected ${PRIVATE_APP_SECRET}` }),
  )
  const appSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      fetch: async () =>
        new Response(privateResponse, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    }).acquire({ appId: APP_ID, appSecret }, new AbortController().signal, () => undefined),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError &&
      error.code === 'configuration_invalid' &&
      error.retryDisposition === 'repair_configuration' &&
      !error.message.includes(PRIVATE_APP_SECRET),
  )
  assert.equal(decoded(appSecret), PRIVATE_APP_SECRET)
  appSecret.fill(0)
})

test('application-level rate limiting remains retryable and unknown codes fail closed', async () => {
  for (const [code, expectedCode, expectedDisposition] of [
    [99991400, 'retry_later', 'retry_later'],
    [123456789, 'invalid_response', 'do_not_retry'],
  ]) {
    const appSecret = bytes(PRIVATE_APP_SECRET)
    await assert.rejects(
      new FeishuBotTenantTokenAcquirer({
        fetch: async () =>
          new Response(JSON.stringify({ code, msg: PRIVATE_APP_SECRET }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }).acquire({ appId: APP_ID, appSecret }, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuBotTenantTokenAcquisitionError &&
        error.code === expectedCode &&
        error.retryDisposition === expectedDisposition &&
        !error.message.includes(PRIVATE_APP_SECRET),
    )
    appSecret.fill(0)
  }
})

test('HTTP, network, and timeout failures have fixed retry dispositions', async () => {
  for (const status of [429, 503]) {
    let cancelled = false
    const appSecret = bytes(PRIVATE_APP_SECRET)
    await assert.rejects(
      new FeishuBotTenantTokenAcquirer({
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              },
            }),
            { status },
          ),
      }).acquire({ appId: APP_ID, appSecret }, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuBotTenantTokenAcquisitionError &&
        error.code === 'retry_later' &&
        error.retryDisposition === 'retry_later',
    )
    assert.equal(cancelled, true)
    appSecret.fill(0)
  }

  const networkSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      fetch: async () => {
        throw new Error(PRIVATE_APP_SECRET)
      },
    }).acquire(
      { appId: APP_ID, appSecret: networkSecret },
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError &&
      error.code === 'retry_later' &&
      !error.message.includes(PRIVATE_APP_SECRET),
  )
  networkSecret.fill(0)

  const timeoutSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      timeoutMilliseconds: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    }).acquire(
      { appId: APP_ID, appSecret: timeoutSecret },
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'retry_later',
  )
  timeoutSecret.fill(0)
})

test('malformed, duplicate, oversized, and non-JSON responses fail closed', async () => {
  const cases = [
    successBody({ expire: 0 }),
    successBody({ expire: FEISHU_BOT_TENANT_TOKEN_MAX_LIFETIME_SECONDS + 1 }),
    successBody({ tenant_access_token: '' }),
    successBody({ unknown: PRIVATE_APP_SECRET }),
    bytes(
      `{"code":0,"msg":"success","tenant_access_token":"first","tenant_access_token":"${PRIVATE_TENANT_TOKEN}","expire":7140}`,
    ),
    new Uint8Array([0xc3, 0x28]),
  ]
  for (const body of cases) {
    const appSecret = bytes(PRIVATE_APP_SECRET)
    await assert.rejects(
      new FeishuBotTenantTokenAcquirer({
        now: () => NOW,
        fetch: async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }).acquire({ appId: APP_ID, appSecret }, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuBotTenantTokenAcquisitionError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_APP_SECRET),
    )
    appSecret.fill(0)
  }

  let declaredBodyCancelled = false
  const declaredSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              declaredBodyCancelled = true
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES + 1),
              'content-type': 'application/json',
            },
          },
        ),
    }).acquire(
      { appId: APP_ID, appSecret: declaredSecret },
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_response',
  )
  assert.equal(declaredBodyCancelled, true)
  declaredSecret.fill(0)

  const first = new Uint8Array(10_000).fill(7)
  const second = new Uint8Array(10_000).fill(9)
  let overflowCancelled = false
  const overflowSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(first)
              controller.enqueue(second)
            },
            cancel() {
              overflowCancelled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    }).acquire(
      { appId: APP_ID, appSecret: overflowSecret },
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_response',
  )
  assert.equal(overflowCancelled, true)
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
  overflowSecret.fill(0)
})

test('cancellation clears transient values and completed consumers remain authoritative', async () => {
  const preCancelled = new AbortController()
  preCancelled.abort()
  let fetchCalls = 0
  const preSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      fetch: async () => {
        fetchCalls += 1
        return new Response()
      },
    }).acquire({ appId: APP_ID, appSecret: preSecret }, preCancelled.signal, () => undefined),
    { name: 'AbortError' },
  )
  assert.equal(fetchCalls, 0)
  preSecret.fill(0)

  const controller = new AbortController()
  const response = successBody()
  const activeSecret = bytes(PRIVATE_APP_SECRET)
  /** @type {Uint8Array | undefined} */
  let tokenBytes
  const result = await new FeishuBotTenantTokenAcquirer({
    now: () => NOW,
    fetch: async () =>
      new Response(response, { status: 200, headers: { 'content-type': 'application/json' } }),
  }).acquire({ appId: APP_ID, appSecret: activeSecret }, controller.signal, (token) => {
    tokenBytes = token.accessToken
    controller.abort()
    return 'completed-operation'
  })
  assert.equal(result, 'completed-operation')
  assert.ok(tokenBytes !== undefined && zeroed(tokenBytes))
  activeSecret.fill(0)
})

test('invalid clients, requests, clocks, and hostile values never reach Fetch', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    return new Response(successBody(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  for (const options of [
    { fetch: null },
    { timeoutMilliseconds: 0 },
    { timeoutMilliseconds: 120_001 },
    { now: null },
    { unknown: PRIVATE_APP_SECRET },
  ]) {
    assert.throws(
      () => new FeishuBotTenantTokenAcquirer(/** @type {never} */ (options)),
      (error) =>
        error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_client',
    )
  }

  const acquirer = new FeishuBotTenantTokenAcquirer({ fetch })
  for (const input of [
    { appId: '', appSecret: bytes(PRIVATE_APP_SECRET) },
    { appId: APP_ID, appSecret: new Uint8Array() },
    { appId: APP_ID, appSecret: bytes('contains space') },
    { appId: APP_ID, appSecret: bytes(PRIVATE_APP_SECRET), unknown: true },
  ]) {
    await assert.rejects(
      acquirer.acquire(/** @type {never} */ (input), new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_request',
    )
    input.appSecret.fill(0)
  }

  let accessorRead = false
  const hostileInput = Object.defineProperty({}, 'appId', {
    enumerable: true,
    get() {
      accessorRead = true
      return APP_ID
    },
  })
  await assert.rejects(
    acquirer.acquire(
      /** @type {never} */ (hostileInput),
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_request',
  )
  assert.equal(accessorRead, false)

  const clockSecret = bytes(PRIVATE_APP_SECRET)
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({ fetch, now: () => Number.NaN }).acquire(
      { appId: APP_ID, appSecret: clockSecret },
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuBotTenantTokenAcquisitionError && error.code === 'invalid_clock',
  )
  clockSecret.fill(0)
  assert.equal(calls, 1)
})

test('consumer failures propagate exactly after every transient secret is cleared', async () => {
  const privateFailure = new Error('synthetic-consumer-failure')
  const appSecret = bytes(PRIVATE_APP_SECRET)
  /** @type {Uint8Array | undefined} */
  let requestBody
  /** @type {Uint8Array | undefined} */
  let tokenBytes
  await assert.rejects(
    new FeishuBotTenantTokenAcquirer({
      now: () => NOW,
      fetch: async (_url, init) => {
        assert.ok(init?.body instanceof Uint8Array)
        requestBody = init.body
        return new Response(successBody(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }).acquire({ appId: APP_ID, appSecret }, new AbortController().signal, (token) => {
      tokenBytes = token.accessToken
      throw privateFailure
    }),
    (error) => error === privateFailure,
  )
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(tokenBytes !== undefined && zeroed(tokenBytes))
  appSecret.fill(0)
})
