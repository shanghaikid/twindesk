import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

const RESULT = Object.freeze({
  version: 1,
  disposition: 'created',
  approvalAvailable: false,
  executionAvailable: false,
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-preview-api',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'proposed',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-preview-api',
      identityType: 'user',
      displayName: 'Synthetic Preview User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-preview-api',
      objectType: 'message',
      externalId: 'om_synthetic_preview_api_target',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact API reply.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
})

test('reply preview API binds one Draft revision intent to same-origin CSRF', async () => {
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyProposal: {
      read() {
        return { version: 1, capability: 'ready', actionType: 'feishu.reply' }
      },
      async create(request, signal) {
        signal.throwIfAborted()
        calls += 1
        assert.deepEqual(request, {
          version: 1,
          workItemId: RESULT.proposal.workItemId,
          draftRevision: RESULT.proposal.draftRevision,
        })
        return RESULT
      },
    },
  })
  try {
    const status = await fetch(`${running.url}/api/action-proposals/feishu-reply`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    })
    const token = status.headers.get('x-twindesk-action-proposal-csrf-token')
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/u)
    assert.ok(token !== null)
    const app = await fetch(`${running.url}/app.js`)
    const appSource = await app.text()
    assert.match(appSource, /Create exact preview/u)
    assert.match(appSource, /\/api\/action-proposals\/feishu-reply\/create/u)
    assert.equal((await fetch(`${running.url}/feishu-reply-proposal-contract.js`)).status, 200)

    const response = await fetch(`${running.url}/api/action-proposals/feishu-reply/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-action-proposal-csrf-token': token,
      },
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: RESULT.proposal.draftRevision,
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), RESULT)
    assert.equal(calls, 1)

    const injected = await fetch(`${running.url}/api/action-proposals/feishu-reply/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-action-proposal-csrf-token': token,
      },
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: RESULT.proposal.draftRevision,
        approved: true,
      }),
    })
    assert.equal(injected.status, 400)
    assert.equal(calls, 1)

    const forged = await fetch(`${running.url}/api/action-proposals/feishu-reply/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:9',
        'sec-fetch-site': 'cross-site',
        'x-twindesk-action-proposal-csrf-token': token,
      },
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: RESULT.proposal.draftRevision,
      }),
    })
    assert.equal(forged.status, 403)
    assert.equal(calls, 1)
  } finally {
    await running.close()
  }
})

test('reply preview API advertises unavailable without exposing a mutation token', async () => {
  const running = await startTwinDeskWebServer({ port: 0 })
  try {
    const status = await fetch(`${running.url}/api/action-proposals/feishu-reply`)
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('x-twindesk-action-proposal-csrf-token'), null)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
    })
  } finally {
    await running.close()
  }
})

test('Web shutdown cancels an active reply preview request', async () => {
  /** @type {(value?: unknown) => void} */
  let enteredResolve = () => {}
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  let observedAbort = false
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyProposal: {
      read() {
        return { version: 1, capability: 'ready', actionType: 'feishu.reply' }
      },
      create(_request, signal) {
        enteredResolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              reject(new Error('synthetic-private-preview-cancellation'))
            },
            { once: true },
          )
        })
      },
    },
  })
  const status = await fetch(`${running.url}/api/action-proposals/feishu-reply`)
  const token = status.headers.get('x-twindesk-action-proposal-csrf-token')
  assert.ok(token !== null)
  const pending = fetch(`${running.url}/api/action-proposals/feishu-reply/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-action-proposal-csrf-token': token,
    },
    body: JSON.stringify({
      version: 1,
      workItemId: RESULT.proposal.workItemId,
      draftRevision: RESULT.proposal.draftRevision,
    }),
  })
  await entered
  await running.close()
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(observedAbort, true)
  assert.doesNotMatch(await response.text(), /synthetic-private/u)
})
