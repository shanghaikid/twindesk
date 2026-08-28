import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS,
  FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_V3_TOKEN_URL,
  FeishuOAuthV3RefreshError,
  FeishuOAuthV3TokenRefresher,
} from '../packages/plugin-feishu/dist/index.js'

const CLIENT_ID = 'cli_synthetic_oauth_refresh'
const PRIVATE_CLIENT_SECRET = 'synthetic-client-secret'
const PRIVATE_OLD_REFRESH_TOKEN = 'synthetic-old-refresh-token+/='
const PRIVATE_NEW_ACCESS_TOKEN = 'synthetic-new-access-token'
const PRIVATE_NEW_REFRESH_TOKEN = 'synthetic-new-refresh-token'
const NOW = Date.parse('2026-08-28T10:00:00.000Z')

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {Record<string, unknown>} [changes] */
function responseBody(changes = {}) {
  return bytes(
    JSON.stringify({
      code: 0,
      access_token: PRIVATE_NEW_ACCESS_TOKEN,
      expires_in: 7200,
      refresh_token: PRIVATE_NEW_REFRESH_TOKEN,
      refresh_token_expires_in: 604800,
      scope: 'offline_access im:message:readonly im:message',
      token_type: 'Bearer',
      ...changes,
    }),
  )
}

/** @param {Record<string, unknown>} [changes] */
function input(changes = {}) {
  return {
    clientId: CLIENT_ID,
    clientSecret: bytes(PRIVATE_CLIENT_SECRET),
    refreshToken: bytes(PRIVATE_OLD_REFRESH_TOKEN),
    ...changes,
  }
}

/** @param {Uint8Array} value */
function decoded(value) {
  return Buffer.from(value).toString('utf8')
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

test('OAuth v3 refresh uses an exact form request and callback-scoped rotated tokens', async () => {
  const response = responseBody()
  /** @type {Uint8Array | undefined} */
  let requestBody
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet }} */
  const observed = {}
  const refresher = new FeishuOAuthV3TokenRefresher({
    now: () => NOW,
    transport: {
      async send(request, signal) {
        signal.throwIfAborted()
        assert.equal(request.method, 'POST')
        assert.equal(request.url, FEISHU_OAUTH_V3_TOKEN_URL)
        assert.deepEqual(request.headers, {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        })
        assert.equal(request.maximumResponseBytes, FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES)
        assert.equal(Object.isFrozen(request), true)
        assert.equal(Object.isFrozen(request.headers), true)
        requestBody = request.body
        assert.equal(
          decoded(request.body),
          'grant_type=refresh_token&client_id=cli_synthetic_oauth_refresh&client_secret=synthetic-client-secret&refresh_token=synthetic-old-refresh-token%2B%2F%3D',
        )
        return { status: 200, body: response }
      },
    },
  })
  const result = await refresher.refresh(input(), new AbortController().signal, (tokenSet) => {
    observed.value = tokenSet
    assert.equal(tokenSet.tokenType, 'Bearer')
    assert.equal(decoded(tokenSet.accessToken), PRIVATE_NEW_ACCESS_TOKEN)
    assert.equal(decoded(tokenSet.refreshToken), PRIVATE_NEW_REFRESH_TOKEN)
    assert.equal(tokenSet.obtainedAt, '2026-08-28T10:00:00.000Z')
    assert.equal(tokenSet.accessTokenExpiresAt, '2026-08-28T12:00:00.000Z')
    assert.equal(tokenSet.refreshTokenExpiresAt, '2026-09-04T10:00:00.000Z')
    assert.deepEqual(tokenSet.scopes, ['im:message', 'im:message:readonly', 'offline_access'])
    assert.equal(Object.isFrozen(tokenSet), true)
    assert.equal(Object.isFrozen(tokenSet.scopes), true)
    return 'rotated'
  })
  assert.equal(result, 'rotated')
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(zeroed(response))
  assert.ok(observed.value !== undefined && zeroed(observed.value.accessToken))
  assert.ok(observed.value !== undefined && zeroed(observed.value.refreshToken))
})

