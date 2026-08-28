import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_OAUTH_AUTHORIZE_URL,
  FEISHU_OAUTH_PKCE_RANDOM_BYTES,
  FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_V3_TOKEN_URL,
  FeishuOAuthAuthorizationError,
  FeishuOAuthAuthorizationFlow,
} from '../packages/plugin-feishu/dist/index.js'

const CLIENT_ID = 'cli_synthetic_authorization'
const PRIVATE_CLIENT_SECRET = 'synthetic-authorization-client-secret'
const PRIVATE_ACCESS_TOKEN = 'synthetic-authorization-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-authorization-refresh-token'
const REDIRECT_URI = 'http://127.0.0.1:43119/oauth/feishu/callback'
const NOW = Date.parse('2026-08-28T12:00:00.000Z')

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {Record<string, unknown>} [changes] */
function responseBody(changes = {}) {
  return bytes(
    JSON.stringify({
      code: 0,
      access_token: PRIVATE_ACCESS_TOKEN,
      expires_in: 7200,
      refresh_token: PRIVATE_REFRESH_TOKEN,
      refresh_token_expires_in: 604800,
      scope: 'offline_access im:message:readonly im:message',
      token_type: 'Bearer',
      ...changes,
    }),
  )
}

function randomSource() {
  /** @type {Uint8Array[]} */
  const values = []
  let call = 0
  return {
    values,
    /** @param {number} length */
    randomBytes(length) {
      assert.equal(length, FEISHU_OAUTH_PKCE_RANDOM_BYTES)
      const value = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) value[index] = call * 32 + index
      call += 1
      values.push(value)
      return value
    },
  }
}

/** @param {Record<string, unknown>} [changes] */
function input(changes = {}) {
  return {
    clientId: CLIENT_ID,
    clientSecret: bytes(PRIVATE_CLIENT_SECRET),
    redirectUri: REDIRECT_URI,
    scopes: ['offline_access', 'im:message', 'im:message:readonly'],
    ...changes,
  }
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

test('authorization flow builds an exact state-bound S256 request and one-use v3 exchange', async () => {
  const random = randomSource()
  const upstream = responseBody()
  const source = input()
  /** @type {Uint8Array | undefined} */
  let requestBody
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuOAuthV3TokenSet | undefined} */
  let observedTokenSet
  let sends = 0
  const flow = new FeishuOAuthAuthorizationFlow({
    now: () => NOW,
    randomBytes: random.randomBytes,
    transport: {
      async send(request, signal) {
        sends += 1
        signal.throwIfAborted()
        assert.equal(request.method, 'POST')
        assert.equal(request.url, FEISHU_OAUTH_V3_TOKEN_URL)
        assert.deepEqual(request.headers, {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        })
        assert.equal(request.maximumResponseBytes, FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES)
        assert.equal(Object.isFrozen(request), true)
        requestBody = request.body
        const form = new URLSearchParams(Buffer.from(request.body).toString('utf8'))
        assert.deepEqual(
          [...form.keys()],
          ['grant_type', 'client_id', 'client_secret', 'code', 'redirect_uri', 'code_verifier'],
        )
        assert.equal(form.get('grant_type'), 'authorization_code')
        assert.equal(form.get('client_id'), CLIENT_ID)
        assert.equal(form.get('client_secret'), PRIVATE_CLIENT_SECRET)
        assert.equal(form.get('code'), 'synthetic_authorization_code')
        assert.equal(form.get('redirect_uri'), REDIRECT_URI)
        assert.equal(
          form.get('code_verifier'),
          Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 32)).toString(
            'base64url',
          ),
        )
        return { status: 200, body: upstream }
      },
    },
  })

  const session = flow.start(source)
  const authorization = new URL(session.authorizationUrl)
  assert.equal(authorization.origin + authorization.pathname, FEISHU_OAUTH_AUTHORIZE_URL)
  assert.equal(authorization.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(authorization.searchParams.get('response_type'), 'code')
  assert.equal(authorization.searchParams.get('redirect_uri'), REDIRECT_URI)
  assert.equal(
    authorization.searchParams.get('scope'),
    'im:message im:message:readonly offline_access',
  )
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorization.searchParams.get('prompt'), 'consent')
  assert.match(authorization.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.match(authorization.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.ok(random.values.every(zeroed))
  assert.equal(
    Buffer.from(source.clientSecret).toString('utf8'),
    PRIVATE_CLIENT_SECRET,
    'the caller-owned secret is not modified',
  )

  const callback = new URL(REDIRECT_URI)
  callback.searchParams.set('code', 'synthetic_authorization_code')
  callback.searchParams.set('state', authorization.searchParams.get('state') ?? '')
  const result = await session.complete(
    callback.toString(),
    new AbortController().signal,
    (tokenSet) => {
      observedTokenSet = tokenSet
      assert.equal(Buffer.from(tokenSet.accessToken).toString('utf8'), PRIVATE_ACCESS_TOKEN)
      assert.equal(Buffer.from(tokenSet.refreshToken).toString('utf8'), PRIVATE_REFRESH_TOKEN)
      assert.equal(tokenSet.obtainedAt, '2026-08-28T12:00:00.000Z')
      assert.equal(tokenSet.accessTokenExpiresAt, '2026-08-28T14:00:00.000Z')
      assert.equal(tokenSet.refreshTokenExpiresAt, '2026-09-04T12:00:00.000Z')
      assert.deepEqual(tokenSet.scopes, ['im:message', 'im:message:readonly', 'offline_access'])
      return 'exchanged'
    },
  )
  assert.equal(result, 'exchanged')
  assert.equal(sends, 1)
  assert.ok(requestBody !== undefined && zeroed(requestBody))
  assert.ok(zeroed(upstream))
  assert.ok(observedTokenSet !== undefined && zeroed(observedTokenSet.accessToken))
  assert.ok(observedTokenSet !== undefined && zeroed(observedTokenSet.refreshToken))

  await assert.rejects(
    session.complete(callback.toString(), new AbortController().signal, () => undefined),
    (error) =>
      error instanceof FeishuOAuthAuthorizationError &&
      error.code === 'authorization_consumed' &&
      error.retryDisposition === 'reauthorize',
  )
  assert.equal(sends, 1)
})

