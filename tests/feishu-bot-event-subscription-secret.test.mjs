import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuBotEventSubscriptionSecretError,
  withFeishuBotEventSubscriptionSecrets,
} from '../packages/plugin-feishu/dist/index.js'

const PRIVATE_TOKEN = 'synthetic-private-verification-token'
const PRIVATE_KEY = 'synthetic-private-encryption-key'

function configuration(appId = 'cli_synthetic_twindesk') {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic',
    appId,
    bot: {
      identityType: 'bot',
      displayName: 'TwinDesk Bot',
      principalId: 'ou_synthetic_bot',
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-feishu-app',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
  }
}

function bundle(overrides = {}) {
  return new TextEncoder().encode(
    `${JSON.stringify({
      kind: 'feishu_bot_event_subscription_secret_bundle',
      schemaVersion: 1,
      appId: 'cli_synthetic_twindesk',
      verificationToken: PRIVATE_TOKEN,
      encryptionKey: PRIVATE_KEY,
      ...overrides,
    })}\n`,
  )
}

test('event subscription secrets stay callback-scoped and bind the exact Bot app', async () => {
  const bytes = bundle()
  const result = await withFeishuBotEventSubscriptionSecrets(
    configuration(),
    bytes,
    async (secrets) => {
      assert.deepEqual(secrets, {
        kind: 'feishu_bot_event_subscription_secrets',
        schemaVersion: 1,
        appId: 'cli_synthetic_twindesk',
        verificationToken: PRIVATE_TOKEN,
        encryptionKey: PRIVATE_KEY,
      })
      assert.equal(Object.isFrozen(secrets), true)
      return 'used'
    },
  )
  assert.equal(result, 'used')
  assert.equal(Buffer.from(bytes).toString('utf8').includes(PRIVATE_KEY), true)
})

test('event subscription bundle identity, shape, encoding, and consumer fail closed', async () => {
  const cases = [
    bundle({ appId: 'cli_other' }),
    bundle({ verificationToken: '' }),
    bundle({ encryptionKey: '' }),
    new TextEncoder().encode(
      `{"kind":"feishu_bot_event_subscription_secret_bundle","kind":"duplicate","schemaVersion":1,"appId":"cli_synthetic_twindesk","verificationToken":"${PRIVATE_TOKEN}","encryptionKey":"${PRIVATE_KEY}"}`,
    ),
    new Uint8Array([0xff]),
  ]
  for (const bytes of cases) {
    let called = false
    await assert.rejects(
      withFeishuBotEventSubscriptionSecrets(configuration(), bytes, () => {
        called = true
      }),
      (error) =>
        error instanceof FeishuBotEventSubscriptionSecretError &&
        !error.message.includes(PRIVATE_TOKEN) &&
        !error.message.includes(PRIVATE_KEY),
    )
    assert.equal(called, false)
  }
  await assert.rejects(
    withFeishuBotEventSubscriptionSecrets(
      configuration(),
      bundle(),
      /** @type {(value: unknown) => unknown} */ (/** @type {unknown} */ (null)),
    ),
    (error) =>
      error instanceof FeishuBotEventSubscriptionSecretError && error.code === 'invalid_consumer',
  )
})
