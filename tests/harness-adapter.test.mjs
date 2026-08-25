import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectHarnessCompatibility,
  SUPPORTED_CORDIS_VERSION,
  SUPPORTED_HARNESS_VERSION,
  SUPPORTED_SCHEMASTERY_VERSION,
} from '../packages/harness-adapter/src/index.ts'
import { probeHarnessClientInboxSlots } from '../packages/harness-adapter/src/testing.ts'

test('adapter validates the installed pinned Harness contracts', () => {
  const compatibility = inspectHarnessCompatibility()

  assert.deepEqual(compatibility, {
    cordisVersion: SUPPORTED_CORDIS_VERSION,
    harnessVersion: SUPPORTED_HARNESS_VERSION,
    schemasteryVersion: SUPPORTED_SCHEMASTERY_VERSION,
    contracts: {
      cordisLifecycle: true,
      profileBundles: true,
      settingsRegistry: true,
      toolRegistry: true,
      clientSlotRegistry: true,
    },
  })
  assert.equal(Object.isFrozen(compatibility), true)
  assert.equal(Object.isFrozen(compatibility.contracts), true)
})

test('adapter validates the pinned Client slot shadow and restore contract', () => {
  assert.deepEqual(probeHarnessClientInboxSlots(), {
    inboxShadowsConversation: true,
    conversationRestored: true,
    footerActionMounted: true,
    footerActionRemoved: true,
  })
})
