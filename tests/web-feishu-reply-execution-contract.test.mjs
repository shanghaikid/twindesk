import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFeishuReplyExecutionRequest,
  parseFeishuReplyExecutionSnapshot,
  parseFeishuReplyExecutionStatusSnapshot,
} from '../packages/web/dist/index.js'

const SNAPSHOT = Object.freeze({
  version: 1,
  disposition: 'executed',
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-execution-contract',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'succeeded',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-contract',
      identityType: 'user',
      displayName: 'Synthetic Execution User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-contract',
      objectType: 'message',
      externalId: 'om_synthetic_execution_contract_target',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact execution.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
  execution: Object.freeze({
    outcome: 'succeeded',
    attemptedAt: '2026-09-02T09:06:00.000Z',
    externalReference: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-contract',
      objectType: 'message',
      externalId: 'om_synthetic_execution_contract_result',
      sourceTimestamp: '2026-09-02T09:06:01.000Z',
    }),
  }),
})

test('reply execution browser contracts expose exact intent and minimized outcome', () => {
  assert.deepEqual(
    parseFeishuReplyExecutionStatusSnapshot({
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    }),
    { version: 1, capability: 'ready', actionType: 'feishu.reply' },
  )
  assert.deepEqual(
    parseFeishuReplyExecutionRequest({
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
    }),
    { version: 1, workItemId: SNAPSHOT.proposal.workItemId, draftRevision: 2 },
  )
  assert.deepEqual(parseFeishuReplyExecutionSnapshot(SNAPSHOT), SNAPSHOT)
})

test('reply execution browser contracts reject authority injection and inconsistent results', () => {
  assert.throws(
    () =>
      parseFeishuReplyExecutionRequest({
        version: 1,
        workItemId: SNAPSHOT.proposal.workItemId,
        draftRevision: 2,
        approvalId: 'forged',
      }),
    /invalid/u,
  )
  for (const value of [
    { ...SNAPSHOT, proposal: { ...SNAPSHOT.proposal, state: 'approved' } },
    {
      ...SNAPSHOT,
      execution: {
        ...SNAPSHOT.execution,
        externalReference: {
          ...SNAPSHOT.execution.externalReference,
          accountId: 'feishu-account:other',
        },
      },
    },
    { ...SNAPSHOT, executionAttemptId: 'hidden-authority' },
  ]) {
    assert.throws(() => parseFeishuReplyExecutionSnapshot(value), /invalid/u)
  }
})
