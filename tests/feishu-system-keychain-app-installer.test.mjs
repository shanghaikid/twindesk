import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
  FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
  FEISHU_SYSTEM_KEYCHAIN_SERVICE,
  FeishuSystemKeychainError,
  FeishuSystemKeychainSecretInstaller,
} from '../packages/plugin-feishu/dist/index.js'

const REFERENCE = Object.freeze({
  kind: 'secret_reference',
  schemaVersion: 1,
  id: 'secret-ref:synthetic-app-installer',
  store: 'system_keychain',
  purpose: 'connector_app_credential',
})

test('Bot application credential installation uses create-only stdin and clears its buffer', async () => {
  /** @type {unknown} */
  let observedRequest
  /** @type {Uint8Array | undefined} */
  let borrowedSecret
  /** @type {Uint8Array | undefined} */
  let secretSnapshot
  const installer = new FeishuSystemKeychainSecretInstaller({
    platform: 'darwin',
    runner: {
      async install(request, secret, signal) {
        observedRequest = request
        borrowedSecret = secret
        secretSnapshot = new Uint8Array(secret)
        assert.equal(signal.aborted, false)
      },
    },
  })
  const bundle = new TextEncoder().encode('{"synthetic":"bundle"}')
  await installer.install(REFERENCE, bundle, new AbortController().signal)

  assert.deepEqual(observedRequest, {
    executable: '/usr/bin/security',
    arguments: [
      'add-generic-password',
      '-s',
      FEISHU_SYSTEM_KEYCHAIN_SERVICE,
      '-a',
      REFERENCE.id,
      '-w',
    ],
    maximumDiagnosticBytes: FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
  })
  assert.equal(observedRequest.arguments.includes('-U'), false)
  assert.equal(Object.isFrozen(observedRequest), true)
  assert.equal(Object.isFrozen(observedRequest.arguments), true)
  assert.equal(new TextDecoder().decode(secretSnapshot), '{"synthetic":"bundle"}')
  assert.ok(bundle.every((byte) => byte === 0))
  assert.ok(borrowedSecret?.every((byte) => byte === 0))
})

test('Bot application credential installation rejects other purposes before invoking the runner', async () => {
  let calls = 0
  const installer = new FeishuSystemKeychainSecretInstaller({
    platform: 'darwin',
    runner: {
      async install() {
        calls += 1
      },
    },
  })
  const secret = new TextEncoder().encode('synthetic-invalid-purpose')
  await assert.rejects(
    installer.install(
      { ...REFERENCE, purpose: 'connector_oauth' },
      secret,
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unsupported_purpose',
  )
  assert.equal(calls, 0)
  assert.ok(secret.every((byte) => byte === 0))
})

test('Bot application credential installation makes post-start failure uncertain and non-retrying', async () => {
  let calls = 0
  const installer = new FeishuSystemKeychainSecretInstaller({
    platform: 'darwin',
    runner: {
      async install() {
        calls += 1
        throw new Error('synthetic-private-keychain-diagnostic')
      },
    },
  })
  const secret = new TextEncoder().encode('synthetic-install-failure')
  await assert.rejects(
    installer.install(REFERENCE, secret, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof FeishuSystemKeychainError)
      assert.equal(error.code, 'write_uncertain')
      assert.equal(error.message.includes('synthetic-private'), false)
      return true
    },
  )
  assert.equal(calls, 1)
  assert.ok(secret.every((byte) => byte === 0))
})

test('Bot application credential installer rejects hostile options and invalid signals before access', async () => {
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'runner', {
    enumerable: true,
    get() {
      getterCalls += 1
      return { install: async () => undefined }
    },
  })
  assert.throws(
    () => new FeishuSystemKeychainSecretInstaller(hostile),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unavailable',
  )
  assert.equal(getterCalls, 0)

  let calls = 0
  const installer = new FeishuSystemKeychainSecretInstaller({
    platform: 'darwin',
    runner: {
      async install() {
        calls += 1
      },
    },
  })
  const secret = new TextEncoder().encode('synthetic-invalid-signal')
  await assert.rejects(
    installer.install(REFERENCE, secret, /** @type {any} */ ({})),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unavailable',
  )
  assert.equal(calls, 0)
  assert.ok(secret.every((byte) => byte === 0))
})

test('Bot application credential installation rejects pre-start cancellation, unsupported platforms, and oversized input', async () => {
  let calls = 0
  const runner = {
    async install() {
      calls += 1
    },
  }

  const controller = new AbortController()
  controller.abort()
  const cancelled = new TextEncoder().encode('synthetic-cancelled-install')
  await assert.rejects(
    new FeishuSystemKeychainSecretInstaller({ platform: 'darwin', runner }).install(
      REFERENCE,
      cancelled,
      controller.signal,
    ),
    (error) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.ok(cancelled.every((byte) => byte === 0))

  const unsupported = new TextEncoder().encode('synthetic-unsupported-install')
  await assert.rejects(
    new FeishuSystemKeychainSecretInstaller({ platform: 'linux', runner }).install(
      REFERENCE,
      unsupported,
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'unsupported_platform',
  )
  assert.ok(unsupported.every((byte) => byte === 0))

  const oversized = new Uint8Array(FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES + 1).fill(1)
  await assert.rejects(
    new FeishuSystemKeychainSecretInstaller({ platform: 'darwin', runner }).install(
      REFERENCE,
      oversized,
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuSystemKeychainError && error.code === 'secret_too_large',
  )
  assert.ok(oversized.every((byte) => byte === 0))
  assert.equal(calls, 0)
})

test('Bot application credential installation bypasses hostile fill overrides during cleanup', async () => {
  const secret = new TextEncoder().encode('synthetic-hostile-installer-fill')
  let fillCalls = 0
  Object.defineProperty(secret, 'fill', {
    value() {
      fillCalls += 1
      throw new Error('synthetic-private-hostile-installer-fill')
    },
  })
  const installer = new FeishuSystemKeychainSecretInstaller({
    platform: 'darwin',
    runner: { install: async () => undefined },
  })

  await installer.install(REFERENCE, secret, new AbortController().signal)

  assert.equal(fillCalls, 0)
  assert.ok(Uint8Array.prototype.every.call(secret, (byte) => byte === 0))
})
