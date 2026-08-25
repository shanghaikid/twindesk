import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, name } from '../packages/plugin-work-hub/src/index.ts'
import { PROFILE_BUNDLES, resolveHarnessHome } from '../scripts/harness-profile.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the Workbench Profile composes the pinned Harness layers in order', () => {
  assert.deepEqual(PROFILE_BUNDLES, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@twindesk/bundle-workbench',
  ])
  assert.equal(Object.isFrozen(PROFILE_BUNDLES), true)
})

test('a relative Harness home override is anchored to the repository', () => {
  const previous = process.env.TWINDESK_HARNESS_HOME
  process.env.TWINDESK_HARNESS_HOME = '.profile-test-home'
  try {
    assert.equal(resolveHarnessHome(), resolve(repositoryRoot, '.profile-test-home'))
  } finally {
    if (previous === undefined) delete process.env.TWINDESK_HARNESS_HOME
    else process.env.TWINDESK_HARNESS_HOME = previous
  }
})

test('the Workbench Bundle declares and mounts the TwinDesk Host plugin', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../packages/bundle-workbench/package.json', import.meta.url), 'utf8'),
  )
  const patch = await readFile(
    new URL('../packages/bundle-workbench/cordis.patch.yml', import.meta.url),
    'utf8',
  )

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies['@twindesk/plugin-work-hub'], 'workspace:*')
  assert.match(patch, /id: twindesk-work-hub/u)
  assert.match(patch, /name: '@twindesk\/plugin-work-hub'/u)
})

test('the minimal Work Hub Host plugin owns a disposable lifecycle effect', () => {
  let label
  let disposed = false
  apply({
    effect(register, effectLabel) {
      label = effectLabel
      const dispose = register()
      dispose()
      disposed = true
    },
  })

  assert.equal(name, 'twindesk-work-hub')
  assert.equal(label, 'twindesk-work-hub.lifecycle()')
  assert.equal(disposed, true)
})
