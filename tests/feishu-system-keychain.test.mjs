import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
  FEISHU_SYSTEM_KEYCHAIN_SERVICE,
  FeishuSystemKeychainError,
  FeishuSystemKeychainSecretResolver,
} from '../packages/plugin-feishu/dist/index.js'

const PRIVATE_VALUE = 'synthetic-keychain-private-value'
const REFERENCE_ID = 'secret-ref:synthetic-feishu-keychain'

function reference(purpose = 'connector_oauth', store = 'system_keychain') {
  return {
    kind: 'secret_reference',
    schemaVersion: 1,
    id: REFERENCE_ID,
    store,
    purpose,
  }
}

test('the macOS resolver uses one exact generic-password lookup and zeroes the secret', async () => {
  const secret = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  /** @type {import('../packages/plugin-feishu/src/system-keychain.ts').FeishuKeychainCommandRequest | undefined} */
  let observedRequest
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run(request, signal) {
        signal.throwIfAborted()
        observedRequest = request
        return secret
      },
    },
  })
  let callbackSecret
  const result = await resolver.withSecret(reference(), new AbortController().signal, (value) => {
    callbackSecret = value
    assert.equal(Buffer.from(value).toString('utf8'), PRIVATE_VALUE)
    return 'synthetic-result'
  })
  assert.equal(result, 'synthetic-result')
  assert.equal(callbackSecret, secret)
  assert.ok(secret.every((value) => value === 0))
  assert.deepEqual(observedRequest, {
    executable: '/usr/bin/security',
    arguments: [
      'find-generic-password',
      '-s',
      FEISHU_SYSTEM_KEYCHAIN_SERVICE,
      '-a',
      REFERENCE_ID,
      '-w',
    ],
    maximumOutputBytes: FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
  })
  assert.equal(Object.isFrozen(observedRequest), true)
  assert.equal(Object.isFrozen(observedRequest?.arguments), true)
})

test('invalid references, stores, purposes, and platforms fail before Keychain access', async () => {
  let calls = 0
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        calls += 1
        return new Uint8Array([1])
      },
    },
  })
  const cases = [
    { value: { ...reference(), id: PRIVATE_VALUE }, code: 'invalid_reference' },
    { value: reference('connector_oauth', 'encrypted_secret_store'), code: 'unsupported_store' },
    { value: reference('model_api_key'), code: 'unsupported_purpose' },
  ]
  for (const item of cases) {
    await assert.rejects(
      resolver.withSecret(item.value, new AbortController().signal, () => undefined),
      (error) =>
        error instanceof FeishuSystemKeychainError &&
        error.code === item.code &&
        !error.message.includes(PRIVATE_VALUE) &&
        !error.message.includes(REFERENCE_ID),
    )
  }
  await assert.rejects(
    resolver.withSecret(
      reference(),
      new AbortController().signal,
      /** @type {(secret: Uint8Array) => void} */ (/** @type {unknown} */ (null)),
    ),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'invalid_consumer',
  )
  const unsupported = new FeishuSystemKeychainSecretResolver({
    platform: 'linux',
    runner: {
      async run() {
        calls += 1
        return new Uint8Array([1])
      },
    },
  })
  await assert.rejects(
    unsupported.withSecret(reference(), new AbortController().signal, () => undefined),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unsupported_platform',
  )
  assert.equal(calls, 0)
})

test('lookup failures and invalid secret sizes are bounded and payload-free', async () => {
  const privateFailure = Object.assign(new Error(PRIVATE_VALUE), { code: 44 })
  const missing = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: { run: async () => Promise.reject(privateFailure) },
  })
  await assert.rejects(
    missing.withSecret(reference(), new AbortController().signal, () => undefined),
    (error) =>
      error instanceof FeishuSystemKeychainError &&
      error.code === 'not_found' &&
      !error.message.includes(PRIVATE_VALUE) &&
      !error.message.includes(REFERENCE_ID),
  )

  let accessed = false
  const hostileFailure = Object.defineProperty({}, 'code', {
    get() {
      accessed = true
      return 44
    },
  })
  await assert.rejects(
    new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => Promise.reject(hostileFailure) },
    }).withSecret(reference(), new AbortController().signal, () => undefined),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unavailable',
  )
  assert.equal(accessed, false)

  for (const secret of [
    new Uint8Array(),
    new Uint8Array(FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES + 1).fill(7),
  ]) {
    let used = false
    const resolver = new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => secret },
    })
    await assert.rejects(
      resolver.withSecret(reference(), new AbortController().signal, () => {
        used = true
      }),
      (error) =>
        error instanceof FeishuSystemKeychainError &&
        (error.code === 'secret_empty' || error.code === 'secret_too_large'),
    )
    assert.equal(used, false)
    assert.ok(secret.every((value) => value === 0))
  }
})

test('cancellation and consumer failure still zero resolved bytes', async () => {
  let calls = 0
  const preCancelled = new AbortController()
  preCancelled.abort()
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        calls += 1
        return new Uint8Array([1])
      },
    },
  })
  await assert.rejects(
    resolver.withSecret(reference(), preCancelled.signal, () => undefined),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(calls, 0)

  const postLookupSecret = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  const postLookupCancelled = new AbortController()
  await assert.rejects(
    new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: {
        async run() {
          postLookupCancelled.abort()
          return postLookupSecret
        },
      },
    }).withSecret(reference(), postLookupCancelled.signal, () => undefined),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.ok(postLookupSecret.every((value) => value === 0))

  const secret = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  const failure = new Error('synthetic-consumer-failure')
  await assert.rejects(
    new FeishuSystemKeychainSecretResolver({
      platform: 'darwin',
      runner: { run: async () => secret },
    }).withSecret(reference(), new AbortController().signal, () => {
      throw failure
    }),
    (error) => error === failure,
  )
  assert.ok(secret.every((value) => value === 0))
})
