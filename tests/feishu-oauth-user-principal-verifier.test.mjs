import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_OAUTH_TOKEN_MAX_LENGTH,
  FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_USER_INFO_URL,
  FeishuOAuthUserPrincipalVerificationError,
  FeishuOAuthUserPrincipalVerifier,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_principal_verifier'
const PRINCIPAL_ID = 'ou_synthetic_principal_verifier'
const OTHER_PRINCIPAL_ID = 'ou_synthetic_other_principal'
const PRIVATE_ACCESS_TOKEN = 'synthetic-private-principal-access-token'

function configuration(options = {}) {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-principal-verifier',
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Principal Verifier User',
      principalId: PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-principal-verifier',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
    ...options,
  }
}

function token() {
  return new Uint8Array(Buffer.from(PRIVATE_ACCESS_TOKEN, 'utf8'))
}

/** @param {Uint8Array} value */
function zeroed(value) {
  return value.every((byte) => byte === 0)
}

test('the exact configured open_id gates token consumption and clears the client copy', async () => {
  const source = token()
  let observedToken
  let observedRequest
  const verifier = new FeishuOAuthUserPrincipalVerifier({
    client: {
      async get(request, signal) {
        signal.throwIfAborted()
        observedRequest = request
        observedToken = request.accessToken
        assert.notEqual(request.accessToken, source)
        assert.equal(Buffer.from(request.accessToken).toString('utf8'), PRIVATE_ACCESS_TOKEN)
        return { openId: PRINCIPAL_ID }
      },
    },
  })
  const result = await verifier.withVerifiedPrincipal(
    configuration(),
    source,
    new AbortController().signal,
    () => 'verified',
  )
  assert.equal(result, 'verified')
  assert.deepEqual(observedRequest, {
    method: 'GET',
    url: FEISHU_OAUTH_USER_INFO_URL,
    accessToken: observedToken,
    maximumResponseBytes: FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
  })
  assert.equal(Object.isFrozen(observedRequest), true)
  assert.ok(observedToken !== undefined && zeroed(observedToken))
  assert.equal(Buffer.from(source).toString('utf8'), PRIVATE_ACCESS_TOKEN)
})

test('a different or malformed principal never reaches the consumer', async () => {
  for (const response of [
    { openId: OTHER_PRINCIPAL_ID },
    { openId: '' },
    { openId: PRINCIPAL_ID, name: 'private-display-name' },
  ]) {
    const source = token()
    let observedToken
    let used = false
    await assert.rejects(
      new FeishuOAuthUserPrincipalVerifier({
        client: {
          async get(request) {
            observedToken = request.accessToken
            return response
          },
        },
      }).withVerifiedPrincipal(configuration(), source, new AbortController().signal, () => {
        used = true
      }),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        (error.code === 'identity_mismatch' || error.code === 'invalid_response') &&
        !error.message.includes(OTHER_PRINCIPAL_ID) &&
        !error.message.includes('private-display-name'),
    )
    assert.equal(used, false)
    assert.ok(observedToken !== undefined && zeroed(observedToken))
  }
})

