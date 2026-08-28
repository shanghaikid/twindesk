import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
} from '../packages/plugin-feishu/dist/index.js'

const PRIVATE_ACCOUNT_ID = 'feishu-account:synthetic-private-runtime-lease'

/** @param {string} [accountId] */
function configuration(accountId = PRIVATE_ACCOUNT_ID) {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId,
    appId: 'cli_synthetic_runtime_lease',
    bot: {
      identityType: 'bot',
      displayName: 'Synthetic Runtime Lease Bot',
      principalId: 'cli_synthetic_runtime_lease',
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-runtime-lease',
        store: 'system_keychain',
        purpose: 'connector_app_credential',
      },
    },
  }
}

function deferred() {
  /** @type {() => void} */
  let resolve = () => assert.fail('Deferred signal was not initialized.')
  /** @type {Promise<void>} */
  const promise = new Promise((complete) => {
    resolve = () => complete()
  })
  return { promise, resolve }
}

test('one Host lease excludes every competing Feishu runtime and releases cleanly', async () => {
  const entered = deferred()
  const release = deferred()
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuRuntimeLease | undefined} */
  let retainedLease
  const first = new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    new AbortController().signal,
    async (lease) => {
      retainedLease = lease
      lease.assertHeld()
      entered.resolve()
      await release.promise
      lease.assertHeld()
      return 'first-complete'
    },
  )
  await entered.promise

  for (const contender of [
    configuration(),
    configuration('feishu-account:synthetic-other-runtime-lease'),
  ]) {
    await assert.rejects(
      new FeishuRuntimeLeaseManager().withLease(contender, new AbortController().signal, () =>
        assert.fail('A competing Host must never enter the lease callback.'),
      ),
      (error) =>
        error instanceof FeishuRuntimeLeaseError &&
        error.code === 'lease_unavailable' &&
        error.recovery === 'retry_after_owner_exit' &&
        !error.message.includes(PRIVATE_ACCOUNT_ID),
    )
  }

  release.resolve()
  assert.equal(await first, 'first-complete')
  if (retainedLease === undefined) assert.fail('The retained lease was not captured.')
  const releasedLease = retainedLease
  assert.throws(
    () => releasedLease.assertHeld(),
    (error) => error instanceof FeishuRuntimeLeaseError && error.code === 'lease_lost',
  )
  assert.equal(
    await new FeishuRuntimeLeaseManager().withLease(
      configuration(),
      new AbortController().signal,
      (lease) => {
        lease.assertHeld()
        return 'restarted'
      },
    ),
    'restarted',
  )
})

test('callback failure releases ownership without changing the original failure', async () => {
  const privateFailure = new Error('synthetic-private-callback-failure')
  await assert.rejects(
    new FeishuRuntimeLeaseManager().withLease(configuration(), new AbortController().signal, () => {
      throw privateFailure
    }),
    (error) => error === privateFailure,
  )
  await new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    new AbortController().signal,
    (lease) => lease.assertHeld(),
  )
})

test('cancellation during owned work does not release before the callback unwinds', async () => {
  const controller = new AbortController()
  const entered = deferred()
  const release = deferred()
  const owner = new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    controller.signal,
    async (lease) => {
      controller.abort(new Error(PRIVATE_ACCOUNT_ID))
      lease.assertHeld()
      entered.resolve()
      await release.promise
    },
  )
  await entered.promise
  await assert.rejects(
    new FeishuRuntimeLeaseManager().withLease(configuration(), new AbortController().signal, () =>
      assert.fail('Cancellation must not release an in-flight owner early.'),
    ),
    (error) => error instanceof FeishuRuntimeLeaseError && error.code === 'lease_unavailable',
  )
  release.resolve()
  await owner
})

test('process death releases the kernel lease without a stale-owner recovery write', async (context) => {
  const child = fork(
    fileURLToPath(new URL('./fixtures/feishu-runtime-lease-child.mjs', import.meta.url)),
    [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) })
  assert.equal(message, 'ready')

  await assert.rejects(
    new FeishuRuntimeLeaseManager().withLease(configuration(), new AbortController().signal, () =>
      assert.fail('The parent must not overlap the child Host.'),
    ),
    (error) => error instanceof FeishuRuntimeLeaseError && error.code === 'lease_unavailable',
  )
  child.kill('SIGKILL')
  await once(child, 'exit')

  await new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    new AbortController().signal,
    (lease) => lease.assertHeld(),
  )
})

test('cancellation and malformed configuration fail before a callback can run', async () => {
  let callbacks = 0
  const controller = new AbortController()
  controller.abort(new Error(PRIVATE_ACCOUNT_ID))
  await assert.rejects(
    new FeishuRuntimeLeaseManager().withLease(configuration(), controller.signal, () => {
      callbacks += 1
    }),
    (error) =>
      error instanceof FeishuRuntimeLeaseError &&
      error.code === 'cancelled' &&
      !error.message.includes(PRIVATE_ACCOUNT_ID),
  )

  const pendingController = new AbortController()
  const pending = new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    pendingController.signal,
    () => {
      callbacks += 1
    },
  )
  queueMicrotask(() => pendingController.abort(new Error(PRIVATE_ACCOUNT_ID)))
  await assert.rejects(
    pending,
    (error) => error instanceof FeishuRuntimeLeaseError && error.code === 'cancelled',
  )
  await new FeishuRuntimeLeaseManager().withLease(
    configuration(),
    new AbortController().signal,
    (lease) => lease.assertHeld(),
  )

  let accessed = false
  const hostile = Object.defineProperty({}, 'accountId', {
    enumerable: true,
    get() {
      accessed = true
      return PRIVATE_ACCOUNT_ID
    },
  })
  await assert.rejects(
    new FeishuRuntimeLeaseManager().withLease(hostile, new AbortController().signal, () => {
      callbacks += 1
    }),
    (error) =>
      error instanceof FeishuRuntimeLeaseError &&
      error.code === 'invalid_request' &&
      !error.message.includes(PRIVATE_ACCOUNT_ID),
  )
  assert.equal(accessed, false)
  assert.equal(callbacks, 0)
})
