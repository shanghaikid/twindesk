import assert from 'node:assert/strict'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/server.js'

const DIAGNOSTICS = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  status: 'healthy',
  checkedAt: '2026-09-03T08:00:00.000Z',
  runtime: { version: 1, state: 'running' },
  identities: [
    {
      identityType: 'user',
      status: 'ready',
      requiredScopes: [
        'im:chat:read',
        'im:message:readonly',
        'im:message:send_as_user',
        'search:message',
      ],
      missingScopes: [],
    },
  ],
  rateLimits: [{ identityType: 'user', status: 'unknown' }],
  cursors: [{ stream: 'user_visible_messages', status: 'not_started' }],
  issues: [],
})

test('the loopback diagnostics API and Connectors UI expose only the minimized contract', async (context) => {
  let reads = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuDiagnostics: {
      async read(signal) {
        signal.throwIfAborted()
        reads += 1
        return DIAGNOSTICS
      },
    },
  })
  context.after(() => running.close())

  const response = await fetch(`${running.url}/api/diagnostics/feishu`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), DIAGNOSTICS)
  assert.equal(reads, 1)

  const head = await fetch(`${running.url}/api/diagnostics/feishu`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(reads, 2)
  assert.equal((await fetch(`${running.url}/api/diagnostics/feishu?raw=true`)).status, 400)
  assert.equal(
    (await fetch(`${running.url}/api/diagnostics/feishu`, { method: 'POST' })).status,
    405,
  )

  const contract = await fetch(`${running.url}/feishu-diagnostics-contract.js`)
  assert.equal(contract.status, 200)
  const app = await (await fetch(`${running.url}/app.js`)).text()
  assert.match(app, /\/api\/diagnostics\/feishu/u)
  assert.match(app, /Connector diagnostics/u)
  assert.match(app, /data-feishu-diagnostics-retry/u)
  assert.doesNotMatch(app, /synthetic-private-diagnostic/u)
})

test('invalid diagnostics fail closed without echoing private adapter values', async (context) => {
  const privateValue = 'synthetic-private-diagnostic-token'
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuDiagnostics: {
      async read() {
        return { ...DIAGNOSTICS, accessToken: privateValue }
      },
    },
  })
  context.after(() => running.close())
  const response = await fetch(`${running.url}/api/diagnostics/feishu`)
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes(privateValue), false)
})

test('server shutdown cancels an active diagnostics probe', async () => {
  /** @type {(() => void) | undefined} */
  let resolveStarted
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })
  let observedAbort = false
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuDiagnostics: {
      read(signal) {
        resolveStarted?.()
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    },
  })
  const request = fetch(`${running.url}/api/diagnostics/feishu`).catch(() => undefined)
  await started
  await running.close()
  await request
  assert.equal(observedAbort, true)
})

test('client disconnect cancels an active diagnostics probe', async (context) => {
  /** @type {(() => void) | undefined} */
  let resolveStarted
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })
  /** @type {(() => void) | undefined} */
  let resolveAborted
  /** @type {Promise<void>} */
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve
  })
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuDiagnostics: {
      read(signal) {
        resolveStarted?.()
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              resolveAborted?.()
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    },
  })
  context.after(() => running.close())
  const controller = new AbortController()
  const request = fetch(`${running.url}/api/diagnostics/feishu`, {
    signal: controller.signal,
  }).catch(() => undefined)
  await started
  controller.abort()
  await Promise.race([
    aborted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Diagnostics probe did not observe disconnect.')), 1_000),
    ),
  ])
  await request
})
