import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuDiagnosticsSnapshot } from '../packages/web/dist/feishu-diagnostics-contract.js'

const SNAPSHOT = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  status: 'degraded',
  checkedAt: '2026-09-03T08:00:00.000Z',
  runtime: { version: 1, state: 'attention_required', recovery: 'reauthorize' },
  identities: [
    {
      identityType: 'user',
      status: 'attention_required',
      requiredScopes: [
        'im:chat:read',
        'im:message:readonly',
        'im:message:send_as_user',
        'search:message',
      ],
      missingScopes: ['im:message:send_as_user'],
    },
  ],
  rateLimits: [{ identityType: 'user', status: 'unknown' }],
  cursors: [
    {
      stream: 'user_visible_messages',
      status: 'stale',
      updatedAt: '2026-09-03T07:30:00.000Z',
      committedThrough: '2026-09-03T07:29:00.000Z',
    },
  ],
  issues: [
    {
      code: 'user_scope_missing',
      recovery: 'grant_scope',
    },
  ],
})

/** @param {unknown} value */
function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the browser accepts only the minimized Feishu diagnostics contract', () => {
  const parsed = parseFeishuDiagnosticsSnapshot(copy(SNAPSHOT))
  assert.deepEqual(parsed, SNAPSHOT)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.identities), true)
  assert.equal(Object.isFrozen(parsed.identities[0]?.requiredScopes), true)
})

test('the diagnostics contract rejects identifiers, secrets, opaque cursors, and hostile accessors', () => {
  const privateValue = 'synthetic-private-diagnostic-value'
  for (const malformed of [
    { ...copy(SNAPSHOT), accountId: privateValue },
    { ...copy(SNAPSHOT), principalId: privateValue },
    { ...copy(SNAPSHOT), credentialReference: privateValue },
    { ...copy(SNAPSHOT), token: privateValue },
    { ...copy(SNAPSHOT), position: privateValue },
    { ...copy(SNAPSHOT), status: 'not_configured' },
    { ...copy(SNAPSHOT), checkedAt: privateValue },
    {
      ...copy(SNAPSHOT),
      identities: [{ ...copy(SNAPSHOT.identities[0]), missingScopes: ['z', 'a'] }],
    },
    { ...copy(SNAPSHOT), runtime: { version: 1, state: 'attention_required', recovery: 'retry' } },
    {
      ...copy(SNAPSHOT),
      issues: [{ code: 'user_scope_missing', recovery: 'grant_scope', message: privateValue }],
    },
    { ...copy(SNAPSHOT), issues: [{ code: privateValue, recovery: 'retry' }] },
  ]) {
    assert.throws(
      () => parseFeishuDiagnosticsSnapshot(malformed),
      (error) => error instanceof Error && !error.message.includes(privateValue),
    )
  }

  let accessed = false
  const hostile = Object.defineProperty(copy(SNAPSHOT), 'issues', {
    enumerable: true,
    get() {
      accessed = true
      return []
    },
  })
  assert.throws(() => parseFeishuDiagnosticsSnapshot(hostile))
  assert.equal(accessed, false)
})

test('not-configured diagnostics are explicit and contain no inferred health', () => {
  assert.deepEqual(
    parseFeishuDiagnosticsSnapshot({
      version: 1,
      connectorId: 'feishu',
      status: 'not_configured',
      checkedAt: null,
      runtime: { version: 1, state: 'disabled', reason: 'not_configured' },
      identities: [],
      rateLimits: [],
      cursors: [],
      issues: [],
    }),
    {
      version: 1,
      connectorId: 'feishu',
      status: 'not_configured',
      checkedAt: null,
      runtime: { version: 1, state: 'disabled', reason: 'not_configured' },
      identities: [],
      rateLimits: [],
      cursors: [],
      issues: [],
    },
  )
})
