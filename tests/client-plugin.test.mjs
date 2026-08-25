import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

import {
  CLIENT_PLUGIN_ID,
  inspectClientBundle,
  inspectClientPluginArtifacts,
} from '../scripts/build-client-plugin.mjs'

/** @typedef {{ type: unknown, props: Record<string, unknown> }} ElementLike */
/** @typedef {{ apply(context: ClientContext): void, inject: string[], TWIN_DESK_CLIENT_PLUGIN_ID: string, TWIN_DESK_INBOX_ROUTE: string }} ClientModule */
/** @typedef {{ name: string, key?: string, id?: string, order?: number, priority?: number }} SlotOptions */
/** @typedef {{ slots: { inject(name: string, register: () => () => void): () => void, register(options: SlotOptions, component: (props: Record<string, unknown>) => ElementLike): () => void } }} ClientContext */
/** @typedef {{ id: string, factory(load: (specifier: string) => { createElement: typeof createElement }): ClientModule }} ClientRegistration */
/** @typedef {{ options: SlotOptions, component: (props: Record<string, unknown>) => ElementLike, disposed: boolean }} SlotRegistration */

/**
 * @param {string} type
 * @param {Record<string, unknown> | null} props
 * @param {...unknown} children
 * @returns {ElementLike}
 */
function createElement(type, props, ...children) {
  return { type, props: { ...props, children } }
}

/**
 * @param {ElementLike | unknown} value
 * @param {(element: ElementLike) => boolean} predicate
 * @returns {ElementLike | undefined}
 */
function findElement(value, predicate) {
  if (value === null || typeof value !== 'object' || !('type' in value) || !('props' in value)) {
    return undefined
  }
  const element = /** @type {ElementLike} */ (value)
  if (predicate(element)) return element
  const children = element.props.children
  if (!Array.isArray(children)) return undefined
  for (const child of children) {
    const found = /** @type {ElementLike | undefined} */ (findElement(child, predicate))
    if (found !== undefined) return found
  }
  return undefined
}

/** @param {string} initialHash */
function createBrowserWindow(initialHash) {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map()
  let hash = initialHash
  const location = {}
  Object.defineProperty(location, 'hash', {
    get: () => hash,
    set: (next) => {
      if (next === hash) return
      hash = String(next)
      for (const listener of listeners.get('hashchange') ?? []) listener()
    },
  })
  return {
    location,
    /** @param {string} name @param {() => void} listener */
    addEventListener(name, listener) {
      const bucket = listeners.get(name) ?? new Set()
      bucket.add(listener)
      listeners.set(name, bucket)
    },
    /** @param {string} name @param {() => void} listener */
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener)
    },
    /** @param {string} name */
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0
    },
  }
}

/** @param {string} bundle @param {string} [initialHash] */
function loadProductionBundle(bundle, initialHash = '') {
  /** @type {ClientRegistration | undefined} */
  let registration
  const browserWindow = createBrowserWindow(initialHash)
  const moduleWindow = {
    ...browserWindow,
    __ModuleLoader__: {
      /** @param {ClientRegistration} candidate */
      load(candidate) {
        registration = candidate
      },
    },
  }
  vm.runInNewContext(bundle, {
    window: moduleWindow,
  })
  const loadedRegistration = /** @type {ClientRegistration | undefined} */ (registration)
  assert.equal(loadedRegistration?.id, CLIENT_PLUGIN_ID)
  assert.equal(typeof loadedRegistration?.factory, 'function')
  if (loadedRegistration === undefined) throw new Error('Client bundle did not register a module')

  const module = loadedRegistration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return { createElement }
  })
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(Array.from(module.inject), ['slots'])
  assert.equal(module.TWIN_DESK_CLIENT_PLUGIN_ID, CLIENT_PLUGIN_ID)
  assert.equal(module.TWIN_DESK_INBOX_ROUTE, '#/inbox')

  /** @type {string[]} */
  const injectedSlots = []
  /** @type {SlotRegistration[]} */
  const slotRegistrations = []
  /** @type {(() => void)[]} */
  const injectionDisposers = []
  module.apply({
    slots: {
      /** @param {string} name @param {() => () => void} register */
      inject(name, register) {
        injectedSlots.push(name)
        const dispose = register()
        assert.equal(typeof dispose, 'function')
        let active = true
        const controller = () => {
          if (!active) return
          active = false
          dispose()
        }
        injectionDisposers.push(controller)
        return controller
      },
      /** @param {SlotOptions} options @param {(props: Record<string, unknown>) => ElementLike} candidate */
      register(options, candidate) {
        const record = { options, component: candidate, disposed: false }
        slotRegistrations.push(record)
        return () => {
          record.disposed = true
        }
      },
    },
  })

  return {
    browserWindow,
    injectedSlots,
    module,
    slotRegistrations,
    /** @param {string} name */
    activeRegistration(name) {
      return slotRegistrations.findLast(
        (candidate) => candidate.options.name === name && !candidate.disposed,
      )
    },
    dispose() {
      for (const dispose of injectionDisposers.reverse()) dispose()
    },
  }
}