test('a wrong state neither invokes the transport nor consumes the valid transaction', async () => {
  const random = randomSource()
  const response = responseBody()
  let sends = 0
  const session = new FeishuOAuthAuthorizationFlow({
    randomBytes: random.randomBytes,
    transport: {
      async send() {
        sends += 1
        return { status: 200, body: response }
      },
    },
  }).start(input())
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  await assert.rejects(
    session.complete(
      `${REDIRECT_URI}?code=synthetic_code&state=${'A'.repeat(43)}`,
      new AbortController().signal,
      () => undefined,
    ),
    (error) => error instanceof FeishuOAuthAuthorizationError && error.code === 'state_mismatch',
  )
  assert.equal(sends, 0)

  await session.complete(
    `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
    new AbortController().signal,
    () => undefined,
  )
  assert.equal(sends, 1)
  assert.ok(zeroed(response))
})

test('denial and cancellation consume or close the in-memory transaction without exchange', async () => {
  for (const mode of ['denied', 'cancelled']) {
    const random = randomSource()
    let sends = 0
    const session = new FeishuOAuthAuthorizationFlow({
      randomBytes: random.randomBytes,
      transport: {
        async send() {
          sends += 1
          return { status: 200, body: responseBody() }
        },
      },
    }).start(input())
    const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
    if (mode === 'denied') {
      await assert.rejects(
        session.complete(
          `${REDIRECT_URI}?error=access_denied&state=${state}`,
          new AbortController().signal,
          () => undefined,
        ),
        (error) =>
          error instanceof FeishuOAuthAuthorizationError &&
          error.code === 'authorization_denied' &&
          error.retryDisposition === 'do_not_retry',
      )
    } else {
      session.cancel()
    }
    await assert.rejects(
      session.complete(
        `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
        new AbortController().signal,
        () => undefined,
      ),
      (error) =>
        error instanceof FeishuOAuthAuthorizationError && error.code === 'authorization_consumed',
    )
    assert.equal(sends, 0)
  }
})

