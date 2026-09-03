import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectWorkbenchStage2LiveReadiness } from '../packages/bundle-workbench/dist/index.js'
import { startTwinDeskWebServer } from '../packages/web/dist/index.js'

const SETTINGS = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  state: 'ready',
  identities: ['bot', 'user'],
  oauth: {
    redirectHost: '127.0.0.1',
    redirectPort: 43123,
    scopes: ['offline_access'],
    appMatchesIdentity: true,
  },
})

const DIAGNOSTICS = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  status: 'healthy',
  checkedAt: '2026-09-03T08:00:00.000Z',
  runtime: { version: 1, state: 'running' },
  identities: [
    {
      identityType: 'bot',
      status: 'ready',
      requiredScopes: ['im:message:send_as_bot'],
      missingScopes: [],
    },
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
  rateLimits: [
    { identityType: 'bot', status: 'unknown' },
    { identityType: 'user', status: 'unknown' },
  ],
  cursors: [
    {
      stream: 'user_visible_messages',
      status: 'current',
      updatedAt: '2026-09-03T07:59:00.000Z',
      committedThrough: '2026-09-03T07:58:00.000Z',
    },
  ],
  issues: [],
})

test('Stage 2 readiness verifies every local prerequisite without claiming live proof', async (context) => {
  let botProbeCalls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuSettings: { read: async () => SETTINGS },
    feishuOAuthRecovery: {
      read: async () => ({ version: 1, connectorId: 'feishu', state: 'ready' }),
    },
    feishuDiagnostics: { read: async () => DIAGNOSTICS },
    modelDraft: {
      read: async () => ({ version: 1, capability: 'ready', autonomy: 'draft_only' }),
      create: async () => {
        throw new Error('The readiness check must not create a Draft.')
      },
    },
    feishuBotEvents: {
      async consume() {
        botProbeCalls += 1
        return { version: 1, disposition: 'rejected' }
      },
    },
  })
  context.after(() => running.close())

  const report = await inspectWorkbenchStage2LiveReadiness(
    running.url,
    new AbortController().signal,
  )

  assert.equal(report.status, 'ready_for_live_steps')
  assert.equal(report.checks.length, 5)
  assert.equal(
    report.checks.every(({ status }) => status === 'ready'),
    true,
  )
  assert.equal(botProbeCalls, 1)
  assert.deepEqual(report.limitations, [
    'public_bot_delivery_unverified',
    'provider_credentials_unverified',
    'live_user_polling_unverified',
    'external_send_unverified',
  ])
  assert.equal(Object.isFrozen(report), true)
  assert.equal(Object.isFrozen(report.checks), true)
})

test('Stage 2 readiness returns fixed attention states without exposing Host failures', async (context) => {
  const privateValue = 'synthetic-private-readiness-value'
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuSettings: {
      async read() {
        throw new Error(privateValue)
      },
    },
    feishuDiagnostics: {
      async read() {
        throw new Error(privateValue)
      },
    },
  })
  context.after(() => running.close())

  const report = await inspectWorkbenchStage2LiveReadiness(
    running.url,
    new AbortController().signal,
  )
  assert.equal(report.status, 'attention_required')
  assert.equal(
    report.checks.every(({ status }) => status === 'attention_required'),
    true,
  )
  assert.equal(JSON.stringify(report).includes(privateValue), false)
})

test('Stage 2 readiness rejects non-loopback origins, hostile options, and cancellation', async () => {
  let fetchCalls = 0
  const fetchImplementation = async () => {
    fetchCalls += 1
    return new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '2',
      },
    })
  }
  await assert.rejects(
    inspectWorkbenchStage2LiveReadiness('https://example.com:443', new AbortController().signal, {
      fetch: fetchImplementation,
    }),
    /request is invalid/u,
  )
  let accessed = false
  await assert.rejects(
    inspectWorkbenchStage2LiveReadiness(
      'http://127.0.0.1:4173',
      new AbortController().signal,
      Object.defineProperty({}, 'fetch', {
        enumerable: true,
        get() {
          accessed = true
          return fetchImplementation
        },
      }),
    ),
    /request is invalid/u,
  )
  assert.equal(accessed, false)
  assert.equal(fetchCalls, 0)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    inspectWorkbenchStage2LiveReadiness('http://127.0.0.1:4173', controller.signal, {
      fetch: fetchImplementation,
    }),
  )
  assert.equal(fetchCalls, 0)
})

test('Stage 2 readiness bounds a Fetch implementation that ignores cancellation', async () => {
  let calls = 0
  const report = await inspectWorkbenchStage2LiveReadiness(
    'http://127.0.0.1:4173',
    new AbortController().signal,
    {
      timeoutMs: 100,
      fetch() {
        calls += 1
        return new Promise(() => undefined)
      },
    },
  )
  assert.equal(calls, 5)
  assert.equal(report.status, 'attention_required')
  assert.equal(
    report.checks.every(({ detail }) => detail.endsWith('unavailable')),
    true,
  )
})

test('Stage 2 readiness rejects oversized and malformed local responses', async () => {
  for (const responseKind of ['oversized', 'malformed']) {
    let calls = 0
    const report = await inspectWorkbenchStage2LiveReadiness(
      'http://127.0.0.1:4173',
      new AbortController().signal,
      {
        fetch(url) {
          calls += 1
          if (String(url).endsWith('/api/connectors/feishu/bot/events')) {
            return Promise.resolve(new Response('', { status: 503 }))
          }
          const body = responseKind === 'malformed' ? '{' : '{}'
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'content-length':
                  responseKind === 'oversized' ? String(64 * 1024 + 1) : String(body.length),
              },
            }),
          )
        },
      },
    )
    assert.equal(calls, 5)
    assert.equal(report.status, 'attention_required')
    assert.equal(
      report.checks.every(({ status }) => status === 'attention_required'),
      true,
    )
  }
})
