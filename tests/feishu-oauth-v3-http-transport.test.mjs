import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_V3_TOKEN_URL,
  FeishuOAuthV3HttpTransport,
  FeishuOAuthV3RefreshError,
  FeishuOAuthV3TokenRefresher,
} from '../packages/plugin-feishu/dist/index.js'

const PRIVATE_REQUEST =
  'client_secret=synthetic-private-secret&refresh_token=synthetic-private-token'
const PRIVATE_RESPONSE = '{"code":0,"synthetic":"private-response"}'

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {Uint8Array} body */
function request(body) {
  return Object.freeze({
    method: 'POST',
    url: FEISHU_OAUTH_V3_TOKEN_URL,
    headers: Object.freeze({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    }),
    body,
    maximumResponseBytes: FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  })
}

/** @param {Uint8Array} value */
function decoded(value) {
  return Buffer.from(value).toString('utf8')
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

test('production OAuth transport sends one fixed no-redirect request and bounds streamed bytes', async () => {
  const requestBody = bytes(PRIVATE_REQUEST)
  const first = bytes(PRIVATE_RESPONSE.slice(0, 17))
  const second = bytes(PRIVATE_RESPONSE.slice(17))
  /** @type {RequestInit | undefined} */
  let observedInit
  const transport = new FeishuOAuthV3HttpTransport({
    fetch: async (url, init) => {
      assert.equal(url, FEISHU_OAUTH_V3_TOKEN_URL)
      observedInit = init
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
            'content-length': String(first.byteLength + second.byteLength),
            'content-type': 'application/json; charset=utf-8',
          },
        },
      )
    },
  })

  const response = await transport.send(request(requestBody), new AbortController().signal)
  assert.equal(response.status, 200)
  assert.equal(decoded(response.body), PRIVATE_RESPONSE)
  assert.equal(Object.isFrozen(response), true)
  assert.ok(observedInit !== undefined)
  assert.equal(observedInit.method, 'POST')
  assert.equal(observedInit.body, requestBody)
  assert.equal(observedInit.cache, 'no-store')
  assert.equal(observedInit.credentials, 'omit')
  assert.equal(observedInit.redirect, 'error')
  assert.equal(observedInit.referrerPolicy, 'no-referrer')
  assert.equal(new Headers(observedInit.headers).get('accept'), 'application/json')
  assert.equal(
    new Headers(observedInit.headers).get('content-type'),
    'application/x-www-form-urlencoded',
  )
  assert.ok(observedInit.signal instanceof AbortSignal)
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
  assert.equal(zeroed(requestBody), false)
  response.body.fill(0)
  requestBody.fill(0)
})

test('production transport composes with callback-scoped refresh and clears both directions', async () => {
  const responseChunk = bytes(
    JSON.stringify({
      code: 0,
      access_token: 'synthetic-composed-access-token',
      expires_in: 7200,
      refresh_token: 'synthetic-composed-refresh-token',
      refresh_token_expires_in: 604800,
      scope: 'offline_access im:message:readonly',
      token_type: 'Bearer',
    }),
  )
  /** @type {Uint8Array | undefined} */
  let requestBody
  const clientSecret = bytes('synthetic-composed-secret')
  const oldRefreshToken = bytes('synthetic-composed-old-refresh')
  const refresher = new FeishuOAuthV3TokenRefresher({
    now: () => Date.parse('2026-08-28T10:00:00.000Z'),
    transport: new FeishuOAuthV3HttpTransport({
      fetch: async (_url, init) => {
        assert.ok(init?.body instanceof Uint8Array)
        requestBody = init.body
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(responseChunk)
              controller.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    }),
  })
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet | undefined} */
  let observed
  const result = await refresher.refresh(
    {
      clientId: 'cli_synthetic_composed',
      clientSecret,
      refreshToken: oldRefreshToken,
    },
    new AbortController().signal,
    (tokenSet) => {
      observed = tokenSet
      assert.equal(decoded(tokenSet.accessToken), 'synthetic-composed-access-token')
      assert.equal(decoded(tokenSet.refreshToken), 'synthetic-composed-refresh-token')
      return 'composed'
    },
  )
  assert.equal(result, 'composed')
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(zeroed(responseChunk))
  assert.ok(observed !== undefined && zeroed(observed.accessToken))
  assert.ok(observed !== undefined && zeroed(observed.refreshToken))
  clientSecret.fill(0)
  oldRefreshToken.fill(0)
})

test('declared oversized responses are cancelled before the body is read', async () => {
  const requestBody = bytes(PRIVATE_REQUEST)
  let cancelled = false
  const transport = new FeishuOAuthV3HttpTransport({
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
            'content-length': String(FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES + 1),
            'content-type': 'application/json',
          },
        },
      ),
  })
  await assert.rejects(
    transport.send(request(requestBody), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthV3RefreshError &&
      error.code === 'invalid_response' &&
      error.retryDisposition === 'do_not_retry' &&
      !error.message.includes(PRIVATE_REQUEST),
  )
  assert.equal(cancelled, true)
  requestBody.fill(0)
})

