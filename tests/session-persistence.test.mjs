import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { probeHarnessJsonlSessionRecovery } from '../packages/harness-adapter/src/testing.ts'
import {
  apply,
  inject,
  name,
  TWIN_DESK_STATUS,
  TWIN_DESK_STATUS_TOOL_NAME,
} from '../packages/plugin-work-hub/src/index.ts'
import { TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME } from '../packages/plugin-work-hub/src/technical-context.ts'

/** @typedef {import('../packages/harness-adapter/src/testing.ts').HarnessJsonlSessionRecoveryResult} HarnessJsonlSessionRecoveryResult */

const technicalPresetId = 'twindesk-technical-lead'

async function runRecoveryProbe(options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'twindesk-session-recovery-'))

  try {
    return await probeHarnessJsonlSessionRecovery({
      storageRoot: join(temporaryRoot, 'sessions'),
      presetRoot: resolve('packages/bundle-workbench/agent-presets'),
      plugin: { apply, inject, name },
      presetId: technicalPresetId,
      toolName: TWIN_DESK_STATUS_TOOL_NAME,
      fixtureRequest: 'Persist and recover the TwinDesk status observation.',
      ...options,
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

/** @param {HarnessJsonlSessionRecoveryResult} result */
function assertDuplicateFreeRecovery(result) {
  assert.equal(result.backend, 'jsonl')
  assert.equal(result.presetBeforeRestart, technicalPresetId)
  assert.equal(result.presetAfterFirstRestart, technicalPresetId)
  assert.equal(result.presetAfterSecondRestart, technicalPresetId)
  assert.equal(result.derivedMessagesAfterFirstRestart, result.derivedMessagesBeforeRestart)
  assert.equal(result.derivedMessagesAfterSecondRestart, result.derivedMessagesBeforeRestart)

  const expectedTrace = [
    { type: 'tool/call', name: TWIN_DESK_STATUS_TOOL_NAME },
    { type: 'tool/result', isError: false, text: JSON.stringify(TWIN_DESK_STATUS) },
  ]
  assert.deepEqual(result.toolTraceBeforeRestart, expectedTrace)
  assert.deepEqual(result.toolTraceAfterFirstRestart, expectedTrace)
  assert.deepEqual(result.toolTraceAfterSecondRestart, expectedTrace)

  assert.deepEqual(
    result.eventsBeforeRestart.map((event) => event.seq),
    result.eventsBeforeRestart.map((_, index) => index),
  )
  assert.deepEqual(
    result.eventsAfterFirstRestart.slice(0, result.eventsBeforeRestart.length),
    result.eventsBeforeRestart,
  )
  assert.equal(result.eventsAfterFirstRestart.length, result.eventsBeforeRestart.length + 1)
  assert.deepEqual(result.eventsAfterFirstRestart.at(-1), {
    seq: result.eventsBeforeRestart.length,
    type: 'session/end-seed',
  })
  assert.deepEqual(result.eventsAfterSecondRestart, result.eventsAfterFirstRestart)

  assert.deepEqual(result.resumeSources, ['resume', 'resume'])
  assert.deepEqual(result.toolsAfterRestart, [
    'skill',
    TWIN_DESK_STATUS_TOOL_NAME,
    TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME,
  ])
  assert.equal(result.firstRunModelCalls, 2)
  assert.equal(result.modelCallsAfterRestart, 0)
  assert.equal(Object.isFrozen(result), true)
}

test('default Zstandard Session persistence survives duplicate-free cold restarts', async () => {
  const result = await runRecoveryProbe()

  assertDuplicateFreeRecovery(result)
  assert.equal(result.physicalEncoding, 'zstd')
  assert.equal(result.physicalArtifactFilename, 'session.jsonl.zstd')
  assert.equal(result.rawExportFilename, 'session.jsonl')
  assert.equal(result.tornTailInjected, false)
  assert.equal(result.tornTailRecovered, undefined)
})

test('raw JSONL Session persistence repairs a torn tail before cold resume', async () => {
  const result = await runRecoveryProbe({
    physicalEncoding: 'none',
    injectTornTail: true,
  })

  assertDuplicateFreeRecovery(result)
  assert.equal(result.physicalEncoding, 'none')
  assert.equal(result.physicalArtifactFilename, 'session.jsonl')
  assert.equal(result.rawExportFilename, 'session.jsonl')
  assert.equal(result.tornTailInjected, true)
  assert.equal(result.tornTailRecovered, true)
})

test('torn-tail injection fails closed for the default compressed encoding', async () => {
  await assert.rejects(
    runRecoveryProbe({ injectTornTail: true }),
    /requires physicalEncoding "none"/u,
  )
})