test('invalid inputs and hostile client data fail before secret use or without disclosure', async () => {
  let calls = 0
  const verifier = new FeishuOAuthUserPrincipalVerifier({
    client: {
      async get() {
        calls += 1
        return { openId: PRINCIPAL_ID }
      },
    },
  })
  for (const [
    configured,
    accessToken,
    consumer,
  ] of /** @type {Array<[unknown, unknown, unknown]>} */ ([
    [configuration({ user: undefined }), token(), () => undefined],
    [configuration(), new Uint8Array(), () => undefined],
    [configuration(), new Uint8Array(new SharedArrayBuffer(32)), () => undefined],
    [configuration(), new Uint8Array(FEISHU_OAUTH_TOKEN_MAX_LENGTH + 1), () => undefined],
    [configuration(), token(), null],
  ])) {
    await assert.rejects(
      verifier.withVerifiedPrincipal(
        /** @type {never} */ (configured),
        /** @type {never} */ (accessToken),
        new AbortController().signal,
        /** @type {never} */ (consumer),
      ),
      (error) =>
        error instanceof FeishuOAuthUserPrincipalVerificationError &&
        error.code === 'invalid_request',
    )
  }
  assert.equal(calls, 0)

  let responseAccessed = false
  const hostileResponse = Object.defineProperty({}, 'openId', {
    enumerable: true,
    get() {
      responseAccessed = true
      return OTHER_PRINCIPAL_ID
    },
  })
  await assert.rejects(
    new FeishuOAuthUserPrincipalVerifier({
      client: { get: async () => /** @type {never} */ (hostileResponse) },
    }).withVerifiedPrincipal(
      configuration(),
      token(),
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_response',
  )
  assert.equal(responseAccessed, false)
})

test('client failure and cancellation stay payload-free and clear transient token bytes', async () => {
  const source = token()
  let observedToken
  await assert.rejects(
    new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get(request) {
          observedToken = request.accessToken
          throw new Error(PRIVATE_ACCESS_TOKEN)
        },
      },
    }).withVerifiedPrincipal(
      configuration(),
      source,
      new AbortController().signal,
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'unavailable' &&
      !error.message.includes(PRIVATE_ACCESS_TOKEN),
  )
  assert.ok(observedToken !== undefined && zeroed(observedToken))

  const controller = new AbortController()
  let cancelledToken
  await assert.rejects(
    new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get(request) {
          cancelledToken = request.accessToken
          controller.abort()
          return { openId: PRINCIPAL_ID }
        },
      },
    }).withVerifiedPrincipal(configuration(), token(), controller.signal, () => undefined),
    { name: 'AbortError' },
  )
  assert.ok(cancelledToken !== undefined && zeroed(cancelledToken))

  let consumerToken
  await assert.rejects(
    new FeishuOAuthUserPrincipalVerifier({
      client: {
        async get(request) {
          consumerToken = request.accessToken
          return { openId: PRINCIPAL_ID }
        },
      },
    }).withVerifiedPrincipal(configuration(), token(), new AbortController().signal, () => {
      throw new Error('synthetic consumer failure')
    }),
    /synthetic consumer failure/u,
  )
  assert.ok(consumerToken !== undefined && zeroed(consumerToken))
})

test('a completed verified consumer remains authoritative if cancellation arrives during it', async () => {
  const controller = new AbortController()
  let observedToken
  const result = await new FeishuOAuthUserPrincipalVerifier({
    client: {
      async get(request) {
        observedToken = request.accessToken
        return { openId: PRINCIPAL_ID }
      },
    },
  }).withVerifiedPrincipal(configuration(), token(), controller.signal, () => {
    controller.abort()
    return 'persisted'
  })

  assert.equal(result, 'persisted')
  assert.ok(observedToken !== undefined && zeroed(observedToken))
})

test('verifier options reject unknown fields and accessors without evaluating them', () => {
  assert.throws(
    () =>
      new FeishuOAuthUserPrincipalVerifier(
        /** @type {never} */ ({
          client: { get: async () => ({ openId: PRINCIPAL_ID }) },
          unknown: PRIVATE_ACCESS_TOKEN,
        }),
      ),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError &&
      error.code === 'invalid_client' &&
      !error.message.includes(PRIVATE_ACCESS_TOKEN),
  )

  let accessed = false
  const hostile = Object.defineProperty({}, 'client', {
    enumerable: true,
    get() {
      accessed = true
      return { get: async () => ({ openId: PRINCIPAL_ID }) }
    },
  })
  assert.throws(
    () => new FeishuOAuthUserPrincipalVerifier(/** @type {never} */ (hostile)),
    (error) =>
      error instanceof FeishuOAuthUserPrincipalVerificationError && error.code === 'invalid_client',
  )
  assert.equal(accessed, false)
})
