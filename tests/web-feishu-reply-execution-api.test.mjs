import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

const RESULT = Object.freeze({
  version: 1,
  disposition: 'executed',
  proposal: Object.freeze({
    workItemId: 'work-item:synthetic-execution-api',
    draftRevision: 2,
    actionType: 'feishu.reply',
    risk: 'write',
    state: 'succeeded',
    identity: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-api',
      identityType: 'user',
      displayName: 'Synthetic Execution User',
    }),
    target: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-api',
      objectType: 'message',
      externalId: 'om_synthetic_execution_api_target',
      sourceTimestamp: '2026-09-02T09:00:00.000Z',
    }),
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic exact API execution.' }),
    createdAt: '2026-09-02T09:04:00.000Z',
  }),
  execution: Object.freeze({
    outcome: 'succeeded',
    attemptedAt: '2026-09-02T09:06:00.000Z',
    externalReference: Object.freeze({
      connectorId: 'feishu',
      accountId: 'feishu-account:synthetic-execution-api',
      objectType: 'message',
      externalId: 'om_synthetic_execution_api_result',
      sourceTimestamp: '2026-09-02T09:06:01.000Z',
    }),
  }),
})

test('reply execution API binds a separate exact same-origin external-write intent', async () => {
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyExecution: {
      read() {
        return { version: 1, capability: 'ready', actionType: 'feishu.reply' }
      },
      async execute(input, signal) {
        signal.throwIfAborted()
        calls += 1
        assert.deepEqual(input, {
          version: 1,
          workItemId: RESULT.proposal.workItemId,
          draftRevision: 2,
        })
        return RESULT
      },
    },
  })
  try {
    const status = await fetch(`${running.url}/api/action-executions/feishu-reply`)
    assert.equal(status.status, 200)
    const token = status.headers.get('x-twindesk-action-execution-csrf-token')
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/u)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    })
    assert.equal((await fetch(`${running.url}/feishu-reply-execution-contract.js`)).status, 200)
    const app = await (await fetch(`${running.url}/app.js`)).text()
    assert.match(app, /Send approved reply/u)
    assert.match(app, /This click performs the external write/u)

    const headers = {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-action-execution-csrf-token': token ?? '',
    }
    const response = await fetch(`${running.url}/api/action-executions/feishu-reply/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: 2,
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), RESULT)
    assert.equal(calls, 1)

    const forged = await fetch(`${running.url}/api/action-executions/feishu-reply/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: 2,
        proposalId: 'forged',
      }),
    })
    assert.equal(forged.status, 400)
    assert.equal(calls, 1)

    const crossOrigin = await fetch(`${running.url}/api/action-executions/feishu-reply/execute`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://127.0.0.1:9', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.proposal.workItemId,
        draftRevision: 2,
      }),
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(calls, 1)
  } finally {
    await running.close()
  }
})

test('reply execution API advertises unavailable without an external-write token', async () => {
  const running = await startTwinDeskWebServer({ port: 0 })
  try {
    const status = await fetch(`${running.url}/api/action-executions/feishu-reply`)
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('x-twindesk-action-execution-csrf-token'), null)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
    })
  } finally {
    await running.close()
  }
})

test('Web shutdown cancels an active reply execution request', async () => {
  let aborted = false
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuReplyExecution: {
      read() {
        return { version: 1, capability: 'ready', actionType: 'feishu.reply' }
      },
      execute(_input, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('synthetic execution cancellation'))
            },
            { once: true },
          )
        })
      },
    },
  })
  const status = await fetch(`${running.url}/api/action-executions/feishu-reply`)
  const token = status.headers.get('x-twindesk-action-execution-csrf-token')
  const pending = fetch(`${running.url}/api/action-executions/feishu-reply/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-action-execution-csrf-token': token ?? '',
    },
    body: JSON.stringify({
      version: 1,
      workItemId: RESULT.proposal.workItemId,
      draftRevision: 2,
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await running.close()
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(aborted, true)
})
