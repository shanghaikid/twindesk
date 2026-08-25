import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { probeHarnessAgentPresets } from '../packages/harness-adapter/src/testing.ts'
import {
  apply,
  inject,
  name,
  TWIN_DESK_STATUS_TOOL_NAME,
} from '../packages/plugin-work-hub/src/index.ts'
import { TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME } from '../packages/plugin-work-hub/src/technical-context.ts'

const fixtureRequest =
  "A dependency upgrade may delay Friday's release by two days. Prepare the next step."

test('two Agent Presets produce distinct scoped behavior from the same fixture', async () => {
  const result = await probeHarnessAgentPresets({
    presetRoot: resolve('packages/bundle-workbench/agent-presets'),
    plugin: { apply, inject, name },
    technicalPresetId: 'twindesk-technical-lead',
    communicationPresetId: 'twindesk-communication',
    fixtureRequest,
  })

  assert.equal(result.fixtureRequest, fixtureRequest)
  assert.match(result.technical.systemPrompt, /TwinDesk Technical Lead Persona/u)
  assert.match(result.communication.systemPrompt, /TwinDesk Communication Persona/u)
  assert.deepEqual(result.technical.advertisedTools, [
    'skill',
    TWIN_DESK_STATUS_TOOL_NAME,
    TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME,
  ])
  assert.deepEqual(result.communication.advertisedTools, ['skill', TWIN_DESK_STATUS_TOOL_NAME])
  assert.deepEqual(result.technical.skills, ['technical-risk-review'])
  assert.deepEqual(result.communication.skills, ['stakeholder-update'])
  assert.match(result.technical.response, /^Technical assessment:/u)
  assert.match(result.technical.response, /Draft only; no external action was performed\.$/u)
  assert.match(result.communication.response, /^Stakeholder draft:/u)
  assert.match(result.communication.response, /Draft only; not sent\.$/u)
  assert.notEqual(result.technical.response, result.communication.response)
  assert.deepEqual(result.communicationToolsAfterTechnicalDisposal, [
    'skill',
    TWIN_DESK_STATUS_TOOL_NAME,
  ])
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
