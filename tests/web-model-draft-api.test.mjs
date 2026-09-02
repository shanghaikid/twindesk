import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

const RESULT = Object.freeze({
  version: 1,
  disposition: 'created',
  autonomy: 'draft_only',
  externalWritesAvailable: false,
  draft: Object.freeze({
    workItemId: 'fixture-work-item-release-risk-question',
    personaLabel: 'Communication',
    revision: 1,
    state: 'editing',
    content: Object.freeze({ mediaType: 'text/plain', text: 'Synthetic local model Draft.' }),
    updatedAt: '2026-09-02T09:01:00.000Z',
  }),
})

test('model Draft API binds one Work Item-only intent to same-origin CSRF', async () => {
  let calls = 0
  /** @type {unknown} */
  let observedWorkItemId
  const running = await startTwinDeskWebServer({
    port: 0,
    modelDraft: {
      read() {
        return { version: 1, capability: 'ready', autonomy: 'draft_only' }
      },
      async create(workItemId, signal) {
        signal.throwIfAborted()
        calls += 1
        observedWorkItemId = workItemId
        return RESULT
      },
    },
  })
  try {
    const status = await fetch(`${running.url}/api/model-drafts`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      autonomy: 'draft_only',
    })
    const token = status.headers.get('x-twindesk-model-draft-csrf-token')
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/u)
    assert.ok(token !== null)

    const response = await fetch(`${running.url}/api/model-drafts/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-model-draft-csrf-token': token,
      },
      body: JSON.stringify({ version: 1, workItemId: RESULT.draft.workItemId }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), RESULT)
    assert.equal(observedWorkItemId, RESULT.draft.workItemId)
    assert.equal(calls, 1)

    const injection = await fetch(`${running.url}/api/model-drafts/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-model-draft-csrf-token': token,
      },
      body: JSON.stringify({
        version: 1,
        workItemId: RESULT.draft.workItemId,
        provider: 'browser-provider',
      }),
    })
    assert.equal(injection.status, 400)
    assert.equal(calls, 1)

    const forged = await fetch(`${running.url}/api/model-drafts/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:9',
        'sec-fetch-site': 'cross-site',
        'x-twindesk-model-draft-csrf-token': token,
      },
      body: JSON.stringify({ version: 1, workItemId: RESULT.draft.workItemId }),
    })
    assert.equal(forged.status, 403)
    assert.equal(calls, 1)
  } finally {
    await running.close()
  }
})

test('model Draft API advertises unavailable without exposing a mutation token', async () => {
  const running = await startTwinDeskWebServer({ port: 0 })
  try {
    const status = await fetch(`${running.url}/api/model-drafts`)
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('x-twindesk-model-draft-csrf-token'), null)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'unavailable',
      autonomy: 'draft_only',
    })
    assert.equal(
      (await fetch(`${running.url}/api/model-drafts/create`, { method: 'GET' })).status,
      404,
    )
  } finally {
    await running.close()
  }
})

test('Web shutdown cancels an active model Draft request', async () => {
  /** @type {(value?: unknown) => void} */
  let enteredResolve = () => {}
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  let observedAbort = false
  const running = await startTwinDeskWebServer({
    port: 0,
    modelDraft: {
      read() {
        return { version: 1, capability: 'ready', autonomy: 'draft_only' }
      },
      create(_workItemId, signal) {
        enteredResolve()
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              reject(new Error('synthetic-private-cancellation'))
            },
            { once: true },
          )
        })
      },
    },
  })
  const status = await fetch(`${running.url}/api/model-drafts`)
  const token = status.headers.get('x-twindesk-model-draft-csrf-token')
  assert.ok(token !== null)
  const pending = fetch(`${running.url}/api/model-drafts/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-model-draft-csrf-token': token,
    },
    body: JSON.stringify({ version: 1, workItemId: RESULT.draft.workItemId }),
  })
  await entered
  await running.close()
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(observedAbort, true)
  assert.doesNotMatch(await response.text(), /synthetic-private/u)
})
