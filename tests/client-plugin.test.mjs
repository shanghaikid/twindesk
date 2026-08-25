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
/** @typedef {{ apply(context: ClientContext): void, inject: string[], TWIN_DESK_CLIENT_PLUGIN_ID: string }} ClientModule */
/** @typedef {{ slots: { inject(name: string, register: () => () => void): () => void, register(options: { name: string, key?: string }, component: () => ElementLike): () => void } }} ClientContext */
/** @typedef {{ id: string, factory(load: (specifier: string) => { createElement: typeof createElement }): ClientModule }} ClientRegistration */

/**
 * @param {string} type
 * @param {Record<string, unknown> | null} props
 * @param {...unknown} children
 * @returns {ElementLike}
 */
function createElement(type, props, ...children) {
  return { type, props: { ...props, children } }
}

/** @param {string} bundle */
function loadProductionBundle(bundle) {
  /** @type {ClientRegistration | undefined} */
  let registration
  vm.runInNewContext(bundle, {
    window: {
      __ModuleLoader__: {
        /** @param {ClientRegistration} candidate */
        load(candidate) {
          registration = candidate
        },
      },
    },
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

  let injectedSlot
  /** @type {{ name: string, key?: string } | undefined} */
  let registrationOptions
  /** @type {(() => ElementLike) | undefined} */
  let component
  let disposed = false
  /** @type {(() => void) | undefined} */
  let slotDisposer
  module.apply({
    slots: {
      /** @param {string} name @param {() => () => void} register */
      inject(name, register) {
        injectedSlot = name
        const dispose = register()
        assert.equal(typeof dispose, 'function')
        slotDisposer = dispose
        return () => {
          slotDisposer?.()
          slotDisposer = undefined
        }
      },
      /** @param {{ name: string, key?: string }} options @param {() => ElementLike} candidate */
      register(options, candidate) {
        registrationOptions = options
        component = candidate
        return () => {
          disposed = true
        }
      },
    },
  })

  assert.equal(injectedSlot, 'settings.plugin.item')
  const registeredOptions = /** @type {{ name: string, key?: string } | undefined} */ (
    registrationOptions
  )
  assert.equal(registeredOptions?.name, 'settings.plugin.item')
  assert.equal(registeredOptions?.key, 'twindesk-work-hub')
  assert.equal(typeof component, 'function')
  if (component === undefined) throw new Error('Client plugin did not register its card')
  const registeredComponent = /** @type {() => ElementLike} */ (component)
  const element = registeredComponent()
  assert.equal(element.type, 'section')
  assert.equal(element.props['data-twindesk-client-plugin'], 'ready')
  assert.match(JSON.stringify(element), /Client plugin loaded/u)

  return { dispose: () => slotDisposer?.(), module, wasDisposed: () => disposed }
}

test('the production Client artifact registers and reloads the TwinDesk settings card', async () => {
  const artifact = await inspectClientPluginArtifacts()
  assert.equal(artifact.sourceMap.file, 'client.js')
  assert.deepEqual(artifact.sourceMap.sources, ['../src/client/index.ts'])
  assert.equal(artifact.sourceMap.sourcesContent.length, 1)
  assert.match(artifact.sourceMap.mappings, /^;;/u)

  const first = loadProductionBundle(artifact.bundle)
  const second = loadProductionBundle(artifact.bundle)
  assert.notEqual(first.module, second.module)
  first.dispose()
  second.dispose()
  assert.equal(first.wasDisposed(), true)
  assert.equal(second.wasDisposed(), true)
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
            inject: ['@deepseek-ai/dsh-client-ui-settings-plugins'],
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
