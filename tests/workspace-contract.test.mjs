import assert from 'node:assert/strict'
import test from 'node:test'

import { packageNamesByDirectory, validateWorkspace } from '../scripts/workspace-contract.mjs'

test('the Stage 0 workspace exposes every planned package scaffold', () => {
  assert.deepEqual([...packageNamesByDirectory.keys()].sort(), [
    'bundle-workbench',
    'domain',
    'harness-adapter',
    'plugin-feishu',
    'plugin-jira',
    'plugin-ui',
    'plugin-work-hub',
    'storage-sqlite',
  ])
})

test('the repository satisfies the workspace scaffold contract', async () => {
  assert.deepEqual(await validateWorkspace(process.cwd()), [])
})
