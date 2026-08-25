import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectHarnessCompatibility,
  SUPPORTED_CORDIS_VERSION,
  SUPPORTED_HARNESS_VERSION,
} from '../packages/harness-adapter/src/index.ts'

test('adapter validates the installed pinned Harness contracts', () => {
  const compatibility = inspectHarnessCompatibility()

  assert.deepEqual(compatibility, {
    cordisVersion: SUPPORTED_CORDIS_VERSION,
    harnessVersion: SUPPORTED_HARNESS_VERSION,
    contracts: {
      cordisLifecycle: true,
      profileBundles: true,
      toolRegistry: true,
    },
  })
  assert.equal(Object.isFrozen(compatibility), true)
  assert.equal(Object.isFrozen(compatibility.contracts), true)
})
