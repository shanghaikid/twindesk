import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuOAuthRecoverySnapshot } from '../packages/web/dist/feishu-oauth-recovery-contract.js'

test('the Web recovery contract accepts only exact identifier-free snapshots', () => {
  for (const state of [
    'not_started',
    'ready',
    'rotation_active',
    'reauthorization_required',
    'reconciliation_required',
  ]) {
    assert.deepEqual(
      parseFeishuOAuthRecoverySnapshot({ version: 1, connectorId: 'feishu', state }),
      { version: 1, connectorId: 'feishu', state },
    )
  }
})

test('the Web recovery contract rejects extra data, invalid states, and accessors', () => {
  for (const value of [
    { version: 2, connectorId: 'feishu', state: 'ready' },
    { version: 1, connectorId: 'jira', state: 'ready' },
    { version: 1, connectorId: 'feishu', state: 'credential_valid' },
    {
      version: 1,
      connectorId: 'feishu',
      state: 'reconciliation_required',
      accountId: 'synthetic-private-account',
    },
  ]) {
    assert.throws(() => parseFeishuOAuthRecoverySnapshot(value), /invalid/u)
  }

  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'state', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-recovery-state')
    },
  })
  assert.throws(
    () => parseFeishuOAuthRecoverySnapshot(hostile),
    (error) => error instanceof Error && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})
