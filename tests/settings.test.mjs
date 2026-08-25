import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { probeHarnessBooleanSettingPlugin } from '../packages/harness-adapter/src/testing.ts'
import {
  apply,
  inject,
  name,
  TWIN_DESK_INCLUDE_ROADMAP_STAGE_SETTING,
  TWIN_DESK_STATUS_TOOL_NAME,
  TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE,
} from '../packages/plugin-work-hub/src/index.ts'

test('Work Hub settings persist across restart and reject undeclared secret-like fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twindesk-settings-'))
  const secretMarker = 'synthetic-secret-must-not-persist'

  try {
    const result = await probeHarnessBooleanSettingPlugin(
      { apply, inject, name },
      {
        filePath: join(directory, 'settings.yaml'),
        namespace: TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE,
        key: TWIN_DESK_INCLUDE_ROADMAP_STAGE_SETTING,
        updatedValue: false,
        rejectedPatch: { apiKey: secretMarker },
        toolName: TWIN_DESK_STATUS_TOOL_NAME,
      },
    )

    assert.deepEqual(result.initialValue, { includeRoadmapStage: true })
    assert.deepEqual(result.updatedValue, { includeRoadmapStage: false })
    assert.deepEqual(result.recoveredValue, { includeRoadmapStage: false })
    const statusWithoutRoadmapStage = {
      product: 'TwinDesk',
      autonomyMode: 'draft_only',
      ready: true,
    }
    assert.deepEqual(result.toolValueAfterUpdate, statusWithoutRoadmapStage)
    assert.deepEqual(result.toolValueAfterRestart, statusWithoutRoadmapStage)

    const descriptorAfterRejection =
      /** @type {{ ns: string, value: unknown, user?: unknown, applies: string, secrets?: unknown[] }} */ (
        result.browserDescriptorAfterRejection
      )
    const descriptorAfterRestart =
      /** @type {{ ns: string, value: unknown, user?: unknown, applies: string, secrets?: unknown[] }} */ (
        result.browserDescriptorAfterRestart
      )
    for (const descriptor of [descriptorAfterRejection, descriptorAfterRestart]) {
      assert.equal(descriptor.ns, TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE)
      assert.deepEqual(descriptor.value, { includeRoadmapStage: false })
      assert.deepEqual(descriptor.user, { includeRoadmapStage: false })
      assert.equal(descriptor.applies, 'live')
      assert.deepEqual(descriptor.secrets, [])
      assert.doesNotMatch(JSON.stringify(descriptor), /role[^a-zA-Z0-9]+secret/u)
    }

    assert.deepEqual(result.rejectedDiagnostic, {
      name: 'TypeError',
      message: `settings namespace "${TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE}" accepts only declared fields`,
    })
    for (const boundary of [
      JSON.stringify(result.browserDescriptorAfterRejection),
      JSON.stringify(result.browserDescriptorAfterRestart),
      JSON.stringify(result.rejectedDiagnostic),
      result.persistedDocument,
    ]) {
      assert.doesNotMatch(boundary, /apiKey/u)
      assert.doesNotMatch(boundary, new RegExp(secretMarker, 'u'))
    }
    assert.match(result.persistedDocument, /includeRoadmapStage: false/u)
    assert.deepEqual(result.namespacesAfterPluginDisposal, [])
    assert.deepEqual(result.toolsAfterPluginDisposal, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
