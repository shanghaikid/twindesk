import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECTOR_CONTRACT_VERSION,
  ConnectorContractError,
  ConnectorOperationError,
  parseIsoTimestamp,
  validateConnector,
} from '../packages/domain/dist/index.js'

const observedAt = parseIsoTimestamp('2026-08-26T09:00:00Z')

/**
 * @returns {import('../packages/domain/dist/index.js').Connector & {
 *   diagnostics(): { running: boolean, stopCount: number }
 * }}
 */
function syntheticConnector() {
  let running = false
  let stopCount = 0
  return {
    descriptor: {
      contractVersion: 1,
      id: 'synthetic',
      displayName: 'Synthetic Connector',
      capabilities: ['sync', 'context', 'propose', 'execute', 'health'],
    },
    async start(signal) {
      signal.throwIfAborted()
      running = true
    },
    async stop(signal) {
      signal.throwIfAborted()
      running = false
      stopCount += 1
    },
    async sync(_request, signal) {
      signal.throwIfAborted()
      return {
        events: [],
        hasMore: false,
        observedAt,
        issues: [],
      }
    },
    async getContext(_request, signal) {
      signal.throwIfAborted()
      return {
        availability: { status: 'partial', missing: ['synthetic project context'] },
        items: [],
        issues: [
          {
            code: 'context_unavailable',
            message: 'Synthetic context is unavailable.',
            retryable: true,
          },
        ],
        observedAt,
      }
    },
    async propose(_request, signal) {
      signal.throwIfAborted()
      throw new ConnectorOperationError({
        connectorId: 'synthetic',
        operation: 'propose',
        code: 'unsupported',
        retryable: false,
        message: 'Synthetic Connector is read-only.',
      })
    },
    async execute(_action, signal) {
      signal.throwIfAborted()
      throw new ConnectorOperationError({
        connectorId: 'synthetic',
        operation: 'execute',
        code: 'unsupported',
        retryable: false,
        message: 'Synthetic Connector cannot execute actions.',
      })
    },
    async health(signal) {
      signal.throwIfAborted()
      return {
        connectorId: 'synthetic',
        status: running ? 'healthy' : 'not_configured',
        checkedAt: observedAt,
        identities: [],
        issues: [],
      }
    },
    diagnostics() {
      return { running, stopCount }
    },
  }
}

test('the version 1 Connector contract covers lifecycle, sync, context, actions, and health', async () => {
  assert.equal(CONNECTOR_CONTRACT_VERSION, 1)
  const fixture = syntheticConnector()
  const connector = validateConnector(fixture)
  const signal = new AbortController().signal

  await connector.start(signal)
  assert.equal((await connector.health(signal)).status, 'healthy')
  assert.deepEqual(
    await connector.sync({ accountId: 'synthetic-account', stream: 'fixture', limit: 10 }, signal),
    {
      events: [],
      hasMore: false,
      observedAt: '2026-08-26T09:00:00Z',
      issues: [],
    },
  )
  assert.deepEqual(
    (
      await connector.getContext(
        {
          reference: {
            connectorId: 'synthetic',
            accountId: 'synthetic-account',
            objectType: 'fixture',
            externalId: 'fixture-1',
          },
          purpose: 'Test explicit partial context',
          maxItems: 1,
        },
        signal,
      )
    ).availability,
    { status: 'partial', missing: ['synthetic project context'] },
  )

  await connector.stop(signal)
  await connector.stop(signal)
  await connector.start(signal)
  assert.equal((await connector.health(signal)).status, 'healthy')
  await connector.stop(signal)
  assert.deepEqual(fixture.diagnostics(), { running: false, stopCount: 3 })
})

test('Connector operations receive cancellation signals', async () => {
  const connector = validateConnector(syntheticConnector())
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(connector.start(controller.signal), { name: 'AbortError' })
  await assert.rejects(connector.stop(controller.signal), { name: 'AbortError' })
  await assert.rejects(
    connector.sync(
      { accountId: 'synthetic-account', stream: 'fixture', limit: 1 },
      controller.signal,
    ),
    { name: 'AbortError' },
  )
  const unreachable = /** @type {never} */ ({})
  await assert.rejects(connector.getContext(unreachable, controller.signal), {
    name: 'AbortError',
  })
  await assert.rejects(connector.propose(unreachable, controller.signal), { name: 'AbortError' })
  await assert.rejects(connector.execute(unreachable, controller.signal), { name: 'AbortError' })
  await assert.rejects(connector.health(controller.signal), { name: 'AbortError' })
})

test('runtime registration rejects malformed Connector surfaces without echoing values', () => {
  const fixture = syntheticConnector()
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, contractVersion: 2 },
      }),
    /contractVersion must equal 1/u,
  )
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, id: ' synthetic ' },
      }),
    /descriptor\.id must be a non-empty trimmed string/u,
  )
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, capabilities: ['sync', 'sync'] },
      }),
    /capabilities must not contain duplicates/u,
  )
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, capabilities: ['private-capability'] },
      }),
    /capabilities\[0\] is not a supported capability/u,
  )
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, capabilities: ['sync'] },
      }),
    /capabilities must include health/u,
  )
  assert.throws(
    () =>
      validateConnector({
        ...fixture,
        descriptor: { ...fixture.descriptor, privateConfiguration: true },
      }),
    /descriptor\.privateConfiguration is not supported by this contract version/u,
  )

  const privateValue = 'synthetic-private-value'
  assert.throws(
    () => validateConnector({ ...fixture, execute: privateValue }),
    (error) => {
      assert.ok(error instanceof ConnectorContractError)
      assert.equal(error.path, 'connector.execute')
      assert.equal(error.message.includes(privateValue), false)
      return true
    },
  )
})

test('typed Connector failures expose actionable fields and no raw payload', () => {
  const error = new ConnectorOperationError({
    connectorId: 'synthetic',
    operation: 'sync',
    code: 'rate_limited',
    retryable: true,
    message: 'Retry after the Connector backoff window.',
  })

  assert.equal(error.connectorId, 'synthetic')
  assert.equal(error.operation, 'sync')
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.retryable, true)
  assert.equal(Object.hasOwn(error, 'payload'), false)
  assert.equal(Object.hasOwn(error, 'cause'), false)
})