test('the production Client artifact loads the settings card and navigable Inbox surface', async () => {
  const artifact = await inspectClientPluginArtifacts()
  assert.equal(artifact.sourceMap.file, 'client.js')
  assert.deepEqual(artifact.sourceMap.sources, ['../src/client/index.ts'])
  assert.equal(artifact.sourceMap.sourcesContent.length, 1)
  assert.match(artifact.sourceMap.mappings, /^;;/u)

  const first = loadProductionBundle(artifact.bundle)
  assert.deepEqual(first.injectedSlots, [
    'settings.plugin.item',
    'sidebar.footer.action',
    'conversation',
  ])
  const card = first.activeRegistration('settings.plugin.item')
  assert.equal(card?.options.key, 'twindesk-work-hub')
  const cardElement = card?.component({})
  assert.equal(cardElement?.type, 'section')
  assert.equal(cardElement?.props['data-twindesk-client-plugin'], 'ready')
  assert.match(JSON.stringify(cardElement), /Client plugin loaded/u)

  const navigation = first.activeRegistration('sidebar.footer.action')
  assert.equal(navigation?.options.id, 'twindesk-inbox')
  assert.equal(navigation?.options.order, -100)
  const navigationElement = navigation?.component({ wide: true })
  assert.equal(navigationElement?.props['data-twindesk-inbox-navigation'], 'ready')
  const openInbox = navigationElement?.props.onClick
  assert.equal(typeof openInbox, 'function')
  if (typeof openInbox === 'function') openInbox()

  const inbox = first.activeRegistration('conversation')
  assert.equal(inbox?.options.priority, -100)
  const inboxElement = inbox?.component({})
  assert.equal(inboxElement?.type, 'main')
  assert.equal(inboxElement?.props['data-twindesk-inbox-page'], 'empty')
  assert.match(JSON.stringify(inboxElement), /No work items yet/u)
  const close = findElement(
    inboxElement,
    (element) => element.props['aria-label'] === 'Return to conversations',
  )
  const closeInbox = close?.props.onClick
  assert.equal(typeof closeInbox, 'function')
  if (typeof closeInbox === 'function') closeInbox()
  assert.equal(inbox?.disposed, true)
  assert.equal(first.activeRegistration('conversation'), undefined)

  const second = loadProductionBundle(artifact.bundle, '#/inbox')
  assert.notEqual(first.module, second.module)
  assert.equal(second.activeRegistration('conversation')?.options.priority, -100)
  first.dispose()
  second.dispose()
  assert.equal(first.browserWindow.listenerCount('hashchange'), 0)
  assert.equal(second.browserWindow.listenerCount('hashchange'), 0)
  assert.equal(first.activeRegistration('settings.plugin.item'), undefined)
  assert.equal(first.activeRegistration('sidebar.footer.action'), undefined)
  assert.equal(second.activeRegistration('conversation'), undefined)
})

test('Client artifact diagnostics reject an invalid lazy-CJS bundle', () => {
  assert.throws(
    () => inspectClientBundle('console.log("not a Harness Client bundle")'),
    /does not register @twindesk\/plugin-ui.*pnpm run build/u,
  )
  assert.throws(
    () =>
      inspectClientBundle(
        'window.__ModuleLoader__.load({ id: "@twindesk/plugin-ui", factory: (require) => { require("unsupported"); return module.exports; } });\n//# sourceMappingURL=client.js.map',
      ),
    /requests unsupported module "unsupported"/u,
  )
})

test('Client artifact preflight reports a missing production bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twindesk-client-missing-'))
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        exports: {
          './client': { default: './dist/client.js' },
          './package.json': './package.json',
        },
        dsh: {
          client: {
            platform: 'web',
            inject: [
              '@deepseek-ai/dsh-client-ui-conversation',
              '@deepseek-ai/dsh-client-ui-settings-plugins',
              '@deepseek-ai/dsh-client-ui-sidebar',
            ],
          },
        },
      }),
    )
    await assert.rejects(
      inspectClientPluginArtifacts(directory),
      /bundle or source map is missing.*pnpm run build/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
