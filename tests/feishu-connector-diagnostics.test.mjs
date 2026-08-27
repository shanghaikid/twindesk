import assert from 'node:assert/strict'
import test from 'node:test'

import { parseConnectorCursor } from '../packages/domain/dist/index.js'
import {
  FEISHU_USER_MESSAGE_STREAM,
  FeishuConnectorDiagnosticsService,
  FeishuDiagnosticsClientError,
} from '../packages/plugin-feishu/dist/index.js'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')
const ACCOUNT_ID = 'feishu-account:synthetic-diagnostics'
const APP_ID = 'cli_synthetic_diagnostics'
const BOT_PRINCIPAL = 'ou_synthetic_diagnostics_bot'
const USER_PRINCIPAL = 'ou_synthetic_diagnostics_user'

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Diagnostics Bot',
      principalId: BOT_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-diagnostics-bot',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
    user: {
      identityType: 'user',
      displayName: 'Synthetic Diagnostics User',
      principalId: USER_PRINCIPAL,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-diagnostics-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/**
 * @param {'bot' | 'user'} identityType
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function identityObservation(identityType, overrides = {}) {
  const isBot = identityType === 'bot'
  const scope = isBot ? 'im:message:send_as_bot' : 'im:message:send_as_user'
  return {
    kind: 'feishu_identity_probe_result',
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    identityType,
    principalId: isBot ? BOT_PRINCIPAL : USER_PRINCIPAL,
    authorization: 'authorized',
    requiredScopes: [scope],
    grantedScopes: [scope],
    rateLimit: {
      status: 'available',
      limit: 100,
      remaining: 80,
      resetsAt: '2026-08-27T08:01:00.000Z',
    },
    ...overrides,
  }
}

/** @param {string} updatedAt */
function cursor(updatedAt) {
  return parseConnectorCursor({
    kind: 'connector_cursor',
    schemaVersion: 1,
    id: 'cursor:feishu:synthetic-diagnostics:user-visible-messages',
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    stream: FEISHU_USER_MESSAGE_STREAM,
    position: 'synthetic-private-opaque-cursor-position',
    committedThrough: '2026-08-27T07:58:00.000Z',
    updatedAt,
  })
}

/**
 * @param {{
 *   observations?: Partial<Record<'bot' | 'user', unknown>>,
 *   identityErrors?: Partial<Record<'bot' | 'user', import('../packages/plugin-feishu/src/connector-diagnostics.ts').FeishuDiagnosticsClientErrorCode>>,
 *   cursors?: readonly unknown[],
 *   cursorResponse?: unknown,
 *   cursorError?: import('../packages/plugin-feishu/src/connector-diagnostics.ts').FeishuDiagnosticsClientErrorCode,
 * }} [options]
 * @returns {import('../packages/plugin-feishu/src/connector-diagnostics.ts').FeishuConnectorDiagnosticsClient & {
 *   diagnostics(): { identityCalls: number, cursorCalls: number }
 * }}
 */
function client(options = {}) {
  let identityCalls = 0
  let cursorCalls = 0
  return {
    async inspectIdentity(request, signal) {
      signal.throwIfAborted()
      identityCalls += 1
      const error = options.identityErrors?.[request.identityType]
      if (error !== undefined) throw new FeishuDiagnosticsClientError(error)
      return (
        options.observations?.[request.identityType] ?? identityObservation(request.identityType)
      )
    },
    async readCursors(request, signal) {
      signal.throwIfAborted()
      cursorCalls += 1
      if (options.cursorError !== undefined) {
        throw new FeishuDiagnosticsClientError(options.cursorError)
      }
      return (
        options.cursorResponse ?? {
          kind: 'feishu_cursor_probe_result',
          schemaVersion: 1,
          connectorId: request.connectorId,
          accountId: request.accountId,
          cursors: options.cursors ?? [],
        }
      )
    },
    diagnostics() {
      return { identityCalls, cursorCalls }
    },
  }
}

test('healthy diagnostics expose scope, rate, and cursor state without opaque values', async () => {
  const adapter = client({ cursors: [cursor('2026-08-27T07:59:00.000Z')] })
  const diagnostics = await new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  }).diagnose(new AbortController().signal)

  assert.equal(diagnostics.health.status, 'healthy')
  assert.equal(diagnostics.health.checkedAt, '2026-08-27T08:00:00.000Z')
  assert.deepEqual(
    diagnostics.health.identities.map((identity) => [
      identity.identityType,
      identity.missingScopes,
    ]),
    [
      ['bot', []],
      ['user', []],
    ],
  )
  assert.deepEqual(
    diagnostics.rateLimits.map((rate) => [rate.identityType, rate.status]),
    [
      ['bot', 'available'],
      ['user', 'available'],
    ],
  )
  assert.deepEqual(diagnostics.cursors, [
    {
      stream: FEISHU_USER_MESSAGE_STREAM,
      status: 'current',
      updatedAt: '2026-08-27T07:59:00.000Z',
      committedThrough: '2026-08-27T07:58:00.000Z',
    },
  ])
  const serialized = JSON.stringify(diagnostics)
  assert.equal(serialized.includes('synthetic-private-opaque-cursor-position'), false)
  assert.equal(serialized.includes('secret-ref:synthetic-diagnostics'), false)
  assert.equal(serialized.includes(BOT_PRINCIPAL), false)
  assert.deepEqual(adapter.diagnostics(), { identityCalls: 2, cursorCalls: 1 })
})

