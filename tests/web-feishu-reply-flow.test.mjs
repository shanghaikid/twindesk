import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFeishuReplyFlowRequest,
  parseFeishuReplyFlowSnapshot,
  startTwinDeskWebServer,
} from '../packages/web/dist/index.js'

const WORK_ITEM_ID = 'work-item:synthetic-restored-flow'
const ACCOUNT_ID = 'feishu-account:synthetic-restored-flow'
const CONTENT = 'Synthetic durable content restored after refresh.'
const PROPOSAL = Object.freeze({
  workItemId: WORK_ITEM_ID,
  draftRevision: 2,
  actionType: 'feishu.reply',
  risk: 'write',
  state: 'succeeded',
  identity: Object.freeze({
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    identityType: 'user',
    displayName: 'Synthetic Restored User',
  }),
  target: Object.freeze({
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    objectType: 'message',
    externalId: 'om_synthetic_restored_target',
    sourceTimestamp: '2026-09-02T09:00:00.000Z',
  }),
  content: Object.freeze({ mediaType: 'text/plain', text: CONTENT }),
  createdAt: '2026-09-02T09:04:00.000Z',
})
const FLOW = Object.freeze({
  version: 1,
  stage: 'execution',
  draft: Object.freeze({
    version: 1,
    disposition: 'recovered',
    autonomy: 'draft_only',
    externalWritesAvailable: false,
    draft: Object.freeze({
      workItemId: WORK_ITEM_ID,
      personaLabel: 'Technical Lead',
      revision: 2,
      state: 'ready_for_review',
      content: Object.freeze({ mediaType: 'text/plain', text: CONTENT }),
      updatedAt: '2026-09-02T09:03:00.000Z',
    }),
  }),
  approval: Object.freeze({
    version: 1,
    operation: 'decision',
    disposition: 'recovered',
    executionAvailable: false,
    approval: Object.freeze({
      decision: 'approved',
      requestedAt: '2026-09-02T09:05:00.000Z',
      expiresAt: '2026-09-02T09:20:00.000Z',
      decidedAt: '2026-09-02T09:06:00.000Z',
    }),
    proposal: PROPOSAL,
  }),
  execution: Object.freeze({
    version: 1,
    disposition: 'recovered',
    proposal: PROPOSAL,
    execution: Object.freeze({
      outcome: 'succeeded',
      attemptedAt: '2026-09-02T09:07:00.000Z',
      externalReference: Object.freeze({
        connectorId: 'feishu',
        accountId: ACCOUNT_ID,
        objectType: 'message',
        externalId: 'om_synthetic_restored_result',
        sourceTimestamp: '2026-09-02T09:07:01.000Z',
      }),
    }),
  }),
})

test('reply flow contract restores only a consistently bound durable presentation', () => {
  assert.deepEqual(parseFeishuReplyFlowRequest({ version: 1, workItemId: WORK_ITEM_ID }), {
    version: 1,
    workItemId: WORK_ITEM_ID,
  })
  assert.deepEqual(parseFeishuReplyFlowSnapshot(FLOW), FLOW)
  assert.deepEqual(parseFeishuReplyFlowSnapshot({ version: 1, stage: 'empty' }), {
    version: 1,
    stage: 'empty',
  })
  assert.throws(() =>
    parseFeishuReplyFlowSnapshot({
      ...FLOW,
      execution: {
        ...FLOW.execution,
        proposal: { ...PROPOSAL, workItemId: 'work-item:forged' },
      },
    }),
  )
  assert.throws(() =>
    parseFeishuReplyFlowSnapshot({ ...FLOW, approvalId: 'browser-authority-injection' }),
  )
})

test('reply flow API reads one exact Work Item without mutation authority', async () => {
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyFlow: {
      async read(workItemId, signal) {
        signal.throwIfAborted()
        calls += 1
        assert.equal(workItemId, WORK_ITEM_ID)
        return FLOW
      },
    },
  })
  try {
    const response = await fetch(
      `${running.url}/api/action-flow/feishu-reply?workItemId=${encodeURIComponent(WORK_ITEM_ID)}`,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), FLOW)
    assert.equal(calls, 1)
    assert.equal((await fetch(`${running.url}/feishu-reply-flow-contract.js`)).status, 200)
    const app = await (await fetch(`${running.url}/app.js`)).text()
    assert.match(app, /Restoring the durable local action flow/u)

    assert.equal(
      (
        await fetch(
          `${running.url}/api/action-flow/feishu-reply?workItemId=${encodeURIComponent(WORK_ITEM_ID)}&workItemId=duplicate`,
        )
      ).status,
      400,
    )
    assert.equal(
      (await fetch(`${running.url}/api/action-flow/feishu-reply?proposalId=forged`)).status,
      400,
    )
    assert.equal(calls, 1)
  } finally {
    await running.close()
  }
})

test('Web shutdown cancels an active reply flow read', async () => {
  let aborted = false
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyFlow: {
      read(_workItemId, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('synthetic flow cancellation'))
            },
            { once: true },
          )
        })
      },
    },
  })
  const pending = fetch(
    `${running.url}/api/action-flow/feishu-reply?workItemId=${encodeURIComponent(WORK_ITEM_ID)}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  await running.close()
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(aborted, true)
})