test('single-use refresh failures require reauthorization without exposing payloads', async () => {
  for (const upstreamCode of [20026, 20037, 20064, 20073]) {
    const response = bytes(
      JSON.stringify({
        code: upstreamCode,
        error: 'synthetic-private-upstream-error',
        error_description: PRIVATE_OLD_REFRESH_TOKEN,
      }),
    )
    const refresher = new FeishuOAuthV3TokenRefresher({
      now: () => NOW,
      transport: { send: async () => ({ status: 400, body: response }) },
    })
    await assert.rejects(
      refresher.refresh(input(), new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthV3RefreshError &&
        error.code === 'reauthorization_required' &&
        error.retryDisposition === 'reauthorize' &&
        !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
    )
    assert.ok(zeroed(response))
  }
})

test('application failures require configuration repair rather than user reauthorization', async () => {
  for (const upstreamCode of [20002, 20009, 20048, 20069, 20074]) {
    const response = bytes(
      JSON.stringify({
        code: upstreamCode,
        error: 'synthetic-private-configuration-error',
        error_description: PRIVATE_CLIENT_SECRET,
      }),
    )
    await assert.rejects(
      new FeishuOAuthV3TokenRefresher({
        transport: { send: async () => ({ status: 400, body: response }) },
      }).refresh(input(), new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthV3RefreshError &&
        error.code === 'configuration_invalid' &&
        error.retryDisposition === 'do_not_retry' &&
        !error.message.includes(PRIVATE_CLIENT_SECRET),
    )
    assert.ok(zeroed(response))
  }
})

test('temporary service and transport failures are retryable and payload-free', async () => {
  /** @type {Array<[number, Uint8Array]>} */
  const serviceFailures = [
    [429, responseBody()],
    [503, bytes(PRIVATE_NEW_ACCESS_TOKEN)],
    [429, new Uint8Array()],
    [503, new Uint8Array()],
  ]
  for (const [status, body] of serviceFailures) {
    const refresher = new FeishuOAuthV3TokenRefresher({
      now: () => NOW,
      transport: { send: async () => ({ status, body }) },
    })
    await assert.rejects(
      refresher.refresh(input(), new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthV3RefreshError &&
        error.code === 'retry_later' &&
        error.retryDisposition === 'retry_later' &&
        !error.message.includes(PRIVATE_NEW_ACCESS_TOKEN),
    )
    assert.ok(zeroed(body))
  }

  const privateFailure = new Error(PRIVATE_OLD_REFRESH_TOKEN)
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({
      transport: { send: async () => Promise.reject(privateFailure) },
    }).refresh(input(), new AbortController().signal, () => undefined),
    (error) =>
      error instanceof FeishuOAuthV3RefreshError &&
      error.code === 'retry_later' &&
      !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
  )
})

test('malformed token responses fail closed and clear every supplied body', async () => {
  const cases = [
    responseBody({ token_type: 'Basic' }),
    responseBody({ refresh_token: PRIVATE_OLD_REFRESH_TOKEN }),
    responseBody({ scope: 'im:message' }),
    responseBody({ scope: 'offline_access offline_access' }),
    responseBody({ expires_in: 0 }),
    responseBody({ refresh_token_expires_in: FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS + 1 }),
    responseBody({ unknown_private_field: PRIVATE_OLD_REFRESH_TOKEN }),
    bytes(
      `{"code":0,"access_token":"first","access_token":"${PRIVATE_NEW_ACCESS_TOKEN}","expires_in":7200,"refresh_token":"${PRIVATE_NEW_REFRESH_TOKEN}","refresh_token_expires_in":604800,"scope":"im:message offline_access","token_type":"Bearer"}`,
    ),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array(FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES + 1).fill(7),
  ]
  for (const body of cases) {
    await assert.rejects(
      new FeishuOAuthV3TokenRefresher({
        now: () => NOW,
        transport: { send: async () => ({ status: 200, body }) },
      }).refresh(input(), new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthV3RefreshError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_OLD_REFRESH_TOKEN),
    )
    assert.ok(zeroed(body))
  }
})

test('invalid inputs, clocks, consumers, and transport responses fail closed', async () => {
  let calls = 0
  const transport = {
    async send() {
      calls += 1
      return { status: 200, body: responseBody() }
    },
  }
  for (const invalidInput of [
    input({ clientId: '' }),
    input({ clientSecret: new Uint8Array() }),
    input({ refreshToken: new Uint8Array() }),
    { ...input(), unknown: PRIVATE_OLD_REFRESH_TOKEN },
  ]) {
    await assert.rejects(
      new FeishuOAuthV3TokenRefresher({ transport }).refresh(
        invalidInput,
        new AbortController().signal,
        () => undefined,
      ),
      (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_request',
    )
  }
  assert.equal(calls, 0)

  let inputAccessed = false
  const hostileInput = Object.defineProperty(input(), 'clientSecret', {
    enumerable: true,
    get() {
      inputAccessed = true
      return bytes(PRIVATE_CLIENT_SECRET)
    },
  })
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({ transport }).refresh(
      /** @type {never} */ (hostileInput),
      new AbortController().signal,
      () => undefined,
    ),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_request',
  )
  assert.equal(inputAccessed, false)
  assert.equal(calls, 0)

  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({ transport }).refresh(
      input(),
      new AbortController().signal,
      /** @type {(value: unknown) => void} */ (/** @type {unknown} */ (null)),
    ),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_request',
  )
  assert.equal(calls, 0)

  const invalidClockBody = responseBody()
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({
      now: () => Number.NaN,
      transport: { send: async () => ({ status: 200, body: invalidClockBody }) },
    }).refresh(input(), new AbortController().signal, () => undefined),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_clock',
  )
  assert.ok(zeroed(invalidClockBody))

  const hostileBody = responseBody()
  let accessed = false
  const hostile = Object.defineProperty({ body: hostileBody }, 'status', {
    enumerable: true,
    get() {
      accessed = true
      return 200
    },
  })
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({
      transport: { send: async () => /** @type {never} */ (hostile) },
    }).refresh(input(), new AbortController().signal, () => undefined),
    (error) => error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_transport',
  )
  assert.equal(accessed, false)
  assert.ok(zeroed(hostileBody))
})

test('cancellation before and during token consumption clears all transient secrets', async () => {
  let calls = 0
  const preCancelled = new AbortController()
  preCancelled.abort()
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({
      transport: {
        async send() {
          calls += 1
          return { status: 200, body: responseBody() }
        },
      },
    }).refresh(input(), preCancelled.signal, () => undefined),
    { name: 'AbortError' },
  )
  assert.equal(calls, 0)

  const controller = new AbortController()
  const response = responseBody()
  /** @type {Uint8Array | undefined} */
  let requestBody
  /** @type {{ value?: import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet }} */
  const observed = {}
  await assert.rejects(
    new FeishuOAuthV3TokenRefresher({
      now: () => NOW,
      transport: {
        async send(request) {
          requestBody = request.body
          return { status: 200, body: response }
        },
      },
    }).refresh(input(), controller.signal, (tokenSet) => {
      observed.value = tokenSet
      controller.abort()
      return 'must-not-succeed'
    }),
    { name: 'AbortError' },
  )
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(zeroed(response))
  assert.ok(observed.value !== undefined && zeroed(observed.value.accessToken))
  assert.ok(observed.value !== undefined && zeroed(observed.value.refreshToken))
})