test('missing scope, rate limiting, and stale cursors degrade one available identity', async () => {
  const adapter = client({
    observations: {
      bot: identityObservation('bot', {
        requiredScopes: ['im:message:send_as_bot', 'im:message:readonly'],
        grantedScopes: ['im:message:send_as_bot'],
        rateLimit: { status: 'limited', resetsAt: '2026-08-27T08:02:00.000Z' },
      }),
      user: identityObservation('user', { authorization: 'not_authorized', grantedScopes: [] }),
    },
    cursors: [cursor('2026-08-27T07:30:00.000Z')],
  })
  const diagnostics = await new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  }).diagnose(new AbortController().signal)

  assert.equal(diagnostics.health.status, 'degraded')
  assert.deepEqual(diagnostics.health.identities[0]?.missingScopes, ['im:message:readonly'])
  assert.deepEqual(
    diagnostics.health.issues.map((entry) => entry.code),
    [
      'bot_scope_missing',
      'bot_rate_limited',
      'user_identity_not_authorized',
      'user_scope_missing',
      'cursor_stale',
    ],
  )
  assert.equal(diagnostics.cursors[0]?.status, 'stale')
  assert.equal(diagnostics.rateLimits[0]?.status, 'limited')
})

test('unavailable identity and cursor probes produce bounded diagnostics instead of payloads', async () => {
  const adapter = client({
    identityErrors: { bot: 'network', user: 'not_authorized' },
    cursorError: 'storage_unavailable',
  })
  const diagnostics = await new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  }).diagnose(new AbortController().signal)

  assert.equal(diagnostics.health.status, 'unavailable')
  assert.deepEqual(
    diagnostics.health.issues.map((entry) => entry.code),
    ['bot_identity_network', 'user_identity_not_authorized', 'cursor_storage_unavailable'],
  )
  assert.equal(diagnostics.cursors[0]?.status, 'unavailable')
  assert.deepEqual(
    diagnostics.rateLimits.map((entry) => entry.status),
    ['unknown', 'unknown'],
  )
  assert.equal(JSON.stringify(diagnostics).includes('credential'), false)
})

test('identity and cursor storage failures remain separately attributable', async () => {
  const diagnostics = await new FeishuConnectorDiagnosticsService(
    configuration(),
    client({
      identityErrors: { bot: 'storage_unavailable', user: 'network' },
      cursorError: 'storage_unavailable',
    }),
    { now: () => NOW },
  ).diagnose(new AbortController().signal)

  assert.equal(diagnostics.health.status, 'unavailable')
  assert.deepEqual(
    diagnostics.health.issues.map((entry) => entry.code),
    ['bot_identity_storage_unavailable', 'user_identity_network', 'cursor_storage_unavailable'],
  )
})