test('concurrent callback completion reserves the one-use code before transport settles', async () => {
  const random = randomSource()
  const response = responseBody()
  /** @type {(() => void) | undefined} */
  let release
  /** @type {(() => void) | undefined} */
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = () => resolve(undefined)
  })
  const session = new FeishuOAuthAuthorizationFlow({
    randomBytes: random.randomBytes,
    transport: {
      send: async () => {
        markStarted?.()
        await new Promise((resolve) => {
          release = () => resolve(undefined)
        })
        return { status: 200, body: response }
      },
    },
  }).start(input())
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  const callback = `${REDIRECT_URI}?code=synthetic_code&state=${state}`
  const first = session.complete(callback, new AbortController().signal, () => 'first')
  await started
  await assert.rejects(
    session.complete(callback, new AbortController().signal, () => 'second'),
    (error) =>
      error instanceof FeishuOAuthAuthorizationError && error.code === 'authorization_consumed',
  )
  assert.ok(release !== undefined)
  release()
  assert.equal(await first, 'first')
  assert.ok(zeroed(response))
})

test('every post-start transport ambiguity requires a fresh authorization and cannot replay', async () => {
  for (const failure of [
    async () => Promise.reject(new Error(PRIVATE_ACCESS_TOKEN)),
    async () => ({ status: 503, body: bytes(PRIVATE_ACCESS_TOKEN) }),
    async () => ({ status: 429, body: new Uint8Array() }),
  ]) {
    const random = randomSource()
    let sends = 0
    const session = new FeishuOAuthAuthorizationFlow({
      randomBytes: random.randomBytes,
      transport: {
        async send() {
          sends += 1
          return failure()
        },
      },
    }).start(input())
    const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
    const callback = `${REDIRECT_URI}?code=synthetic_single_use_code&state=${state}`
    await assert.rejects(
      session.complete(callback, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthAuthorizationError &&
        error.code === 'exchange_uncertain' &&
        error.retryDisposition === 'reauthorize' &&
        !error.message.includes(PRIVATE_ACCESS_TOKEN),
    )
    await assert.rejects(
      session.complete(callback, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuOAuthAuthorizationError && error.code === 'authorization_consumed',
    )
    assert.equal(sends, 1)
  }
})

test('expired, used, mismatched, and PKCE-failed codes require reauthorization', async () => {
  for (const upstreamCode of [20003, 20004, 20024, 20049, 20065, 20071]) {
    const random = randomSource()
    const body = bytes(
      JSON.stringify({
        code: upstreamCode,
        error: 'synthetic-private-error',
        error_description: PRIVATE_CLIENT_SECRET,
      }),
    )
    const session = new FeishuOAuthAuthorizationFlow({
      randomBytes: random.randomBytes,
      transport: { send: async () => ({ status: 400, body }) },
    }).start(input())
    const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
    await assert.rejects(
      session.complete(
        `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
        new AbortController().signal,
        () => undefined,
      ),
      (error) =>
        error instanceof FeishuOAuthAuthorizationError &&
        error.code === 'reauthorization_required' &&
        error.retryDisposition === 'reauthorize' &&
        !error.message.includes(PRIVATE_CLIENT_SECRET),
    )
    assert.ok(zeroed(body))
  }
})

test('application errors require repair while a bad post-response clock requires reauthorization', async () => {
  for (const [
    body,
    now,
    expectedCode,
    expectedDisposition,
  ] of /** @type {Array<[Uint8Array, () => number, import('../packages/plugin-feishu/dist/index.js').FeishuOAuthAuthorizationErrorCode, import('../packages/plugin-feishu/dist/index.js').FeishuOAuthAuthorizationRetryDisposition]>} */ ([
    [
      bytes(
        JSON.stringify({
          code: 20002,
          error: 'invalid_client',
          error_description: PRIVATE_CLIENT_SECRET,
        }),
      ),
      () => NOW,
      'configuration_invalid',
      'do_not_retry',
    ],
    [responseBody(), () => Number.NaN, 'exchange_uncertain', 'reauthorize'],
  ])) {
    const random = randomSource()
    const session = new FeishuOAuthAuthorizationFlow({
      now,
      randomBytes: random.randomBytes,
      transport: { send: async () => ({ status: 200, body }) },
    }).start(input())
    const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
    await assert.rejects(
      session.complete(
        `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
        new AbortController().signal,
        () => undefined,
      ),
      (error) =>
        error instanceof FeishuOAuthAuthorizationError &&
        error.code === expectedCode &&
        error.retryDisposition === expectedDisposition &&
        !error.message.includes(PRIVATE_CLIENT_SECRET),
    )
    assert.ok(zeroed(body))
  }
})

test('invalid redirects, scopes, callbacks, options, and hostile inputs fail closed', async () => {
  let sends = 0
  const transport = {
    async send() {
      sends += 1
      return { status: 200, body: responseBody() }
    },
  }
  for (const invalid of [
    input({ redirectUri: 'http://example.com/callback' }),
    input({ redirectUri: 'http://localhost:43119/callback' }),
    input({ redirectUri: `${REDIRECT_URI}?private=value` }),
    input({ scopes: ['im:message'] }),
    input({ scopes: ['offline_access', 'offline_access'] }),
    input({ clientSecret: new Uint8Array(new SharedArrayBuffer(32)) }),
    { ...input(), unknown: PRIVATE_CLIENT_SECRET },
  ]) {
    assert.throws(
      () => new FeishuOAuthAuthorizationFlow({ transport }).start(/** @type {never} */ (invalid)),
      (error) => error instanceof FeishuOAuthAuthorizationError && error.code === 'invalid_request',
    )
  }
  assert.equal(sends, 0)

  let accessed = false
  const hostile = Object.defineProperty(input(), 'clientSecret', {
    enumerable: true,
    get() {
      accessed = true
      return bytes(PRIVATE_CLIENT_SECRET)
    },
  })
  assert.throws(
    () => new FeishuOAuthAuthorizationFlow({ transport }).start(/** @type {never} */ (hostile)),
    (error) => error instanceof FeishuOAuthAuthorizationError && error.code === 'invalid_request',
  )
  assert.equal(accessed, false)

  const random = randomSource()
  const session = new FeishuOAuthAuthorizationFlow({
    randomBytes: random.randomBytes,
    transport,
  }).start(input())
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  for (const callback of [
    `http://127.0.0.1:43120/oauth/feishu/callback?code=a&state=${state}`,
    `${REDIRECT_URI}?code=a&code=b&state=${state}`,
    `${REDIRECT_URI}?code=a&state=${state}&private=value`,
    `${REDIRECT_URI}?error=other&state=${state}`,
  ]) {
    await assert.rejects(
      session.complete(callback, new AbortController().signal, () => undefined),
      (error) => error instanceof FeishuOAuthAuthorizationError && error.code === 'invalid_request',
    )
  }
  assert.equal(sends, 0)
  session.cancel()

  assert.throws(
    () =>
      new FeishuOAuthAuthorizationFlow(
        /** @type {never} */ ({ transport, randomBytes: () => new Uint8Array(31) }),
      ).start(input()),
    (error) => error instanceof FeishuOAuthAuthorizationError && error.code === 'invalid_flow',
  )
})

test('a completed consumer stays authoritative when cancellation arrives during persistence', async () => {
  const random = randomSource()
  const controller = new AbortController()
  const session = new FeishuOAuthAuthorizationFlow({
    randomBytes: random.randomBytes,
    transport: { send: async () => ({ status: 200, body: responseBody() }) },
  }).start(input())
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  const result = await session.complete(
    `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
    controller.signal,
    () => {
      controller.abort()
      return 'persisted'
    },
  )
  assert.equal(result, 'persisted')
})

test('hostile typed-array iterators and fill overrides are never invoked at secret boundaries', async () => {
  const random = randomSource()
  let iterated = false
  const clientSecret = bytes(PRIVATE_CLIENT_SECRET)
  Object.defineProperty(clientSecret, Symbol.iterator, {
    value() {
      iterated = true
      throw new Error(PRIVATE_CLIENT_SECRET)
    },
  })

  let fillInvoked = false
  const body = responseBody()
  Object.defineProperty(body, 'fill', {
    value() {
      fillInvoked = true
      throw new Error(PRIVATE_ACCESS_TOKEN)
    },
  })
  const session = new FeishuOAuthAuthorizationFlow({
    randomBytes: random.randomBytes,
    transport: { send: async () => ({ status: 200, body }) },
  }).start(input({ clientSecret }))
  const state = new URL(session.authorizationUrl).searchParams.get('state') ?? ''
  await session.complete(
    `${REDIRECT_URI}?code=synthetic_code&state=${state}`,
    new AbortController().signal,
    () => undefined,
  )

  assert.equal(iterated, false)
  assert.equal(fillInvoked, false)
  assert.ok(Uint8Array.prototype.every.call(body, (byte) => byte === 0))
})
