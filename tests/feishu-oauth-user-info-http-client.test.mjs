import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_OAUTH_TOKEN_MAX_LENGTH,
  FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_USER_INFO_URL,
  FeishuOAuthUserInfoHttpClient,
  FeishuOAuthUserPrincipalVerificationError,
  FeishuOAuthUserPrincipalVerifier,
} from '../packages/plugin-feishu/dist/index.js'

const ACCESS_TOKEN = 'u-synthetic-private-user-info-token'
const PRINCIPAL_ID = 'ou_synthetic_user_info_principal'
const PRIVATE_PROFILE = 'synthetic-private-profile-value'

/** @param {string} value */
function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

/** @param {Uint8Array} accessToken */
function request(accessToken) {
  return Object.freeze({
    method: 'GET',
    url: FEISHU_OAUTH_USER_INFO_URL,
    accessToken,
    maximumResponseBytes: FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
  })
}

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-user-info',
    appId: 'cli_synthetic_user_info',
    user: {
      identityType: 'user',
      displayName: 'Synthetic User Info Principal',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-user-info',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {number} code */
function errorResponse(code) {
  return new Response(JSON.stringify({ code, msg: PRIVATE_PROFILE }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('production user-info client fixes the request and returns only open_id', async () => {
  const payload = JSON.stringify({
    code: 0,
    msg: 'success',
    data: {
      name: PRIVATE_PROFILE,
      email: `${PRIVATE_PROFILE}@invalid.example`,
      mobile: PRIVATE_PROFILE,
      tenant_key: PRIVATE_PROFILE,
      open_id: PRINCIPAL_ID,
    },
  })
  const first = bytes(payload.slice(0, 31))
  const second = bytes(payload.slice(31))
  /** @type {RequestInit | undefined} */
  let observedInit
  const client = new FeishuOAuthUserInfoHttpClient({
    fetch: async (url, init) => {
      assert.equal(url, FEISHU_OAUTH_USER_INFO_URL)
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
  const accessToken = bytes(ACCESS_TOKEN)
  const result = await client.get(request(accessToken), new AbortController().signal)

  assert.deepEqual(result, { openId: PRINCIPAL_ID })
  assert.equal(Object.isFrozen(result), true)
  assert.ok(observedInit !== undefined)
  assert.equal(observedInit.method, 'GET')
  assert.equal(observedInit.body, undefined)
  assert.equal(observedInit.cache, 'no-store')
  assert.equal(observedInit.credentials, 'omit')
  assert.equal(observedInit.redirect, 'error')
  assert.equal(observedInit.referrerPolicy, 'no-referrer')
  const headers = new Headers(observedInit.headers)
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(headers.get('authorization'), `Bearer ${ACCESS_TOKEN}`)
  assert.ok(observedInit.signal instanceof AbortSignal)
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
  assert.equal(zeroed(accessToken), false)
  assert.equal(JSON.stringify(result).includes(PRIVATE_PROFILE), false)
  accessToken.fill(0)
})

test('production client composes with exact principal verification and transient zeroing', async () => {
  /** @type {Uint8Array | undefined} */
  let clientToken
  const client = new FeishuOAuthUserInfoHttpClient({
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${ACCESS_TOKEN}`)
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { open_id: PRINCIPAL_ID, name: PRIVATE_PROFILE },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const verifier = new FeishuOAuthUserPrincipalVerifier({
    client: {
      async get(clientRequest, signal) {
        clientToken = clientRequest.accessToken
        return client.get(clientRequest, signal)
      },
    },
  })
  const source = bytes(ACCESS_TOKEN)
  const result = await verifier.withVerifiedPrincipal(
    configuration(),
    source,
    new AbortController().signal,
    () => 'verified',
  )

  assert.equal(result, 'verified')
  assert.ok(clientToken !== undefined && zeroed(clientToken))
  assert.equal(Buffer.from(source).toString('utf8'), ACCESS_TOKEN)
  source.fill(0)
})

test('declared and streamed response overflow cancel and clear response bytes', async () => {
  let declaredCancelled = false
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              declaredCancelled = true
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES + 1),
              'content-type': 'application/json',
            },
          },
        ),
    }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_response' &&
      error.retryDisposition === 'do_not_retry',
  )
  assert.equal(declaredCancelled, true)

  const first = new Uint8Array(10_000).fill(7)
  const second = new Uint8Array(10_000).fill(9)
  let streamCancelled = false
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(first)
              controller.enqueue(second)
            },
            cancel() {
              streamCancelled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_response',
  )
  assert.equal(streamCancelled, true)
  assert.ok(zeroed(first))
  assert.ok(zeroed(second))
})

test('redirect, media, encoding, shape, and duplicate failures disclose no profile data', async () => {
  const cases = [
    new Response(JSON.stringify({ code: 0, msg: 'success', data: { open_id: PRINCIPAL_ID } }), {
      status: 302,
      headers: { 'content-type': 'application/json', location: 'https://synthetic.invalid' },
    }),
    new Response(PRIVATE_PROFILE, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
    new Response(new Uint8Array([0xff, 0xfe]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{"code":0,"code":0,"msg":"success","data":{"open_id":"x"}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(
      `{"code":0,"msg":"success","data":{"open_id":"${PRINCIPAL_ID}","open_id":"${PRIVATE_PROFILE}"}}`,
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    new Response(JSON.stringify({ code: 0, msg: 'success', data: { name: PRIVATE_PROFILE } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]
  for (const response of cases) {
    await assert.rejects(
      new FeishuOAuthUserInfoHttpClient({ fetch: async () => response }).get(
        request(bytes(ACCESS_TOKEN)),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_PROFILE),
    )
    assert.equal(response.bodyUsed, true)
  }
})

test('official service failures produce explicit retry and reauthorization dispositions', async () => {
  /** @type {Array<[Response, import('../packages/plugin-feishu/dist/index.js').FeishuOAuthUserPrincipalVerificationErrorCode, import('../packages/plugin-feishu/dist/index.js').FeishuOAuthUserPrincipalVerificationRetryDisposition]>} */
  const failures = [
    [errorResponse(20005), 'reauthorization_required', 'reauthorize'],
    [errorResponse(20050), 'retry_later', 'retry_later'],
    [errorResponse(20021), 'unavailable', 'do_not_retry'],
    [new Response(null, { status: 429 }), 'retry_later', 'retry_later'],
    [new Response(null, { status: 401 }), 'reauthorization_required', 'reauthorize'],
  ]
  for (const [response, code, disposition] of failures) {
    await assert.rejects(
      new FeishuOAuthUserInfoHttpClient({ fetch: async () => response }).get(
        request(bytes(ACCESS_TOKEN)),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        error.code === code &&
        error.retryDisposition === disposition &&
        !error.message.includes(PRIVATE_PROFILE),
    )
  }
})

test('network, timeout, cancellation, options, and requests fail closed', async () => {
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({
      fetch: async () => {
        throw new Error(PRIVATE_PROFILE)
      },
    }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'retry_later' &&
      !error.message.includes(PRIVATE_PROFILE),
  )

  /** @type {typeof fetch} */
  const waitingFetch = (_url, init) =>
    /** @type {Promise<Response>} */ (
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal !== null && signal !== undefined)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    )
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({
      fetch: waitingFetch,
      timeoutMilliseconds: 5,
    }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError && error.code === 'retry_later',
  )

  const controller = new AbortController()
  const cancelled = new FeishuOAuthUserInfoHttpClient({ fetch: waitingFetch }).get(
    request(bytes(ACCESS_TOKEN)),
    controller.signal,
  )
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })

  for (const options of [
    { fetch: null },
    { fetch: undefined },
    { timeoutMilliseconds: 0 },
    { timeoutMilliseconds: undefined },
    { unknown: PRIVATE_PROFILE },
  ]) {
    assert.throws(
      () => new FeishuOAuthUserInfoHttpClient(/** @type {never} */ (options)),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        error.code === 'invalid_client' &&
        !error.message.includes(PRIVATE_PROFILE),
    )
  }

  let accessed = false
  assert.throws(
    () =>
      new FeishuOAuthUserInfoHttpClient(
        Object.defineProperty({}, 'fetch', {
          enumerable: true,
          get() {
            accessed = true
            return fetch
          },
        }),
      ),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError && error.code === 'invalid_client',
  )
  assert.equal(accessed, false)

  let responseAccessed = false
  const hostileResponse = Object.defineProperty({}, 'status', {
    enumerable: true,
    get() {
      responseAccessed = true
      return 200
    },
  })
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({
      fetch: async () => /** @type {never} */ (hostileResponse),
    }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_response',
  )
  assert.equal(responseAccessed, false)

  let overriddenResponseAccessed = false
  class OverriddenResponse extends Response {
    /** @override */
    get status() {
      overriddenResponseAccessed = true
      return super.status
    }

    /** @override */
    get headers() {
      overriddenResponseAccessed = true
      return super.headers
    }

    /** @override */
    get body() {
      overriddenResponseAccessed = true
      return super.body
    }
  }
  const overriddenResponse = new OverriddenResponse(
    JSON.stringify({ code: 0, msg: 'success', data: { open_id: PRINCIPAL_ID } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  overriddenResponseAccessed = false
  const overriddenResult = await new FeishuOAuthUserInfoHttpClient({
    fetch: async () => overriddenResponse,
  }).get(request(bytes(ACCESS_TOKEN)), new AbortController().signal)
  assert.deepEqual(overriddenResult, { openId: PRINCIPAL_ID })
  assert.equal(overriddenResponseAccessed, false)

  const lockedResponse = new Response(
    new ReadableStream({
      start(streamController) {
        streamController.enqueue(bytes('{"code":0}'))
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  lockedResponse.body?.getReader()
  await assert.rejects(
    new FeishuOAuthUserInfoHttpClient({ fetch: async () => lockedResponse }).get(
      request(bytes(ACCESS_TOKEN)),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_response',
  )

  let tokenIteratorAccessed = false
  const hostileToken = new Uint8Array([0x0a])
  Object.defineProperty(hostileToken, Symbol.iterator, {
    value() {
      tokenIteratorAccessed = true
      return Uint8Array.prototype[Symbol.iterator].call(hostileToken)
    },
  })

  const client = new FeishuOAuthUserInfoHttpClient({ fetch: async () => new Response() })
  for (const invalidRequest of [
    { ...request(bytes(ACCESS_TOKEN)), url: 'https://synthetic.invalid' },
    { ...request(bytes(ACCESS_TOKEN)), maximumResponseBytes: 1 },
    request(new Uint8Array(FEISHU_OAUTH_TOKEN_MAX_LENGTH + 1)),
    request(new Uint8Array([0x0a])),
    request(hostileToken),
    request(new Uint8Array(new SharedArrayBuffer(32))),
  ]) {
    await assert.rejects(
      client.get(/** @type {never} */ (invalidRequest), new AbortController().signal),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        error.code === 'invalid_request',
    )
  }
  assert.equal(tokenIteratorAccessed, false)
})