test('hostile and identity-mismatched probe data fail closed without evaluating values', async () => {
  let accessed = false
  let cursorAccessed = false
  const hostile = Object.defineProperty(identityObservation('bot'), 'grantedScopes', {
    enumerable: true,
    get() {
      accessed = true
      return ['synthetic-private-scope']
    },
  })
  /** @type {unknown[]} */
  const hostileCursors = []
  Object.defineProperty(hostileCursors, '0', {
    enumerable: true,
    get() {
      cursorAccessed = true
      return 'synthetic-private-cursor-value'
    },
  })
  const adapter = client({
    observations: {
      bot: hostile,
      user: identityObservation('user', { principalId: 'ou_mismatched_private_principal' }),
    },
    cursorResponse: {
      kind: 'feishu_cursor_probe_result',
      schemaVersion: 1,
      connectorId: 'feishu',
      accountId: ACCOUNT_ID,
      cursors: hostileCursors,
    },
  })
  const diagnostics = await new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  }).diagnose(new AbortController().signal)

  assert.equal(accessed, false)
  assert.equal(cursorAccessed, false)
  assert.equal(diagnostics.health.status, 'unavailable')
  assert.deepEqual(
    diagnostics.health.issues.map((entry) => entry.code),
    ['bot_identity_invalid_response', 'user_identity_invalid_response', 'cursor_invalid_response'],
  )
  assert.equal(diagnostics.cursors[0]?.status, 'unavailable')
  assert.equal(JSON.stringify(diagnostics).includes('synthetic-private'), false)
  assert.equal(JSON.stringify(diagnostics).includes('ou_mismatched_private_principal'), false)
})

test('zero remaining capacity is normalized to an active rate limit', async () => {
  const adapter = client({
    observations: {
      bot: identityObservation('bot', {
        rateLimit: {
          status: 'available',
          limit: 100,
          remaining: 0,
          resetsAt: '2026-08-27T08:01:00.000Z',
        },
      }),
    },
    cursors: [cursor('2026-08-27T07:59:00.000Z')],
  })
  const diagnostics = await new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  }).diagnose(new AbortController().signal)
  assert.equal(diagnostics.health.status, 'degraded')
  assert.equal(diagnostics.rateLimits[0]?.status, 'limited')
  assert.equal(diagnostics.health.issues[0]?.code, 'bot_rate_limited')
})

test('future and not-started cursors remain explicit without exposing positions', async () => {
  const future = await new FeishuConnectorDiagnosticsService(
    configuration(),
    client({ cursors: [cursor('2026-08-27T08:06:00.000Z')] }),
    { now: () => NOW },
  ).diagnose(new AbortController().signal)
  assert.equal(future.health.status, 'degraded')
  assert.equal(future.cursors[0]?.status, 'future')
  assert.equal(future.health.issues[0]?.code, 'cursor_in_future')
  assert.equal(JSON.stringify(future).includes('synthetic-private-opaque-cursor-position'), false)

  const notStarted = await new FeishuConnectorDiagnosticsService(configuration(), client(), {
    now: () => NOW,
  }).diagnose(new AbortController().signal)
  assert.equal(notStarted.health.status, 'healthy')
  assert.deepEqual(notStarted.cursors, [
    { stream: FEISHU_USER_MESSAGE_STREAM, status: 'not_started' },
  ])
})

test('an empty cursor stream policy fails before client access', () => {
  const adapter = client()
  assert.throws(
    () =>
      new FeishuConnectorDiagnosticsService(configuration(), adapter, {
        now: () => NOW,
        streams: [],
      }),
    { code: 'invalid_configuration' },
  )
  assert.deepEqual(adapter.diagnostics(), { identityCalls: 0, cursorCalls: 0 })
})

test('diagnostics observe cancellation before probing any identity or cursor', async () => {
  const adapter = client()
  const service = new FeishuConnectorDiagnosticsService(configuration(), adapter, {
    now: () => NOW,
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.diagnose(controller.signal), { name: 'AbortError' })
  await assert.rejects(service.health(controller.signal), { name: 'AbortError' })
  assert.deepEqual(adapter.diagnostics(), { identityCalls: 0, cursorCalls: 0 })
})
