import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { probeHarnessCodexSubagent } from '../packages/harness-adapter/src/codex-testing.ts'

test('Codex specialist stays read-only and reports a traceable bounded result', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'twindesk-codex-subagent-'))
  try {
    const result = await probeHarnessCodexSubagent({ temporaryRoot })

    assert.equal(result.provider, 'twindesk-codex-readonly-probe')
    assert.deepEqual(result.providerCapabilities, {
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    assert.equal(result.inheritsParentContext, false)
    assert.equal(result.toolHasBackgroundArgument, false)
    assert.equal(result.leadResultText, 'Lead accepted the attributed Codex result.')
    assert.equal(result.leadObservedChildResult, true)
    assert.deepEqual(
      result.leadToolTrace.map(({ type, name, isError }) => ({ type, name, isError })),
      [
        { type: 'tool/call', name: 'subagent_codex', isError: undefined },
        { type: 'tool/result', name: undefined, isError: false },
      ],
    )
    assert.match(result.leadToolTrace[1]?.text ?? '', /Repository title: TwinDesk Fixture/)

    assert.equal(result.lifecycleStarts.length, 3)
    assert.equal(result.lifecycleEnds.length, 3)
    assert.deepEqual(
      result.lifecycleStarts.map(({ runId, provider, id, local }) => ({
        runId,
        provider,
        id,
        local,
      })),
      result.lifecycleEnds.map(({ runId, provider, id, local }) => ({
        runId,
        provider,
        id,
        local,
      })),
    )
    assert.equal(result.lifecycleEnds[0]?.stopReason, 'completed')
    assert.equal(result.lifecycleEnds[0]?.lastAssistantText, 'Repository title: TwinDesk Fixture.')
    assert.equal(result.lifecycleEnds[1]?.stopReason, 'completed')
    assert.equal(result.lifecycleEnds[2]?.stopReason, 'aborted')

    assert.ok(
      result.advertisedNativeTools.includes('exec_command') ||
        result.advertisedNativeTools.includes('shell_command'),
    )
    assert.equal(result.advertisedNativeTools.includes('subagent_codex'), false)
    assert.equal(result.advertisedNativeTools.includes('spawn_agent'), false)
    assert.equal(result.readEvidenceObservedByModel, true)
    assert.equal(result.writeMarkerExists, false)
    assert.equal(result.cancellationStopReason, 'aborted')

    assert.equal(result.depthRejection.code, 'UNSUPPORTED_CAPABILITY')
    assert.match(result.depthRejection.message, /depthLimit/)
    assert.equal(result.toolFilterRejection.code, 'UNSUPPORTED_CAPABILITY')
    assert.match(result.toolFilterRejection.message, /toolFilter/)
    assert.match(result.numericDepthMountRejection.message, /cannot enforce maxDepth/)
    assert.equal(
      result.requestsAfterCapabilityRejections,
      result.requestsBeforeCapabilityRejections,
      'unsupported capability requests must fail before a child process reaches the model',
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
