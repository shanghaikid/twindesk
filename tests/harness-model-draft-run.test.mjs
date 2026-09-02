import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  createHarnessModelDraftRunner,
  HarnessModelDraftRunError,
} from '../packages/harness-adapter/dist/index.js'
import { probeHarnessModelDraftRun } from '../packages/harness-adapter/dist/testing.js'
import { apply, inject, name } from '../packages/plugin-work-hub/dist/index.js'

const PROMPT = 'Draft a synthetic stakeholder update for local review only.'
const RESPONSE = 'Synthetic stakeholder draft. Draft only; no external action was performed.'

/**
 * @param {import('node:test').TestContext} context
 * @param {string} suffix
 * @param {Partial<import('../packages/harness-adapter/dist/testing.js').HarnessModelDraftRunProbeOptions>} changes
 */
async function runProbe(context, suffix, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-harness-model-draft-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return probeHarnessModelDraftRun({
    storageRoot: join(root, 'sessions'),
    presetRoot: resolve('packages/bundle-workbench/agent-presets'),
    plugin: { apply, inject, name },
    presetId: 'twindesk-communication',
    sessionId: `twindesk-model-draft-${suffix}`,
    prompt: PROMPT,
    response: RESPONSE,
    ...changes,
  })
}

test('Harness model Draft run flushes one completed turn and cold-recovers without rerun', async (context) => {
  const result = await runProbe(context, 'recovery')

  assert.deepEqual(result.first, {
    kind: 'harness_model_draft_run_result',
    schemaVersion: 1,
    disposition: 'completed',
    sessionId: 'twindesk-model-draft-recovery',
    runId: 'twindesk-model-draft-recovery:turn-1',
    presetId: 'twindesk-communication',
    text: RESPONSE,
    completedAt: result.first.completedAt,
  })
  assert.deepEqual(result.recovered, {
    ...result.first,
    disposition: 'recovered',
  })
  assert.match(result.first.completedAt, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(result.firstRuntimeModelCalls, 1)
  assert.equal(result.recoveryRuntimeModelCalls, 0)
  assert.equal(result.storedTurnEndCount, 1)
  assert.equal(Object.isFrozen(result), true)
})

test('Harness model Draft run rejects empty visible output after durable completion', async (context) => {
  await assert.rejects(
    runProbe(context, 'empty-output', { response: '' }),
    (error) =>
      error instanceof HarnessModelDraftRunError &&
      error.code === 'invalid_output' &&
      !error.message.includes(PROMPT),
  )
})

test('Harness model Draft run requires flush participation and rejects conflicting recovery', async (context) => {
  await assert.rejects(
    runProbe(context, 'flush-refusal', { refuseFlush: true }),
    (error) =>
      error instanceof HarnessModelDraftRunError &&
      error.code === 'persistence_unavailable' &&
      !error.message.includes(PROMPT),
  )
  await assert.rejects(
    runProbe(context, 'conflicting-recovery', {
      recoveryPrompt: 'A different synthetic prompt must not reuse the stored result.',
    }),
    (error) =>
      error instanceof HarnessModelDraftRunError &&
      error.code === 'stored_run_conflict' &&
      !error.message.includes(PROMPT),
  )
})

test('Harness model Draft runner rejects invalid contexts before inspecting requests', () => {
  let accessed = false
  const hostile = Object.defineProperty({}, 'agents', {
    get() {
      accessed = true
      throw new Error(PROMPT)
    },
  })
  assert.throws(
    () => createHarnessModelDraftRunner(hostile),
    (error) =>
      error instanceof HarnessModelDraftRunError &&
      error.code === 'invalid_context' &&
      !error.message.includes(PROMPT),
  )
  assert.equal(accessed, true)
})

test('Harness model Draft runner rejects hostile requests and signals before persistence', async () => {
  let persistenceCalls = 0
  let generationCalls = 0
  const runner = createHarnessModelDraftRunner({
    agents: {
      get() {
        return undefined
      },
      create() {
        generationCalls += 1
      },
    },
    sessions: { flush() {} },
    sessionPersistence: {
      list() {
        persistenceCalls += 1
        return []
      },
      inspect() {},
    },
    agentPresets: { mount() {} },
  })
  let accessed = false
  const hostile = Object.defineProperty({}, 'prompt', {
    enumerable: true,
    get() {
      accessed = true
      throw new Error(PROMPT)
    },
  })
  await assert.rejects(
    runner.run(/** @type {any} */ (hostile)),
    (error) => error instanceof HarnessModelDraftRunError && error.code === 'invalid_request',
  )
  await assert.rejects(
    runner.run(
      {
        kind: 'harness_model_draft_run_request',
        schemaVersion: 1,
        sessionId: 'synthetic-session',
        presetId: 'synthetic-preset',
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        prompt: PROMPT,
        mode: 'create_or_recover',
      },
      /** @type {any} */ ({}),
    ),
    (error) => error instanceof HarnessModelDraftRunError && error.code === 'invalid_request',
  )
  assert.equal(accessed, false)
  assert.equal(persistenceCalls, 0)
  await assert.rejects(
    runner.run({
      kind: 'harness_model_draft_run_request',
      schemaVersion: 1,
      sessionId: 'synthetic-recovery-only-session',
      presetId: 'synthetic-preset',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      prompt: PROMPT,
      mode: 'recover_only',
    }),
    (error) => error instanceof HarnessModelDraftRunError && error.code === 'stored_run_conflict',
  )
  assert.equal(persistenceCalls, 1)
  assert.equal(generationCalls, 0)

  let inspected = false
  const activeRunner = createHarnessModelDraftRunner({
    agents: {
      get() {
        return {}
      },
      create() {
        generationCalls += 1
      },
    },
    sessions: { flush() {} },
    sessionPersistence: {
      list() {
        return [{ id: 'synthetic-active-session' }]
      },
      inspect() {
        inspected = true
      },
    },
    agentPresets: { mount() {} },
  })
  await assert.rejects(
    activeRunner.run({
      kind: 'harness_model_draft_run_request',
      schemaVersion: 1,
      sessionId: 'synthetic-active-session',
      presetId: 'synthetic-preset',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      prompt: PROMPT,
      mode: 'create_or_recover',
    }),
    (error) => error instanceof HarnessModelDraftRunError && error.code === 'stored_run_conflict',
  )
  assert.equal(inspected, false)
  assert.equal(generationCalls, 0)
})
