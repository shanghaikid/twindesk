import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkbenchFeishuOAuthReauthorizationController,
  WorkbenchFeishuOAuthHostedReauthorizationError,
  WorkbenchFeishuOAuthReauthorizationControllerError,
} from '../packages/bundle-workbench/dist/index.js'
import {
  FeishuOAuthAuthorizationError,
  FeishuOAuthReauthorizationError,
  FeishuRuntimeLeaseError,
} from '../packages/plugin-feishu/dist/index.js'

const REDIRECT_URI = 'http://127.0.0.1:43121/oauth/feishu/callback'
const AUTHORIZATION_URL = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`

/** @returns {Promise<void>} */
function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * @param {import('../packages/bundle-workbench/dist/index.js').WorkbenchFeishuOAuthHostedReauthorizationHost['reauthorize']} reauthorize
 */
function syntheticHost(reauthorize) {
  return Object.freeze({ reauthorize })
}

test('Workbench exposes one memory-only reauthorization URL and clears its secret copy', async () => {
  /** @type {(value?: void) => void} */
  let complete = () => undefined
  /** @type {Uint8Array | undefined} */
  let observedSecret
  /** @type {import('../packages/bundle-workbench/dist/index.js').WorkbenchFeishuOAuthAuthorizationPresenter | undefined} */
  let latePresenter
  let notifications = 0
  const controller = createWorkbenchFeishuOAuthReauthorizationController({
    async loadHost() {
      return syntheticHost(async (clientSecret, _signal, present) => {
        observedSecret = clientSecret
        latePresenter = present
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        await new Promise((resolve) => {
          complete = resolve
        })
        return { status: 'reauthorized', obtainedAt: '2026-09-01T00:00:00.000Z' }
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
  assert.ok(observedSecret !== undefined)
  assert.deepEqual([...observedSecret], new Array(observedSecret.byteLength).fill(0))

  complete()
  await turn()
  assert.deepEqual(controller.read(), { version: 1, connectorId: 'feishu', state: 'succeeded' })
  assert.equal(notifications, 1)
  assert.ok(latePresenter !== undefined)
  latePresenter({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
  assert.deepEqual(controller.read(), { version: 1, connectorId: 'feishu', state: 'succeeded' })
})

test('Workbench cancels active reauthorization and rejects a competing attempt', async () => {
  const controller = createWorkbenchFeishuOAuthReauthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, signal, present) => {
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { status: 'reauthorized', obtainedAt: '2026-09-01T00:00:00.000Z' }
      })
    },
  })
  await controller.start(new Uint8Array([1]))
  await assert.rejects(
    controller.start(new Uint8Array([2])),
    (error) =>
      error instanceof WorkbenchFeishuOAuthReauthorizationControllerError &&
      error.code === 'reauthorization_active',
  )
  assert.deepEqual(await controller.cancel(), {
    version: 1,
    connectorId: 'feishu',
    state: 'cancelled',
  })
})

test('Workbench preserves only actionable reauthorization recovery categories', async () => {
  const cases = [
    [
      new WorkbenchFeishuOAuthHostedReauthorizationError(
        'configuration_mismatch',
        'correct_configuration',
        'synthetic-private-configuration',
      ),
      'correct_configuration',
    ],
    [
      new FeishuOAuthReauthorizationError(
        'persistence_uncertain',
        'reconcile_keychain',
        'synthetic-private-keychain',
      ),
      'reconcile_keychain',
    ],
    [
      new FeishuOAuthReauthorizationError(
        'journal_uncertain',
        'reconcile_rotation',
        'synthetic-private-journal',
      ),
      'reconcile_rotation',
    ],
    [
      new FeishuOAuthAuthorizationError(
        'authorization_denied',
        'reauthorize',
        'synthetic-private-denial',
      ),
      'reauthorize',
    ],
    [
      new FeishuRuntimeLeaseError(
        'lease_unavailable',
        'retry_after_owner_exit',
        'synthetic-private-owner',
      ),
      'retry_after_owner_exit',
    ],
  ]
  for (const [cause, expected] of cases) {
    const controller = createWorkbenchFeishuOAuthReauthorizationController({
      async loadHost() {
        throw cause
      },
    })
    assert.deepEqual(await controller.start(new Uint8Array([1])), {
      version: 1,
      connectorId: 'feishu',
      state: 'failed',
      recovery: expected,
    })
  }
})

test('Workbench rejects hostile reauthorization presentation and result accessors', async () => {
  let presentationGetterCalls = 0
  const hostilePresentation = createWorkbenchFeishuOAuthReauthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, _signal, present) => {
        const request = Object.defineProperty({ redirectUri: REDIRECT_URI }, 'authorizationUrl', {
          enumerable: true,
          get() {
            presentationGetterCalls += 1
            throw new Error('synthetic-private-presentation')
          },
        })
        present(/** @type {never} */ (request))
        return { status: 'reauthorized', obtainedAt: '2026-09-01T00:00:00.000Z' }
      })
    },
  })
  assert.deepEqual(await hostilePresentation.start(new Uint8Array([1])), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })
  assert.equal(presentationGetterCalls, 0)

  let resultGetterCalls = 0
  const hostileResult = createWorkbenchFeishuOAuthReauthorizationController({
    async loadHost() {
      return syntheticHost(async (_clientSecret, _signal, present) => {
        present({ authorizationUrl: AUTHORIZATION_URL, redirectUri: REDIRECT_URI })
        return /** @type {never} */ (
          Object.defineProperty({ status: 'reauthorized' }, 'obtainedAt', {
            enumerable: true,
            get() {
              resultGetterCalls += 1
              throw new Error('synthetic-private-result')
            },
          })
        )
      })
    },
  })
  await hostileResult.start(new Uint8Array([1]))
  await turn()
  assert.deepEqual(hostileResult.read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })
  assert.equal(resultGetterCalls, 0)

  const missingPresentation = createWorkbenchFeishuOAuthReauthorizationController({
    async loadHost() {
      return syntheticHost(async () => ({
        status: 'reauthorized',
        obtainedAt: '2026-09-01T00:00:00.000Z',
      }))
    },
  })
  assert.deepEqual(await missingPresentation.start(new Uint8Array([1])), {
    version: 1,
    connectorId: 'feishu',
    state: 'failed',
    recovery: 'do_not_retry',
  })

  for (const secret of [new Uint8Array(), new Uint8Array(513), /** @type {never} */ ([])]) {
    await assert.rejects(hostileResult.start(secret), /invalid/u)
  }
})
