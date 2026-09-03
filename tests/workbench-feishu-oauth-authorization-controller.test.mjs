import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkbenchFeishuOAuthAuthorizationController,
  WorkbenchFeishuOAuthAuthorizationControllerError,
} from '../packages/bundle-workbench/dist/index.js'

const REDIRECT_URI = 'http://127.0.0.1:43121/oauth/feishu/callback'
const AUTHORIZATION_URL = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`

/** @returns {Promise<void>} */
function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * @param {import('../packages/bundle-workbench/dist/index.js').WorkbenchFeishuOAuthAuthorizationHost['authorize']} authorize
 */
function syntheticHost(authorize) {
  return Object.freeze({ authorize })
}

test('Workbench exposes one memory-only authorization URL and clears its client-secret copy', async () => {
  /** @type {(value?: void) => void} */
  let complete = () => undefined
  /** @type {Uint8Array | undefined} */
  let observedSecret
  let notifications = 0
  const controller = createWorkbenchFeishuOAuthAuthorizationController({
    async loadHost() {
      return syntheticHost(async (clientSecret, _signal, present) => {
        observedSecret = clientSecret
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        await new Promise((resolve) => {
          complete = resolve
        })
        return { status: 'persisted', obtainedAt: '2026-09-01T00:00:00.000Z' }
      })
    },
    onSucceeded() {
      notifications += 1
      throw new Error('Synthetic lifecycle observer failure.')
    },
  })
  const source = new TextEncoder().encode('synthetic-client-secret')
  assert.deepEqual(controller.read(), { version: 1, connectorId: 'feishu', state: 'idle' })
  assert.deepEqual(await controller.start(source), {
    version: 1,
    connectorId: 'feishu',
    state: 'waiting',
    authorizationUrl: AUTHORIZATION_URL,
    redirectUri: REDIRECT_URI,
  })
  assert.equal(new TextDecoder().decode(source), 'synthetic-client-secret')
  const clearedSecret = observedSecret
  assert.ok(clearedSecret !== undefined)
  assert.deepEqual([...clearedSecret], new Array(clearedSecret.byteLength).fill(0))

  complete()
  await turn()
  assert.deepEqual(controller.read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'succeeded',
  })
  assert.equal(notifications, 1)
})

test('Workbench cancels an active authorization and rejects a competing start', async () => {
  const controller = createWorkbenchFeishuOAuthAuthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, signal, present) => {
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { status: 'persisted', obtainedAt: '2026-09-01T00:00:00.000Z' }
      })
    },
  })
  await controller.start(new Uint8Array([1]))
  await assert.rejects(
    controller.start(new Uint8Array([2])),
    (error) =>
      error instanceof WorkbenchFeishuOAuthAuthorizationControllerError &&
      error.code === 'authorization_active',
  )
  assert.deepEqual(await controller.cancel(), {
    version: 1,
    connectorId: 'feishu',
    state: 'cancelled',
  })
})

test('Workbench minimizes authorization failures and rejects hostile presentation data', async () => {
  const failed = createWorkbenchFeishuOAuthAuthorizationController({
    async loadHost() {
      throw new Error('synthetic-private-loader-value')
    },
  })
  assert.deepEqual(await failed.start(new Uint8Array([1])), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })

  let getterCalls = 0
  const hostile = createWorkbenchFeishuOAuthAuthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, _signal, present) => {
        const request = Object.defineProperty({ redirectUri: REDIRECT_URI }, 'authorizationUrl', {
          enumerable: true,
          get() {
            getterCalls += 1
            throw new Error('synthetic-private-authorization-url')
          },
        })
        present(/** @type {never} */ (request))
        return { status: 'persisted', obtainedAt: '2026-09-01T00:00:00.000Z' }
      })
    },
  })
  assert.deepEqual(await hostile.start(new Uint8Array([1])), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })
  assert.equal(getterCalls, 0)

  const invalidResult = createWorkbenchFeishuOAuthAuthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, _signal, present) => {
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        return /** @type {never} */ ({ status: 'persisted', obtainedAt: 'not-a-timestamp' })
      })
    },
  })
  await invalidResult.start(new Uint8Array([1]))
  await turn()
  assert.deepEqual(invalidResult.read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })
})
