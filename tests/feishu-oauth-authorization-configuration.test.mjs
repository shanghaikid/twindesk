import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuOAuthAuthorizationConfiguration } from '../packages/plugin-feishu/dist/index.js'

function configuration(changes = {}) {
  return {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: 'cli_synthetic_registered_redirect',
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['offline_access', 'im:message:readonly'],
    ...changes,
  }
}

test('registered OAuth configuration is app-bound, canonical, sorted, and immutable', () => {
  const parsed = parseFeishuOAuthAuthorizationConfiguration(configuration())
  assert.deepEqual(parsed, {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: 'cli_synthetic_registered_redirect',
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['im:message:readonly', 'offline_access'],
  })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.scopes), true)

  assert.equal(
    parseFeishuOAuthAuthorizationConfiguration(
      configuration({ redirectUri: 'http://[::1]:43122/oauth/feishu/callback' }),
    ).redirectUri,
    'http://[::1]:43122/oauth/feishu/callback',
  )
})

test('registered OAuth configuration rejects dynamic, non-loopback, and noncanonical redirects', () => {
  for (const redirectUri of [
    'http://127.0.0.1:0/oauth/feishu/callback',
    'http://127.0.0.1:80/oauth/feishu/callback',
    'http://localhost:43121/oauth/feishu/callback',
    'https://127.0.0.1:43121/oauth/feishu/callback',
    'http://127.0.0.1:43121/oauth/feishu/callback?extra=x',
    'http://127.0.0.1:43121/oauth/feishu/%63allback',
  ]) {
    assert.throws(
      () => parseFeishuOAuthAuthorizationConfiguration(configuration({ redirectUri })),
      {
        name: 'TypeError',
        message: 'The Feishu OAuth authorization configuration is invalid.',
      },
    )
  }
})

test('registered OAuth configuration rejects invalid scopes, versions, and hostile data', () => {
  for (const value of [
    configuration({ scopes: ['im:message:readonly'] }),
    configuration({ scopes: ['offline_access', 'offline_access'] }),
    configuration({ schemaVersion: 2 }),
    configuration({ extra: true }),
  ]) {
    assert.throws(() => parseFeishuOAuthAuthorizationConfiguration(value), TypeError)
  }
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'kind', {
    get() {
      getterCalls += 1
      return 'feishu_oauth_authorization_configuration'
    },
  })
  assert.throws(() => parseFeishuOAuthAuthorizationConfiguration(hostile), TypeError)
  assert.equal(getterCalls, 0)
})
