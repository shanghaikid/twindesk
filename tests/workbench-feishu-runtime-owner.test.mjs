import assert from 'node:assert/strict'
import test from 'node:test'

import { startWorkbenchFeishuRuntimeOwner } from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
} from '../packages/plugin-feishu/dist/index.js'

const CONFIGURATION = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-runtime-owner',
  appId: 'cli_synthetic_runtime_owner',
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic Runtime Owner User',
    principalId: 'ou_synthetic_runtime_owner',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-runtime-owner',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

class SyntheticOwnerLeaseManager extends FeishuRuntimeLeaseManager {
  acquisitions = 0
  assertions = 0
  active = false

  /**
   * @override
   * @template TResult
   * @param {unknown} _configuration
   * @param {AbortSignal} signal
   * @param {(lease: import('../packages/plugin-feishu/src/runtime-lease.ts').FeishuRuntimeLease) => Promise<TResult> | TResult} use
   * @returns {Promise<TResult>}
   */
  async withLease(_configuration, signal, use) {
    signal.throwIfAborted()
    this.acquisitions += 1
    this.active = true
    try {
      return await use({
        assertHeld: () => {
          if (!this.active) {
            throw new FeishuRuntimeLeaseError(
              'lease_lost',
              'stop_connector',
              'The Feishu runtime lease is no longer held.',
            )
          }
          this.assertions += 1
        },
      })
    } finally {
      this.active = false
    }
  }
}

test('one Workbench owner lends the same exact lease without another acquisition', async () => {
  const kernelManager = new SyntheticOwnerLeaseManager()
  const owner = await startWorkbenchFeishuRuntimeOwner({
    configuration: CONFIGURATION,
    leaseManager: kernelManager,
  })
  assert.equal(kernelManager.acquisitions, 1)
  assert.equal(kernelManager.active, true)

  const first = await owner.leaseManager.withLease(
    CONFIGURATION,
    new AbortController().signal,
    async (lease) => {
      lease.assertHeld()
      return 'first'
    },
  )
  const second = await owner.leaseManager.withLease(
    CONFIGURATION,
    new AbortController().signal,
    async (lease) => {
      lease.assertHeld()
      return 'second'
    },
  )
  assert.equal(first, 'first')
  assert.equal(second, 'second')
  assert.equal(kernelManager.acquisitions, 1)

  await owner.close()
  await owner.close()
  assert.equal(kernelManager.active, false)
  await assert.rejects(
    owner.leaseManager.withLease(
      CONFIGURATION,
      new AbortController().signal,
      async () => undefined,
    ),
    { name: 'FeishuRuntimeLeaseError', code: 'lease_lost' },
  )
})

test('owner shutdown stops new work and drains an existing lease callback', async () => {
  const kernelManager = new SyntheticOwnerLeaseManager()
  const owner = await startWorkbenchFeishuRuntimeOwner({
    configuration: CONFIGURATION,
    leaseManager: kernelManager,
  })
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseOperation
  const operationGate = new Promise((resolve) => {
    releaseOperation = resolve
  })
  let entered = false
  const operation = owner.leaseManager.withLease(
    CONFIGURATION,
    new AbortController().signal,
    async () => {
      entered = true
      await operationGate
    },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entered, true)
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, false)

  releaseOperation?.()
  await operation
  await closing
  assert.equal(closed, true)
  assert.equal(kernelManager.active, false)
})

test('the shared manager rejects identity substitution, cancellation, and hostile owner options', async () => {
  const kernelManager = new SyntheticOwnerLeaseManager()
  const owner = await startWorkbenchFeishuRuntimeOwner({
    configuration: CONFIGURATION,
    leaseManager: kernelManager,
  })
  const changed = { ...CONFIGURATION, appId: 'cli_substituted_runtime_owner' }
  await assert.rejects(
    owner.leaseManager.withLease(changed, new AbortController().signal, async () => undefined),
    { name: 'FeishuRuntimeLeaseError', code: 'invalid_request' },
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    owner.leaseManager.withLease(CONFIGURATION, controller.signal, async () => undefined),
    { name: 'FeishuRuntimeLeaseError', code: 'cancelled' },
  )
  await owner.close()

  let accessed = false
  const hostile = {
    configuration: CONFIGURATION,
    get credential() {
      accessed = true
      return 'synthetic-private-value'
    },
  }
  await assert.rejects(startWorkbenchFeishuRuntimeOwner(hostile), {
    name: 'TypeError',
    message: 'The Workbench Feishu runtime owner configuration is invalid.',
  })
  assert.equal(accessed, false)

  let methodAccessed = false
  const hostileManager = Object.create(FeishuRuntimeLeaseManager.prototype)
  Object.defineProperty(hostileManager, 'withLease', {
    get() {
      methodAccessed = true
      return async () => undefined
    },
  })
  await assert.rejects(
    startWorkbenchFeishuRuntimeOwner({
      configuration: CONFIGURATION,
      leaseManager: hostileManager,
    }),
    {
      name: 'TypeError',
      message: 'The Workbench Feishu runtime owner configuration is invalid.',
    },
  )
  assert.equal(methodAccessed, false)
})
