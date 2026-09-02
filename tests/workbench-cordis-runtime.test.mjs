import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../packages/bundle-workbench/dist/cordis-runtime.js'

/** @param {import('node:test').TestContext} context */
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-cordis-runtime-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  return {
    config: {
      version: 1,
      homeDirectory: root,
      databasePath: join(root, 'state', 'twindesk.sqlite3'),
      port: 0,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
    },
  }
}

/** @param {{ routeAvailable?: boolean }} [options] */
function runtimeContext({ routeAvailable = true } = {}) {
  /** @type {Promise<() => Promise<void>> | undefined} */
  let lifecycle
  /** @type {string[]} */
  const messages = []
  const context = {
    agents: { create() {}, get() {} },
    sessions: { flush() {} },
    sessionPersistence: { list() {}, inspect() {} },
    agentPresets: { mount() {} },
    llm: {
      listProviders() {
        return routeAvailable ? [{ id: 'synthetic-provider', name: 'Synthetic' }] : []
      },
      /** @param {string} provider @param {string} model @param {AbortSignal | undefined} signal */
      async resolveModelInfo(provider, model, signal) {
        signal?.throwIfAborted()
        return { provider, id: model, name: model }
      },
    },
    /** @param {() => Promise<() => Promise<void>>} effect */
    effect(effect) {
      lifecycle = Promise.resolve(effect())
      return () => {}
    },
    logger() {
      return { info: (/** @type {string} */ message) => messages.push(message) }
    },
  }
  return {
    context,
    messages,
    lifecycle() {
      if (lifecycle === undefined) throw new Error('Synthetic lifecycle was not registered.')
      return lifecycle
    },
  }
}

test('Workbench Cordis runtime owns product Web startup, route injection, restart, and shutdown', async (context) => {
  assert.equal(name, 'twindesk-workbench-runtime')
  assert.deepEqual(inject, ['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'llm'])
  const { config } = await fixture(context)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runtime = runtimeContext()
    apply(runtime.context, config)
    const dispose = await runtime.lifecycle()
    assert.equal(typeof dispose, 'function')
    assert.equal(runtime.messages.length, 1)
    const url = runtime.messages[0]?.match(/TwinDesk product web: (http:\/\/[^\s]+)/u)?.[1]
    assert.ok(url)
    const status = await fetch(`${url}/api/model-drafts`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      capability: 'ready',
      autonomy: 'draft_only',
    })
    assert.match(status.headers.get('x-twindesk-model-draft-csrf-token') ?? '', /^[\w-]{43}$/u)
    await dispose()
    await assert.rejects(fetch(`${url}/health`))
  }
})

test('Workbench Cordis runtime fails before listening when the Host route is unavailable', async (context) => {
  const { config } = await fixture(context)
  const runtime = runtimeContext({ routeAvailable: false })
  apply(runtime.context, config)
  await assert.rejects(runtime.lifecycle(), { code: 'runtime_unavailable' })
  assert.deepEqual(runtime.messages, [])
})

test('Workbench Cordis runtime rejects unknown and accessor-backed configuration', async () => {
  const runtime = runtimeContext()
  await assert.rejects(
    async () => apply(runtime.context, { version: 1, extra: true }),
    /configuration is invalid/u,
  )
  let accessed = false
  const hostile = {
    version: 1,
    homeDirectory: '/tmp/synthetic-home',
    databasePath: '/tmp/synthetic.sqlite3',
    port: 0,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    get credential() {
      accessed = true
      return 'synthetic-private-value'
    },
  }
  await assert.rejects(async () => apply(runtime.context, hostile), /configuration is invalid/u)
  assert.equal(accessed, false)
})
