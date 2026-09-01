import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeishuOAuthReconciliationSnapshot } from '../packages/web/dist/index.js'

test('the browser accepts only minimized Feishu OAuth reconciliation results', () => {
  for (const status of ['reconciled', 'still_required']) {
    assert.deepEqual(
      parseFeishuOAuthReconciliationSnapshot({ version: 1, connectorId: 'feishu', status }),
      { version: 1, connectorId: 'feishu', status },
    )
  }
})

test('the browser rejects malformed reconciliation results without echoing data', () => {
  const privateValue = 'synthetic-private-reconciliation-contract'
  for (const value of [
    null,
    { version: 2, connectorId: 'feishu', status: 'reconciled' },
    { version: 1, connectorId: 'other', status: 'reconciled' },
    { version: 1, connectorId: 'feishu', status: 'unknown' },
    { version: 1, connectorId: 'feishu', status: 'reconciled', token: privateValue },
  ]) {
    assert.throws(
      () => parseFeishuOAuthReconciliationSnapshot(value),
      (error) => error instanceof Error && !error.message.includes(privateValue),
    )
  }
})
