import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

/** @param {string} url @param {string} token */
function reconcileRequest(url, token) {
  return fetch(`${url}/api/recovery/feishu/oauth/reconcile`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-oauth-reconciliation': token,
    },
    body: JSON.stringify({ version: 1 }),
  })
}

test('the local API reconciles only from the exact durable recovery gate', async (context) => {
  let state = 'reconciliation_required'
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuOAuthRecovery: {
      read: () => ({ version: 1, connectorId: 'feishu', state }),
    },
    feishuOAuthReconciliation: {
      async reconcile(signal) {
        signal.throwIfAborted()
        calls += 1
        state = 'ready'
        return { version: 1, connectorId: 'feishu', status: 'reconciled' }
      },
    },
  })
  context.after(() => running.close())

  const recovery = await fetch(`${running.url}/api/recovery/feishu/oauth`)
  const token = recovery.headers.get('x-twindesk-oauth-reconciliation')
  if (token === null) assert.fail('The reconciliation capability is missing.')
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u)

  const forged = await reconcileRequest(running.url, 'invalid')
  assert.equal(forged.status, 403)
  assert.equal(calls, 0)

  const response = await reconcileRequest(running.url, token)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    version: 1,
    connectorId: 'feishu',
    status: 'reconciled',
  })
  assert.equal(calls, 1)
  assert.equal(response.headers.get('x-twindesk-oauth-reconciliation'), token)

  const replay = await reconcileRequest(running.url, token)
  assert.equal(replay.status, 409)
  assert.equal(calls, 1)
})

test('same local evidence remains blocked and shutdown cancels active reconciliation', async () => {
  let state = 'reconciliation_required'
  let observedAbort = false
  /** @type {() => void} */
  let started = () => assert.fail('Reconciliation start was not initialized.')
  /** @type {Promise<void>} */
  const didStart = new Promise((resolve) => {
    started = resolve
  })
  /** @type {() => void} */
  let release = () => assert.fail('Reconciliation release was not initialized.')
  /** @type {Promise<void>} */
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuOAuthRecovery: {
      read: () => ({ version: 1, connectorId: 'feishu', state }),
    },
    feishuOAuthReconciliation: {
      async reconcile(signal) {
        started()
        await Promise.race([
          waiting,
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                observedAbort = true
                resolve(undefined)
              },
              { once: true },
            )
          }),
        ])
        if (signal.aborted) signal.throwIfAborted()
        return { version: 1, connectorId: 'feishu', status: 'still_required' }
      },
    },
  })
  const recovery = await fetch(`${running.url}/api/recovery/feishu/oauth`)
  const token = recovery.headers.get('x-twindesk-oauth-reconciliation')
  assert.ok(token)
  const request = reconcileRequest(running.url, token).catch(() => undefined)
  await didStart
  await running.close()
  release()
  await request
  assert.equal(observedAbort, true)
  assert.equal(state, 'reconciliation_required')
})
