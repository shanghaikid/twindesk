import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuReauthorizationSnapshot } from '../packages/web/dist/feishu-reauthorization-contract.js'

const REDIRECT_URI = 'http://[::1]:43121/oauth/callback'
const AUTHORIZATION_URL = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`

test('the Web reauthorization contract accepts only minimized exact snapshots', () => {
  for (const state of ['idle', 'starting', 'succeeded', 'cancelled']) {
    assert.deepEqual(
      parseFeishuReauthorizationSnapshot({ version: 1, connectorId: 'feishu', state }),
      {
        version: 1,
        connectorId: 'feishu',
        state,
      },
    )
  }
  assert.deepEqual(
    parseFeishuReauthorizationSnapshot({
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: AUTHORIZATION_URL,
      redirectUri: REDIRECT_URI,
    }),
    {
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: AUTHORIZATION_URL,
      redirectUri: REDIRECT_URI,
    },
  )
  for (const recovery of [
    'configure_settings',
    'correct_configuration',
    'reauthorize',
    'reconcile_keychain',
    'reconcile_rotation',
    'retry_after_owner_exit',
    'do_not_retry',
  ]) {
    assert.deepEqual(
      parseFeishuReauthorizationSnapshot({
        version: 1,
        connectorId: 'feishu',
        state: 'failed',
        recovery,
      }),
      { version: 1, connectorId: 'feishu', state: 'failed', recovery },
    )
  }
})

test('the Web reauthorization contract rejects extra data, hostile URLs, and accessors', () => {
  for (const value of [
    { version: 1, connectorId: 'feishu', state: 'idle', refreshToken: 'synthetic-secret' },
    {
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: 'https://example.invalid/steal',
      redirectUri: 'http://127.0.0.1:43121/oauth/callback',
    },
    {
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: AUTHORIZATION_URL,
      redirectUri: 'http://localhost:43121/oauth/callback',
    },
    { version: 1, connectorId: 'feishu', state: 'failed', recovery: 'retry_forever' },
  ]) {
    assert.throws(() => parseFeishuReauthorizationSnapshot(value), /invalid/u)
  }

  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'state', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-accessor')
    },
  })
  assert.throws(
    () => parseFeishuReauthorizationSnapshot(hostile),
    (error) => error instanceof Error && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})
