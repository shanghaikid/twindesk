import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

const BASE = Object.freeze({
  version: 1,
  disposition: 'applied',
  executionAvailable: false,
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-approval-api',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'awaiting_approval',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-approval-api',
      identityType: 'user',
      displayName: 'Synthetic Approval User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-approval-api',
      objectType: 'message',
      externalId: 'om_synthetic_approval_api',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact API approval.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
})

const REQUESTED = Object.freeze({
  ...BASE,
  operation: 'request',
  approval: Object.freeze({
    decision: 'pending',
    requestedAt: '2026-09-02T09:05:00.000Z',
    expiresAt: '2026-09-02T09:20:00.000Z',
  }),
})

const APPROVED = Object.freeze({
  ...BASE,
  operation: 'decision',
  approval: Object.freeze({
    decision: 'approved',
    requestedAt: '2026-09-02T09:05:00.000Z',
    expiresAt: '2026-09-02T09:20:00.000Z',
    decidedAt: '2026-09-02T09:06:00.000Z',
  }),
  proposal: Object.freeze({ ...BASE.proposal, state: 'approved' }),
})

test('reply approval API separates request from exact same-origin decision', async () => {
  let requestCalls = 0
  let decisionCalls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyApproval: {
      read() {
        return {
          version: 1,
          capability: 'ready',
          actionType: 'feishu.reply',
          ttlSeconds: 900,
        }
      },
      async request(input, signal) {
        signal.throwIfAborted()
        requestCalls += 1
        assert.deepEqual(input, {
          version: 1,
          workItemId: BASE.proposal.workItemId,
          draftRevision: 2,
        })
        return REQUESTED
      },
      async decide(input, signal) {
        signal.throwIfAborted()
        decisionCalls += 1
        assert.deepEqual(input, {
          version: 1,
          workItemId: BASE.proposal.workItemId,
          draftRevision: 2,
          decision: 'approved',
        })
        return APPROVED
      },
    },
  })
  try {
    const status = await fetch(`${running.url}/api/action-approvals/feishu-reply`)
    assert.equal(status.status, 200)
    const token = status.headers.get('x-twindesk-action-approval-csrf-token')
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/u)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    })
    assert.equal((await fetch(`${running.url}/feishu-reply-approval-contract.js`)).status, 200)
    const app = await (await fetch(`${running.url}/app.js`)).text()
    assert.match(app, /Request approval/u)
    assert.match(app, /Approve once/u)

    const headers = {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-action-approval-csrf-token': token ?? '',
    }
    const requestResponse = await fetch(
      `${running.url}/api/action-approvals/feishu-reply/request`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          workItemId: BASE.proposal.workItemId,
          draftRevision: 2,
        }),
      },
    )
    assert.equal(requestResponse.status, 200)
    assert.deepEqual(await requestResponse.json(), REQUESTED)

    const decisionResponse = await fetch(
      `${running.url}/api/action-approvals/feishu-reply/decide`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          workItemId: BASE.proposal.workItemId,
          draftRevision: 2,
          decision: 'approved',
        }),
      },
    )
    assert.equal(decisionResponse.status, 200)
    assert.deepEqual(await decisionResponse.json(), APPROVED)
    assert.equal(requestCalls, 1)
    assert.equal(decisionCalls, 1)

    const injected = await fetch(`${running.url}/api/action-approvals/feishu-reply/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        workItemId: BASE.proposal.workItemId,
        draftRevision: 2,
        decision: 'approved',
        responderUserId: 'attacker',
      }),
    })
    assert.equal(injected.status, 400)
    assert.equal(decisionCalls, 1)

    const forged = await fetch(`${running.url}/api/action-approvals/feishu-reply/request`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://127.0.0.1:9', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({
        version: 1,
        workItemId: BASE.proposal.workItemId,
        draftRevision: 2,
      }),
    })
    assert.equal(forged.status, 403)
    assert.equal(requestCalls, 1)
  } finally {
    await running.close()
  }
})

test('reply approval API advertises unavailable without a mutation token', async () => {
  const running = await startTwinDeskWebServer({ port: 0 })
  try {
    const status = await fetch(`${running.url}/api/action-approvals/feishu-reply`)
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('x-twindesk-action-approval-csrf-token'), null)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    })
  } finally {
    await running.close()
  }
})
