import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuAuthorizationSnapshot } from '../packages/web/dist/feishu-authorization-contract.js'

test('the Web authorization contract accepts only minimized exact snapshots', () => {
  for (const state of ['idle', 'starting', 'succeeded', 'cancelled']) {
    assert.deepEqual(
      parseFeishuAuthorizationSnapshot({ version: 1, connectorId: 'feishu', state }),
      { version: 1, connectorId: 'feishu', state },
    )
  }
  assert.deepEqual(
    parseFeishuAuthorizationSnapshot({
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent('http://[::1]:43121/oauth/callback')}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`,
      redirectUri: 'http://[::1]:43121/oauth/callback',
    }),
    {
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent('http://[::1]:43121/oauth/callback')}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`,
      redirectUri: 'http://[::1]:43121/oauth/callback',
    },
  )
  assert.deepEqual(
    parseFeishuAuthorizationSnapshot({
      version: 1,
      connectorId: 'feishu',
      state: 'failed',
      recovery: 'retry_later',
    }),
    { version: 1, connectorId: 'feishu', state: 'failed', recovery: 'retry_later' },
  )
})

test('the Web authorization contract rejects extra data, hostile URLs, and accessors', () => {
  for (const value of [
    { version: 1, connectorId: 'feishu', state: 'idle', credential: 'synthetic-secret' },
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
      authorizationUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      redirectUri: 'http://localhost:43121/oauth/callback',
    },
    { version: 1, connectorId: 'feishu', state: 'failed', recovery: 'retry_forever' },
  ]) {
    assert.throws(() => parseFeishuAuthorizationSnapshot(value), /invalid/u)
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
    () => parseFeishuAuthorizationSnapshot(hostile),
    (error) =>
      error instanceof Error &&
      /invalid/u.test(error.message) &&
      !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)

  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('synthetic-private-proxy')
      },
    },
  )
  assert.throws(
    () => parseFeishuAuthorizationSnapshot(proxy),
    (error) => error instanceof Error && !error.message.includes('synthetic-private'),
  )
})
