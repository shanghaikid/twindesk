import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
  FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
  FEISHU_SYSTEM_KEYCHAIN_SERVICE,
  FeishuSystemKeychainError,
  FeishuSystemKeychainSecretReplacer,
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

test('the macOS replacer uses one exact stdin-only atomic update and clears the bundle', async () => {
  const replacement = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuKeychainReplaceCommandRequest | undefined} */
  let observedRequest
  /** @type {Uint8Array | undefined} */
  let observedSecret
  const replacer = new FeishuSystemKeychainSecretReplacer({
    platform: 'darwin',
    runner: {
      async replace(request, secret, signal) {
        signal.throwIfAborted()
        observedRequest = request
        observedSecret = secret
        assert.equal(Buffer.from(secret).toString('utf8'), PRIVATE_VALUE)
      },
    },
  })
  await replacer.replace(reference('connector_oauth'), replacement, new AbortController().signal)
  assert.equal(observedSecret, replacement)
  assert.ok(replacement.every((value) => value === 0))
  assert.deepEqual(observedRequest, {
    executable: '/usr/bin/security',
    arguments: [
      'add-generic-password',
      '-U',
      '-s',
      FEISHU_SYSTEM_KEYCHAIN_SERVICE,
      '-a',
      REFERENCE_ID,
      '-w',
    ],
    maximumDiagnosticBytes: FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
  })
  assert.equal(Object.isFrozen(observedRequest), true)
  assert.equal(Object.isFrozen(observedRequest?.arguments), true)
  assert.equal(observedRequest?.arguments.includes(PRIVATE_VALUE), false)
})

test('replacement validation fails before Keychain access and still clears supplied bytes', async () => {
  let calls = 0
  const replacer = new FeishuSystemKeychainSecretReplacer({
    platform: 'darwin',
    runner: {
      async replace() {
        calls += 1
      },
    },
  })
  const cases = [
    {
      reference: reference('connector_app_credential'),
      secret: new Uint8Array([1]),
      code: 'unsupported_purpose',
    },
    {
      reference: reference('connector_oauth', 'encrypted_secret_store'),
      secret: new Uint8Array([1]),
      code: 'unsupported_store',
    },
    {
      reference: { ...reference('connector_oauth'), id: PRIVATE_VALUE },
      secret: new Uint8Array([1]),
      code: 'invalid_reference',
    },
    { reference: reference('connector_oauth'), secret: new Uint8Array(), code: 'secret_empty' },
    {
      reference: reference('connector_oauth'),
      secret: new Uint8Array(FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES + 1).fill(7),
      code: 'secret_too_large',
    },
  ]
  for (const item of cases) {
    await assert.rejects(
      replacer.replace(item.reference, item.secret, new AbortController().signal),
      (error) =>
        error instanceof FeishuSystemKeychainError &&
        error.code === item.code &&
        !error.message.includes(PRIVATE_VALUE),
    )
    assert.ok(item.secret.every((value) => value === 0))
  }

  const unsupportedSecret = new Uint8Array([1])
  await assert.rejects(
    new FeishuSystemKeychainSecretReplacer({
      platform: 'linux',
      runner: { replace: async () => undefined },
    }).replace(reference('connector_oauth'), unsupportedSecret, new AbortController().signal),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unsupported_platform',
  )
  assert.ok(unsupportedSecret.every((value) => value === 0))

  const cancelledSecret = new Uint8Array([1])
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    replacer.replace(reference('connector_oauth'), cancelledSecret, cancelled.signal),
    { name: 'AbortError' },
  )
  assert.ok(cancelledSecret.every((value) => value === 0))
  assert.equal(calls, 0)
})

test('every post-start replacement failure is uncertain and payload-free', async () => {
  const privateFailure = new Error(PRIVATE_VALUE)
  const failedSecret = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  await assert.rejects(
    new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: { replace: async () => Promise.reject(privateFailure) },
    }).replace(reference('connector_oauth'), failedSecret, new AbortController().signal),
    (error) =>
      error instanceof FeishuSystemKeychainError &&
      error.code === 'write_uncertain' &&
      !error.message.includes(PRIVATE_VALUE) &&
      !error.message.includes(REFERENCE_ID),
  )
  assert.ok(failedSecret.every((value) => value === 0))

  const postWriteSecret = new Uint8Array(Buffer.from(PRIVATE_VALUE, 'utf8'))
  const postWriteCancelled = new AbortController()
  await assert.rejects(
    new FeishuSystemKeychainSecretReplacer({
      platform: 'darwin',
      runner: {
        async replace() {
          postWriteCancelled.abort()
        },
      },
    }).replace(reference('connector_oauth'), postWriteSecret, postWriteCancelled.signal),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'write_uncertain',
  )
  assert.ok(postWriteSecret.every((value) => value === 0))
})

test('Keychain adapter options reject fallback ambiguity and accessors without running them', () => {
  for (const Adapter of [FeishuSystemKeychainSecretResolver, FeishuSystemKeychainSecretReplacer]) {
    for (const options of [{ platform: null }, { runner: null }, { unknown: PRIVATE_VALUE }]) {
      assert.throws(
        () => new Adapter(/** @type {never} */ (options)),
        (error) =>
          error instanceof FeishuSystemKeychainError &&
          error.code === 'unavailable' &&
          !error.message.includes(PRIVATE_VALUE),
      )
    }

    let accessed = false
    const hostile = Object.defineProperty({}, 'runner', {
      enumerable: true,
      get() {
        accessed = true
        return null
      },
    })
    assert.throws(
      () => new Adapter(/** @type {never} */ (hostile)),
      (error) => error instanceof FeishuSystemKeychainError && error.code === 'unavailable',
    )
    assert.equal(accessed, false)
  }
})
