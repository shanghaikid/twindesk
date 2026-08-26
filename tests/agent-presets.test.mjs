import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { probeHarnessAgentPresets } from '../packages/harness-adapter/src/testing.ts'
import { apply, inject, name } from '../packages/plugin-work-hub/src/index.ts'
import {
  BUILT_IN_PERSONA_CONFIGURATIONS,
  mapPersonaConfigurationToPreset,
} from '../packages/plugin-work-hub/src/persona-presets.ts'

const fixtureRequest =
  "A dependency upgrade may delay Friday's release by two days. Prepare the next step."

test('two Agent Presets produce distinct scoped behavior from the same fixture', async () => {
  const technicalMapping = mapPersonaConfigurationToPreset(BUILT_IN_PERSONA_CONFIGURATIONS[0])
  const communicationMapping = mapPersonaConfigurationToPreset(BUILT_IN_PERSONA_CONFIGURATIONS[1])
  const result = await probeHarnessAgentPresets({
    presetRoot: resolve('packages/bundle-workbench/agent-presets'),
    plugin: { apply, inject, name },
    technicalPresetId: technicalMapping.presetId,
    communicationPresetId: communicationMapping.presetId,
    fixtureRequest,
  })

  assert.equal(result.fixtureRequest, fixtureRequest)
  assert.match(result.technical.systemPrompt, /TwinDesk Technical Lead Persona/u)
  assert.match(result.communication.systemPrompt, /TwinDesk Communication Persona/u)
  assert.equal(result.technical.systemPrompt.includes(technicalMapping.configuration.mission), true)
  assert.equal(
    result.communication.systemPrompt.includes(communicationMapping.configuration.mission),
    true,
  )
  assert.deepEqual(result.technical.advertisedTools, technicalMapping.advertisedTools)
  assert.deepEqual(result.communication.advertisedTools, communicationMapping.advertisedTools)
  assert.deepEqual(result.technical.skills, technicalMapping.advertisedSkills)
  assert.deepEqual(result.communication.skills, communicationMapping.advertisedSkills)
  assert.match(result.technical.response, /^Technical assessment:/u)
  assert.match(result.technical.response, /Draft only; no external action was performed\.$/u)
  assert.match(result.communication.response, /^Stakeholder draft:/u)
  assert.match(result.communication.response, /Draft only; not sent\.$/u)
  assert.notEqual(result.technical.response, result.communication.response)
  assert.deepEqual(result.communicationToolsAfterTechnicalDisposal, ['skill', 'twindesk_status'])
  assert.deepEqual(result.globalToolsAfterPluginDisposal, [])

  const modelFacingTools = [
    ...result.technical.advertisedTools,
    ...result.communication.advertisedTools,
  ]
  assert.equal(
    modelFacingTools.some((tool) => /(?:send|write|delete|shell|bash)/u.test(tool)),
    false,
  )
  assert.equal(Object.isFrozen(result), true)
})
