import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFeishuReplyApprovalDecisionRequest,
  parseFeishuReplyApprovalRequest,
  parseFeishuReplyApprovalSnapshot,
  parseFeishuReplyApprovalStatusSnapshot,
} from '../packages/web/dist/index.js'

const SNAPSHOT = Object.freeze({
  version: 1,
  operation: 'request',
  disposition: 'applied',
  executionAvailable: false,
  approval: Object.freeze({
    decision: 'pending',
    requestedAt: '2026-09-02T09:05:00.000Z',
    expiresAt: '2026-09-02T09:20:00.000Z',
  }),
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-approval-contract',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'awaiting_approval',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-approval-contract',
      identityType: 'user',
      displayName: 'Synthetic Approval User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-approval-contract',
      objectType: 'message',
      externalId: 'om_synthetic_approval_contract',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact approval.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
})

test('reply approval browser contracts preserve only exact local intent and presentation', () => {
  assert.deepEqual(
    parseFeishuReplyApprovalStatusSnapshot({
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    }),
    {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    },
  )
  assert.deepEqual(
    parseFeishuReplyApprovalRequest({
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
    }),
    { version: 1, workItemId: SNAPSHOT.proposal.workItemId, draftRevision: 2 },
  )
  assert.deepEqual(
    parseFeishuReplyApprovalDecisionRequest({
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
      decision: 'approved',
    }),
    {
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
      decision: 'approved',
    },
  )
  assert.deepEqual(parseFeishuReplyApprovalSnapshot(SNAPSHOT), SNAPSHOT)
})

test('reply approval browser contracts reject authority injection and inconsistent bindings', () => {
  for (const value of [
    {
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
      decision: 'approved',
      responderUserId: 'attacker',
    },
    {
      version: 1,
      workItemId: SNAPSHOT.proposal.workItemId,
      draftRevision: 2,
      decision: 'expired',
    },
  ]) {
    assert.throws(() => parseFeishuReplyApprovalDecisionRequest(value), /invalid/u)
  }
  assert.throws(
    () =>
      parseFeishuReplyApprovalSnapshot({
        ...SNAPSHOT,
        approval: { ...SNAPSHOT.approval, decision: 'approved' },
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyApprovalSnapshot({
        ...SNAPSHOT,
        approval: {
          decision: 'expired',
          requestedAt: SNAPSHOT.approval.requestedAt,
          expiresAt: SNAPSHOT.approval.expiresAt,
          decidedAt: '2026-09-02T09:19:59.999Z',
        },
        proposal: { ...SNAPSHOT.proposal, state: 'cancelled' },
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyApprovalSnapshot({
        ...SNAPSHOT,
        proposal: {
          ...SNAPSHOT.proposal,
          content: { mediaType: 'text/plain', text: 'unsafe\u0000content' },
        },
      }),
    /invalid/u,
  )
})
