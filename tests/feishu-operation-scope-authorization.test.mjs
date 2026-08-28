import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_SCOPE_OBSERVATION_MAX_AGE_MS,
  FeishuOperationScopeAuthorizationError,
  FeishuOperationScopeAuthorizer,
  FeishuOperationScopeProbeClientError,
  requiredFeishuOperationScopes,
} from '../packages/plugin-feishu/dist/index.js'

const APP_ID = 'cli_synthetic_scope_authorization'
const ACCOUNT_ID = 'feishu-account:synthetic-scope-authorization'
const BOT_PRINCIPAL_ID = 'bot_synthetic_scope_authorization'
const USER_PRINCIPAL_ID = 'ou_synthetic_scope_authorization'
const NOW = Date.parse('2026-08-28T15:00:00.000Z')
const OBSERVED_AT = new Date(NOW).toISOString()

/** @typedef {import('../packages/plugin-feishu/dist/index.js').FeishuOperationScopeProbeRequest} FeishuOperationScopeProbeRequest */
/** @typedef {import('../packages/plugin-feishu/dist/index.js').FeishuOperationScopeProbeClient} FeishuOperationScopeProbeClient */
/** @typedef {import('../packages/plugin-feishu/dist/index.js').FeishuOperationScopeAuthorizer} FeishuOperationScopeAuthorizerType */
/** @typedef {import('../packages/plugin-feishu/dist/index.js').FeishuScopedOperation} FeishuScopedOperation */

/** @param {{bot?: boolean, user?: boolean}} [options] */
function configuration({ bot = true, user = true } = {}) {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    ...(bot
      ? {
          bot: {
            identityType: 'bot',
            displayName: 'Synthetic Scope Bot',
            principalId: BOT_PRINCIPAL_ID,
            credentialReference: {
              kind: 'secret_reference',
              schemaVersion: 1,
              id: 'secret-ref:synthetic-scope-bot',
              store: 'system_keychain',
              purpose: 'connector_app_credential',
            },
          },
        }
      : {}),
    ...(user
      ? {
          user: {
            identityType: 'user',
            displayName: 'Synthetic Scope User',
            principalId: USER_PRINCIPAL_ID,
            credentialReference: {
              kind: 'secret_reference',
              schemaVersion: 1,
              id: 'secret-ref:synthetic-scope-user',
              store: 'system_keychain',
              purpose: 'connector_oauth',
            },
          },
        }
      : {}),
  }
}

/** @param {FeishuOperationScopeProbeRequest} request @param {Record<string, unknown>} [changes] */
function result(request, changes = {}) {
  return {
    kind: 'feishu_operation_scope_probe_result',
    schemaVersion: 1,
    accountId: request.accountId,
    appId: request.appId,
    identityType: request.identityType,
    principalId: request.principalId,
    operation: request.operation,
    authorization: 'authorized',
    grantedScopes: [...request.requiredScopes],
    observedAt: OBSERVED_AT,
    ...changes,
  }
}

/** @param {FeishuOperationScopeProbeClient} client @param {{bot?: boolean, user?: boolean}} [changes] */
function authorizer(client, changes = {}) {
  return new FeishuOperationScopeAuthorizer({
    configuration: configuration(changes),
    client,
    now: () => NOW,
  })
}