test('stream overflow is cancelled and every received chunk is cleared', async () => {
  const requestBody = bytes(PRIVATE_REQUEST)
  const first = new Uint8Array(20_000).fill(7)
  const second = new Uint8Array(20_000).fill(9)
  let cancelled = false
  const transport = new FeishuOAuthV3HttpTransport({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first)
            controller.enqueue(second)
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  await assert.rejects(
    transport.send(request(requestBody), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthV3RefreshError &&
      error.code === 'invalid_response' &&
      error.retryDisposition === 'do_not_retry',
  )
  assert.equal(cancelled, true)
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
  requestBody.fill(0)
})

test('redirects and non-JSON responses fail closed without exposing payloads', async () => {
  for (const response of [
    new Response(PRIVATE_RESPONSE, {
      status: 302,
      headers: { 'content-type': 'application/json', location: 'https://synthetic.invalid' },
    }),
    new Response(PRIVATE_RESPONSE, { status: 200, headers: { 'content-type': 'text/plain' } }),
  ]) {
    const requestBody = bytes(PRIVATE_REQUEST)
    await assert.rejects(
      new FeishuOAuthV3HttpTransport({ fetch: async () => response }).send(
        request(requestBody),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthV3RefreshError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_RESPONSE),
    )
    assert.equal(response.bodyUsed, true)
    requestBody.fill(0)
  }
})

test('temporary HTTP failures remain retryable even when an intermediary omits JSON', async () => {
  const requestBody = bytes(PRIVATE_REQUEST)
  const transport = new FeishuOAuthV3HttpTransport({
    fetch: async () =>
      new Response(null, {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
  })
  const response = await transport.send(request(requestBody), new AbortController().signal)
  assert.equal(response.status, 503)
  assert.equal(response.body.byteLength, 0)
  requestBody.fill(0)
})

test('network failure, timeout, cancellation, and invalid configuration stay payload-free', async () => {
  const networkBody = bytes(PRIVATE_REQUEST)
  await assert.rejects(
    new FeishuOAuthV3HttpTransport({
      fetch: async () => {
        throw new Error(PRIVATE_RESPONSE)
      },
    }).send(request(networkBody), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthV3RefreshError &&
      error.code === 'retry_later' &&
      error.retryDisposition === 'retry_later' &&
      !error.message.includes(PRIVATE_RESPONSE),
  )
  networkBody.fill(0)

  /** @type {typeof fetch} */
  const waitingFetch = (_url, init) =>
    /** @type {Promise<Response>} */ (
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal !== null && signal !== undefined)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    )
  const timeoutBody = bytes(PRIVATE_REQUEST)
  await assert.rejects(
    new FeishuOAuthV3HttpTransport({
      fetch: waitingFetch,
      timeoutMilliseconds: 5,
    }).send(request(timeoutBody), new AbortController().signal),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'retry_later',
  )
  timeoutBody.fill(0)

  const stalledRequestBody = bytes(PRIVATE_REQUEST)
  const stalledResponseChunk = bytes(PRIVATE_RESPONSE)
  let stalledStreamCancelled = false
  await assert.rejects(
    new FeishuOAuthV3HttpTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(stalledResponseChunk)
            },
            cancel() {
              stalledStreamCancelled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      timeoutMilliseconds: 5,
    }).send(request(stalledRequestBody), new AbortController().signal),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'retry_later',
  )
  assert.equal(stalledStreamCancelled, true)
  assert.ok(zeroed(stalledResponseChunk))
  stalledRequestBody.fill(0)

  const controller = new AbortController()
  const cancelledBody = bytes(PRIVATE_REQUEST)
  const cancelled = new FeishuOAuthV3HttpTransport({
    fetch: waitingFetch,
  }).send(request(cancelledBody), controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  cancelledBody.fill(0)

  assert.throws(
    () => new FeishuOAuthV3HttpTransport({ timeoutMilliseconds: 0 }),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_transport',
  )
  for (const invalidOptions of [
    { fetch: null },
    { fetch: undefined },
    { timeoutMilliseconds: null },
    { timeoutMilliseconds: undefined },
  ]) {
    assert.throws(
      () => new FeishuOAuthV3HttpTransport(/** @type {never} */ (invalidOptions)),
      (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_transport',
    )
  }
  let accessed = false
  assert.throws(
    () =>
      new FeishuOAuthV3HttpTransport(
        Object.defineProperty({}, 'fetch', {
          enumerable: true,
          get() {
            accessed = true
            return fetch
          },
        }),
      ),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_transport',
  )
  assert.equal(accessed, false)
})
