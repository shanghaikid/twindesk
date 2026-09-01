import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFeishuOAuthSettingsUpdate,
  parseFeishuSettingsSnapshot,
} from '../packages/web/dist/feishu-settings-contract.js'

const READY = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  state: 'ready',
  identities: ['bot', 'user'],
  oauth: {
    redirectHost: '127.0.0.1',
    redirectPort: 43121,
    scopes: ['im:message:readonly', 'offline_access'],
    appMatchesIdentity: true,
  },
})

/** @param {unknown} value @returns {any} */
function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the browser accepts and freezes canonical minimized Feishu Settings', () => {
  const snapshot = parseFeishuSettingsSnapshot(copy(READY))
  assert.deepEqual(snapshot, READY)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.identities), true)
  assert.equal(Object.isFrozen(snapshot.oauth), true)
  assert.equal(Object.isFrozen(snapshot.oauth?.scopes), true)
})

test('the browser rejects noncanonical or identifying Feishu Settings without echoing data', () => {
  const privateValue = 'synthetic-private-settings-value'
  for (const malformed of [
    { ...copy(READY), version: 2 },
    { ...copy(READY), appId: privateValue },
    { ...copy(READY), principalId: privateValue },
    { ...copy(READY), path: privateValue },
    { ...copy(READY), credentialReference: privateValue },
    { ...copy(READY), identities: ['user', 'bot'] },
    { ...copy(READY), identities: ['bot', 'bot', 'user'] },
    { ...copy(READY), identities: ['bot'] },
    { ...copy(READY), state: 'incomplete' },
    { ...copy(READY), oauth: { ...copy(READY.oauth), redirectHost: 'localhost' } },
    { ...copy(READY), oauth: { ...copy(READY.oauth), redirectPort: 0 } },
    {
      ...copy(READY),
      oauth: { ...copy(READY.oauth), scopes: ['offline_access', 'offline_access'] },
    },
    { ...copy(READY), oauth: { ...copy(READY.oauth), scopes: ['offline_access', 'a:scope'] } },
    { ...copy(READY), oauth: { ...copy(READY.oauth), scopes: ['im:message:readonly'] } },
    {
      version: 1,
      connectorId: 'feishu',
      state: 'not_configured',
      identities: [],
      oauth: copy(READY.oauth),
    },
  ]) {
    assert.throws(
      () => parseFeishuSettingsSnapshot(malformed),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes(privateValue), false)
        return true
      },
    )
  }
})

test('the shared Feishu Settings parser rejects accessors without invoking them', () => {
  let getterCalls = 0
  const topLevel = Object.defineProperty(copy(READY), 'state', {
    get() {
      getterCalls += 1
      return 'ready'
    },
    enumerable: true,
  })
  const oauth = copy(READY)
  Object.defineProperty(oauth.oauth, 'redirectPort', {
    get() {
      getterCalls += 1
      return 43121
    },
    enumerable: true,
  })
  const identities = copy(READY)
  Object.defineProperty(identities.identities, '0', {
    get() {
      getterCalls += 1
      return 'bot'
    },
    enumerable: true,
  })

  for (const hostile of [topLevel, oauth, identities]) {
    assert.throws(() => parseFeishuSettingsSnapshot(hostile), /invalid Feishu Settings/u)
  }
  assert.equal(getterCalls, 0)
})

test('the browser and server share one canonical OAuth Settings update contract', () => {
  const update = {
    version: 1,
    redirectHost: '::1',
    redirectPort: 43123,
    scopes: ['im:message:readonly', 'offline_access'],
  }
  const parsed = parseFeishuOAuthSettingsUpdate(copy(update))
  assert.deepEqual(parsed, update)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.scopes), true)

  const sparseScopes = Array(2)
  sparseScopes[1] = 'offline_access'
  for (const malformed of [
    { ...update, version: 2 },
    { ...update, redirectHost: 'localhost' },
    { ...update, redirectPort: 0 },
    { ...update, redirectPort: 80 },
    { ...update, scopes: ['offline_access', 'im:message:readonly'] },
    { ...update, scopes: ['im:message:readonly'] },
    { ...update, scopes: sparseScopes },
    { ...update, appId: 'synthetic-private-app-id' },
  ]) {
    assert.throws(() => parseFeishuOAuthSettingsUpdate(malformed), /invalid Feishu Settings/u)
  }
})
