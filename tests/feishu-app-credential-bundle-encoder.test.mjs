import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuAppCredentialBundleEncoder,
  FeishuAppCredentialBundleEncoderError,
  FeishuCredentialBundleParser,
} from '../packages/plugin-feishu/dist/index.js'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-app-encoder',
  appId: 'cli_synthetic_app_encoder',
  bot: {
    identityType: 'bot',
    displayName: 'Synthetic Encoder Bot',
    principalId: 'ou_synthetic_app_encoder',
    credentialReference: {
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-app-encoder',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    },
  },
})

test('Bot application credential encoding round-trips under the exact identity and clears buffers', async () => {
  const source = new TextEncoder().encode('synthetic-app-secret')
  /** @type {Uint8Array | undefined} */
  let borrowedBundle
  const result = await new FeishuAppCredentialBundleEncoder().withEncodedBundle(
    CONFIGURATION,
    source,
    new AbortController().signal,
    async (bundle) => {
      borrowedBundle = bundle
      const parserCopy = new Uint8Array(bundle)
      return new FeishuCredentialBundleParser().withCredential(
        CONFIGURATION,
        'bot',
        parserCopy,
        new AbortController().signal,
        (credential) => {
          assert.equal(credential.kind, 'feishu_app_credential_bundle')
          assert.equal(credential.appId, CONFIGURATION.appId)
          assert.equal(new TextDecoder().decode(credential.appSecret), 'synthetic-app-secret')
          return 'installed-ready'
        },
      )
    },
  )

  assert.equal(result, 'installed-ready')
  assert.ok(source.every((byte) => byte === 0))
  assert.ok(borrowedBundle?.every((byte) => byte === 0))
})

test('Bot application credential encoding rejects missing identities and invalid secrets without disclosure', async () => {
  const encoder = new FeishuAppCredentialBundleEncoder()
  const privateValue = 'synthetic-private-app-secret'
  /** @type {Array<[unknown, Uint8Array]>} */
  const invalidCases = [
    [{ ...CONFIGURATION, bot: undefined }, new TextEncoder().encode(privateValue)],
    [CONFIGURATION, new TextEncoder().encode(` ${privateValue}`)],
    [CONFIGURATION, new Uint8Array([0xff])],
  ]
  for (const [configuration, source] of invalidCases) {
    await assert.rejects(
      encoder.withEncodedBundle(configuration, source, new AbortController().signal, () =>
        assert.fail('Invalid input must not reach the bundle consumer.'),
      ),
      (error) => {
        assert.ok(error instanceof FeishuAppCredentialBundleEncoderError)
        assert.equal(error.message.includes(privateValue), false)
        return true
      },
    )
    assert.ok(source.every((byte) => byte === 0))
  }
})

test('Bot application credential encoding clears owned input on cancellation and consumer failure', async () => {
  const encoder = new FeishuAppCredentialBundleEncoder()
  const cancelled = new TextEncoder().encode('synthetic-cancelled-secret')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    encoder.withEncodedBundle(CONFIGURATION, cancelled, controller.signal, () => undefined),
  )
  assert.ok(cancelled.every((byte) => byte === 0))

  const failed = new TextEncoder().encode('synthetic-failed-secret')
  /** @type {Uint8Array | undefined} */
  let borrowedBundle
  await assert.rejects(
    encoder.withEncodedBundle(CONFIGURATION, failed, new AbortController().signal, (bundle) => {
      borrowedBundle = bundle
      throw new Error('synthetic-consumer-failure')
    }),
    /synthetic-consumer-failure/u,
  )
  assert.ok(failed.every((byte) => byte === 0))
  assert.ok(borrowedBundle?.every((byte) => byte === 0))

  const invalidSignal = new TextEncoder().encode('synthetic-invalid-signal-secret')
  await assert.rejects(
    encoder.withEncodedBundle(
      CONFIGURATION,
      invalidSignal,
      /** @type {any} */ ({}),
      () => undefined,
    ),
    (error) =>
      error instanceof FeishuAppCredentialBundleEncoderError && error.code === 'invalid_signal',
  )
  assert.ok(invalidSignal.every((byte) => byte === 0))
})

test('Bot application credential encoding bypasses hostile fill overrides during cleanup', async () => {
  const source = new TextEncoder().encode('synthetic-hostile-fill-secret')
  let fillCalls = 0
  Object.defineProperty(source, 'fill', {
    value() {
      fillCalls += 1
      throw new Error('synthetic-private-hostile-fill')
    },
  })

  await new FeishuAppCredentialBundleEncoder().withEncodedBundle(
    CONFIGURATION,
    source,
    new AbortController().signal,
    () => undefined,
  )

  assert.equal(fillCalls, 0)
  assert.ok(Uint8Array.prototype.every.call(source, (byte) => byte === 0))
})