test('fixed policies bind discovery and reply to distinct identities and exact minimum scopes', async () => {
  assert.deepEqual(requiredFeishuOperationScopes('bot_reply'), ['im:message:send_as_bot'])
  assert.deepEqual(requiredFeishuOperationScopes('user_reply'), ['im:message:send_as_user'])
  assert.deepEqual(requiredFeishuOperationScopes('user_message_discovery'), [
    'im:chat:read',
    'im:message:readonly',
    'search:message',
  ])
  /** @type {FeishuOperationScopeProbeRequest[]} */
  const requests = []
  const current = authorizer({
    async inspectCurrentScopes(request) {
      requests.push(request)
      assert.equal(Object.isFrozen(request), true)
      assert.equal(Object.isFrozen(request.requiredScopes), true)
      return result(request, {
        grantedScopes: ['offline_access', ...request.requiredScopes].toReversed(),
      })
    },
  })
  for (const operation of ['bot_reply', 'user_reply', 'user_message_discovery']) {
    const authorization = await current.withAuthorizedOperation(
      operation,
      new AbortController().signal,
      async (value) => value,
    )
    assert.equal(Object.isFrozen(authorization), true)
    assert.equal(Object.isFrozen(authorization.grantedScopes), true)
    assert.equal(authorization.operation, operation)
  }
  assert.deepEqual(
    requests.map((request) => [request.operation, request.identityType, request.principalId]),
    [
      ['bot_reply', 'bot', BOT_PRINCIPAL_ID],
      ['user_reply', 'user', USER_PRINCIPAL_ID],
      ['user_message_discovery', 'user', USER_PRINCIPAL_ID],
    ],
  )
})

test('missing authorization, identity, or one operation scope never invokes the consumer', async () => {
  let consumed = 0
  /** @type {Array<{current: FeishuOperationScopeAuthorizerType, operation: FeishuScopedOperation, expectedCode: string, expectedRecovery: string}>} */
  const cases = [
    {
      current: authorizer({
        inspectCurrentScopes: async (request) => result(request, { grantedScopes: [] }),
      }),
      operation: 'bot_reply',
      expectedCode: 'scope_missing',
      expectedRecovery: 'grant_scope',
    },
    {
      current: authorizer({
        inspectCurrentScopes: async (request) =>
          result(request, { authorization: 'not_authorized', grantedScopes: [] }),
      }),
      operation: 'user_reply',
      expectedCode: 'not_authorized',
      expectedRecovery: 'reauthorize',
    },
    {
      current: authorizer(
        { inspectCurrentScopes: async () => assert.fail('An absent identity must not be probed.') },
        { user: false },
      ),
      operation: 'user_message_discovery',
      expectedCode: 'not_authorized',
      expectedRecovery: 'repair_configuration',
    },
  ]
  for (const { current, operation, expectedCode, expectedRecovery } of cases) {
    await assert.rejects(
      current.withAuthorizedOperation(operation, new AbortController().signal, async () => {
        consumed += 1
      }),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === expectedCode &&
        error.recovery === expectedRecovery,
    )
  }
  assert.equal(consumed, 0)
})

test('stale, future, identity-mismatched, and malformed observations fail closed', async () => {
  const cases = [
    {
      changes: {
        observedAt: new Date(NOW - FEISHU_SCOPE_OBSERVATION_MAX_AGE_MS - 1).toISOString(),
      },
      code: 'observation_stale',
    },
    {
      changes: { observedAt: new Date(NOW + 5 * 60_000 + 1).toISOString() },
      code: 'observation_stale',
    },
    { changes: { principalId: 'ou_synthetic_other' }, code: 'invalid_client' },
    { changes: { operation: 'bot_reply' }, code: 'invalid_client' },
    {
      changes: { grantedScopes: ['im:message:send_as_user', 'im:message:send_as_user'] },
      code: 'invalid_client',
    },
  ]
  for (const { changes, code } of cases) {
    const current = authorizer({
      inspectCurrentScopes: async (request) => result(request, changes),
    })
    await assert.rejects(
      current.withAuthorizedOperation('user_reply', new AbortController().signal, async () =>
        assert.fail('Invalid evidence must not reach an operation.'),
      ),
      (error) => error instanceof FeishuOperationScopeAuthorizationError && error.code === code,
    )
  }
})

