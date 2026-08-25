import assert from 'node:assert/strict'
import test from 'node:test'

import { probeHarnessToolPlugin } from '../packages/harness-adapter/src/testing.ts'
import {
  apply,
  inject,
  name,
  TWIN_DESK_STATUS,
  TWIN_DESK_STATUS_TOOL_NAME,
} from '../packages/plugin-work-hub/src/index.ts'

test('a keyless Harness Agent invokes twindesk_status and records the Session trace', async () => {
  const result = await probeHarnessToolPlugin({ apply, inject, name }, TWIN_DESK_STATUS_TOOL_NAME)

  assert.deepEqual(result.registeredTools, [TWIN_DESK_STATUS_TOOL_NAME])
  assert.deepEqual(result.advertisedTools, [TWIN_DESK_STATUS_TOOL_NAME])
  assert.deepEqual(result.directValue, TWIN_DESK_STATUS)
  assert.equal(result.cancellationCode, 'ABORTED_BEFORE_DISPATCH')
  assert.deepEqual(result.trace, [
    { type: 'tool/call', name: TWIN_DESK_STATUS_TOOL_NAME },
    {
      type: 'tool/result',
      isError: false,
      text: JSON.stringify(TWIN_DESK_STATUS),
    },
  ])
  assert.deepEqual(result.toolsAfterPluginDisposal, [])
})
