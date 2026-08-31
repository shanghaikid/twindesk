import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthLoopbackCallbackError,
  FeishuOAuthLoopbackCallbackHost,
} from '../packages/plugin-feishu/dist/index.js'

/** @param {string} redirectUri */
function flow(redirectUri) {
  let randomCall = 0
  const authorization = new FeishuOAuthAuthorizationFlow({
    transport: {
      async send() {
        assert.fail('The callback listener must not exchange the code.')
      },
    },
    randomBytes(length) {
      randomCall += 1
      return new Uint8Array(length).fill(randomCall)
    },
  }).start({
    clientId: 'cli_synthetic_loopback',
    clientSecret: new TextEncoder().encode('synthetic-private-loopback-secret'),
    redirectUri,
    scopes: ['offline_access'],
  })
  return authorization
}

test('loopback host captures one exact state-bound callback without exchanging it', async () => {
  const listener = await new FeishuOAuthLoopbackCallbackHost({ timeoutMs: 2_000 }).listen(
    new AbortController().signal,
  )
  const authorization = flow(listener.redirectUri)
  const authorizationUrl = new URL(authorization.authorizationUrl)
  const state = authorizationUrl.searchParams.get('state')
  assert.ok(state !== null)
  const callback = listener.wait(authorization.authorizationUrl, new AbortController().signal)

  const wrong = await fetch(`${listener.redirectUri}?code=wrong&state=${'A'.repeat(43)}`)
  assert.equal(wrong.status, 404)
  assert.equal(wrong.headers.get('cache-control'), 'no-store')

  const response = await fetch(`${listener.redirectUri}?code=synthetic_code&state=${state}`)
  assert.equal(response.status, 200)
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; frame-ancestors 'none'",
  )
  const responseText = await response.text()
  assert.equal(responseText.includes('synthetic_code'), false)
  assert.equal(responseText.includes(state), false)
  assert.equal(await callback, `${listener.redirectUri}?code=synthetic_code&state=${state}`)
  const releasedPort = Number(new URL(listener.redirectUri).port)
  const restarted = await new FeishuOAuthLoopbackCallbackHost({ port: releasedPort }).listen(
    new AbortController().signal,
  )
  await restarted.close()
  authorization.cancel()
  await listener.close()
})

test('loopback host ignores malformed requests and accepts exact denial', async () => {
  const listener = await new FeishuOAuthLoopbackCallbackHost({ timeoutMs: 2_000 }).listen(
    new AbortController().signal,
  )
  const authorization = flow(listener.redirectUri)
  const state = new URL(authorization.authorizationUrl).searchParams.get('state')
  assert.ok(state !== null)
  const callback = listener.wait(authorization.authorizationUrl, new AbortController().signal)

  for (const request of [
    new Request(`${listener.redirectUri}?code=x&state=${state}&extra=x`),
    new Request(`${listener.redirectUri}?code=x&state=${state}`, { method: 'POST' }),
    new Request(`${listener.redirectUri}/other?code=x&state=${state}`),
  ]) {
    assert.equal((await fetch(request)).status, 404)
  }
  const denied = `${listener.redirectUri}?error=access_denied&state=${state}`
  assert.equal((await fetch(denied)).status, 200)
  assert.equal(await callback, denied)
  authorization.cancel()
})

test('loopback listener cancellation, timeout, and manual close settle without callbacks', async () => {
  const cancelledController = new AbortController()
  cancelledController.abort()
  await assert.rejects(
    new FeishuOAuthLoopbackCallbackHost().listen(cancelledController.signal),
    (error) => error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'cancelled',
  )

  const timed = await new FeishuOAuthLoopbackCallbackHost({ timeoutMs: 10 }).listen(
    new AbortController().signal,
  )
  const timedAuthorization = flow(timed.redirectUri)
  await assert.rejects(
    timed.wait(timedAuthorization.authorizationUrl, new AbortController().signal),
    (error) => error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'timeout',
  )
  timedAuthorization.cancel()

  const closed = await new FeishuOAuthLoopbackCallbackHost({ timeoutMs: 2_000 }).listen(
    new AbortController().signal,
  )
  const closedAuthorization = flow(closed.redirectUri)
  const pending = closed.wait(closedAuthorization.authorizationUrl, new AbortController().signal)
  const releasedPort = Number(new URL(closed.redirectUri).port)
  const firstClose = closed.close()
  await closed.close()
  await firstClose
  await assert.rejects(
    pending,
    (error) => error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'cancelled',
  )
  const restarted = await new FeishuOAuthLoopbackCallbackHost({ port: releasedPort }).listen(
    new AbortController().signal,
  )
  await restarted.close()
  closedAuthorization.cancel()
})

test('loopback host rejects hostile configuration and mismatched authorization URLs', async () => {
  let accessorCalls = 0
  const hostile = Object.defineProperty({}, 'host', {
    get() {
      accessorCalls += 1
      return '127.0.0.1'
    },
  })
  assert.throws(
    () => new FeishuOAuthLoopbackCallbackHost(hostile),
    (error) =>
      error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'invalid_request',
  )
  assert.equal(accessorCalls, 0)

  const listener = await new FeishuOAuthLoopbackCallbackHost().listen(new AbortController().signal)
  const authorization = flow(listener.redirectUri)
  const mismatched = new URL(authorization.authorizationUrl)
  mismatched.searchParams.set('redirect_uri', 'http://127.0.0.1:1/wrong')
  assert.throws(
    () => listener.wait(mismatched.toString(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'invalid_request',
  )
  const extra = new URL(authorization.authorizationUrl)
  extra.searchParams.set('extra', 'synthetic')
  assert.throws(
    () => listener.wait(extra.toString(), new AbortController().signal),
    (error) =>
      error instanceof FeishuOAuthLoopbackCallbackError && error.code === 'invalid_request',
  )
  authorization.cancel()
  await listener.close()
})