test('probe errors are payload-free and retain actionable recovery', async () => {
  const privateValue = 'synthetic-private-scope-probe-payload'
  for (const [operation, probeError, code, recovery] of [
    [
      'bot_reply',
      new FeishuOperationScopeProbeClientError('not_authorized'),
      'not_authorized',
      'repair_configuration',
    ],
    [
      'user_reply',
      new FeishuOperationScopeProbeClientError('not_authorized'),
      'not_authorized',
      'reauthorize',
    ],
    [
      'bot_reply',
      new FeishuOperationScopeProbeClientError('invalid_response'),
      'invalid_client',
      'do_not_retry',
    ],
    [
      'bot_reply',
      new FeishuOperationScopeProbeClientError('rate_limited'),
      'probe_unavailable',
      'retry',
    ],
    ['bot_reply', new Error(privateValue), 'probe_unavailable', 'retry'],
  ]) {
    const current = authorizer({
      inspectCurrentScopes: async () => {
        throw probeError
      },
    })
    await assert.rejects(
      current.withAuthorizedOperation(operation, new AbortController().signal, async () =>
        assert.fail('A failed probe must not reach an operation.'),
      ),
      (error) =>
        error instanceof FeishuOperationScopeAuthorizationError &&
        error.code === code &&
        error.recovery === recovery &&
        !error.message.includes(privateValue),
    )
  }
})

test('cancellation is checked around the probe while a completed operation remains authoritative', async () => {
  const before = new AbortController()
  before.abort()
  let probes = 0
  const never = authorizer({
    inspectCurrentScopes: async () => {
      probes += 1
    },
  })
  await assert.rejects(
    never.withAuthorizedOperation('bot_reply', before.signal, async () => undefined),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(probes, 0)

  const duringProbe = new AbortController()
  let consumed = 0
  const cancelled = authorizer({
    async inspectCurrentScopes(request) {
      duringProbe.abort()
      return result(request)
    },
  })
  await assert.rejects(
    cancelled.withAuthorizedOperation('bot_reply', duringProbe.signal, async () => {
      consumed += 1
    }),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(consumed, 0)

  const duringOperation = new AbortController()
  const authoritative = authorizer({
    inspectCurrentScopes: async (request) => result(request),
  })
  assert.equal(
    await authoritative.withAuthorizedOperation('bot_reply', duringOperation.signal, async () => {
      duringOperation.abort()
      return 'sent'
    }),
    'sent',
  )
})

test('unknown operations and hostile adapters or observations fail without invoking accessors', async () => {
  assert.equal(Object.isFrozen(requiredFeishuOperationScopes('bot_reply')), true)
  assert.throws(
    () => requiredFeishuOperationScopes('persona_requested_scope'),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError && error.code === 'invalid_request',
  )

  let adapterAccessed = false
  const hostileClient = Object.defineProperty({}, 'inspectCurrentScopes', {
    get() {
      adapterAccessed = true
      return async () => undefined
    },
  })
  assert.throws(
    () => authorizer(/** @type {never} */ (hostileClient)),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError && error.code === 'invalid_request',
  )
  assert.equal(adapterAccessed, false)

  let invalidClockProbes = 0
  const invalidClock = new FeishuOperationScopeAuthorizer({
    configuration: configuration(),
    client: {
      async inspectCurrentScopes() {
        invalidClockProbes += 1
      },
    },
    now: () => Number.NaN,
  })
  await assert.rejects(
    invalidClock.withAuthorizedOperation('bot_reply', new AbortController().signal, async () =>
      assert.fail('An invalid clock must not reach an operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError && error.code === 'invalid_request',
  )
  assert.equal(invalidClockProbes, 0)

  let scopeAccessed = false
  const current = authorizer({
    inspectCurrentScopes: async (request) =>
      result(request, {
        grantedScopes: Object.defineProperty([], '0', {
          enumerable: true,
          get() {
            scopeAccessed = true
            return 'im:message:send_as_bot'
          },
        }),
      }),
  })
  await assert.rejects(
    current.withAuthorizedOperation('bot_reply', new AbortController().signal, async () =>
      assert.fail('Hostile evidence must not reach an operation.'),
    ),
    (error) =>
      error instanceof FeishuOperationScopeAuthorizationError && error.code === 'invalid_client',
  )
  assert.equal(scopeAccessed, false)
})
