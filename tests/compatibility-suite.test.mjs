import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compatibilityFailure,
  formatCompatibilityCommand,
  HARNESS_COMPATIBILITY_STEPS,
  HARNESS_COMPATIBILITY_TESTS,
} from '../scripts/check-harness-compatibility.mjs'

test('the Harness compatibility suite covers every TD-050 boundary', async () => {
  assert.deepEqual(
    HARNESS_COMPATIBILITY_TESTS.map(({ file }) => file),
    [
      'tests/harness-adapter.test.mjs',
      'tests/status-tool.test.mjs',
      'tests/settings.test.mjs',
      'tests/client-plugin.test.mjs',
      'tests/profile-bundle.test.mjs',
      'tests/agent-presets.test.mjs',
      'tests/session-persistence.test.mjs',
      'tests/harness-model-draft-run.test.mjs',
      'tests/codex-subagent.test.mjs',
      'tests/compatibility-suite.test.mjs',
      'tests/compatibility-report.test.mjs',
      'tests/stage0-exit-gate.test.mjs',
    ],
  )
  assert.deepEqual(
    HARNESS_COMPATIBILITY_STEPS.map(({ id }) => id),
    ['build', 'contracts', 'adapter-output', 'profile'],
  )
  assert.equal(Object.isFrozen(HARNESS_COMPATIBILITY_TESTS), true)
  assert.equal(Object.isFrozen(HARNESS_COMPATIBILITY_STEPS), true)
  assert.equal(
    HARNESS_COMPATIBILITY_TESTS.every(
      (entry) => Object.isFrozen(entry) && entry.capability.length > 0,
    ),
    true,
  )
  assert.equal(
    HARNESS_COMPATIBILITY_STEPS.every(
      (step) => Object.isFrozen(step) && Object.isFrozen(step.args) && step.capability.length > 0,
    ),
    true,
  )

  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts['compat:check'], 'node scripts/check-harness-compatibility.mjs')
})

test('a compatibility step failure names its boundary and reproducible command', () => {
  const step = HARNESS_COMPATIBILITY_STEPS[2]
  assert.ok(step)
  assert.equal(formatCompatibilityCommand(step), 'pnpm run adapter:check')
  assert.equal(
    compatibilityFailure(step, { status: 7 }).message,
    'Harness compatibility step "adapter-output" failed (built adapter exports, declarations, and runtime versions): exited with status 7. Command: pnpm run adapter:check',
  )
})
