import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFeishuReplyProposalCreateRequest,
  parseFeishuReplyProposalSnapshot,
  parseFeishuReplyProposalStatusSnapshot,
} from '../packages/web/dist/index.js'

const SNAPSHOT = Object.freeze({
  version: 1,
  disposition: 'created',
  approvalAvailable: false,
  executionAvailable: false,
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-preview',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'proposed',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-preview',
      identityType: 'user',
      displayName: 'Synthetic User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-preview',
      objectType: 'message',
      externalId: 'om_synthetic_preview_target',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact reply.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
})

test('Feishu reply preview browser contracts accept only exact minimized data', () => {
  assert.deepEqual(
    parseFeishuReplyProposalStatusSnapshot({
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    }),
    { version: 1, capability: 'ready', actionType: 'feishu.reply' },
  )
  assert.deepEqual(
    parseFeishuReplyProposalCreateRequest({
      version: 1,
      workItemId: 'work-item:synthetic-preview',
      draftRevision: 2,
    }),
    { version: 1, workItemId: 'work-item:synthetic-preview', draftRevision: 2 },
  )
  assert.deepEqual(parseFeishuReplyProposalSnapshot(SNAPSHOT), SNAPSHOT)
})

test('reply preview intent cannot select identity, target, content, approval, or execution', () => {
  for (const injected of [
    { identityType: 'bot' },
    { target: 'om_forged' },
    { content: 'forged' },
    { approved: true },
    { execute: true },
  ]) {
    assert.throws(
      () =>
        parseFeishuReplyProposalCreateRequest({
          version: 1,
          workItemId: 'work-item:synthetic-preview',
          draftRevision: 2,
          ...injected,
        }),
      /invalid/u,
    )
  }
  assert.throws(
    () =>
      parseFeishuReplyProposalSnapshot({
        ...SNAPSHOT,
        approvalAvailable: true,
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyProposalSnapshot({
        ...SNAPSHOT,
        proposal: {
          ...SNAPSHOT.proposal,
          identity: { ...SNAPSHOT.proposal.identity, identityType: 'bot' },
        },
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyProposalSnapshot({
        ...SNAPSHOT,
        proposal: {
          ...SNAPSHOT.proposal,
          target: { ...SNAPSHOT.proposal.target, accountId: 'another-account' },
        },
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyProposalSnapshot({
        ...SNAPSHOT,
        proposal: {
          ...SNAPSHOT.proposal,
          content: { mediaType: 'text/plain', text: 'Synthetic\u0000reply.' },
        },
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseFeishuReplyProposalSnapshot({
        ...SNAPSHOT,
        proposal: {
          ...SNAPSHOT.proposal,
          createdAt: '2026-09-02T08:59:59.999Z',
        },
      }),
    /invalid/u,
  )
})
