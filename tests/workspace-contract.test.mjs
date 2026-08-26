import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateDependencyBoundaries } from '../scripts/dependency-boundary.mjs'
import { packageNamesByDirectory, validateWorkspace } from '../scripts/workspace-contract.mjs'

test('the workspace exposes every planned package scaffold', () => {
  assert.deepEqual([...packageNamesByDirectory.keys()].sort(), [
    'bundle-workbench',
    'domain',
    'harness-adapter',
    'plugin-feishu',
    'plugin-jira',
    'plugin-ui',
    'plugin-work-hub',
    'storage-sqlite',
    'web',
  ])
})

test('the repository satisfies the workspace scaffold contract', async () => {
  assert.deepEqual(await validateWorkspace(process.cwd()), [])
})

test('dependency boundaries reject upstream and UI dependencies in domain', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-boundary-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))

  const domainRoot = join(root, 'packages', 'domain')
  await mkdir(join(domainRoot, 'src'), { recursive: true })
  await writeFile(
    join(domainRoot, 'package.json'),
    JSON.stringify({
      name: '@twindesk/domain',
      dependencies: { react: '18.3.1' },
    }),
  )
  await writeFile(join(domainRoot, 'src', 'index.ts'), "import '@deepseek-ai/cordis'\n")

  const pluginRoot = join(root, 'packages', 'plugin-ui')
  await mkdir(join(pluginRoot, 'src'), { recursive: true })
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@twindesk/plugin-ui' }))
  await writeFile(
    join(pluginRoot, 'src', 'index.ts'),
    [
      '/// <reference types="@deepseek-ai/dsh-app-boot" />',
      "const agent = require('@deepseek-ai/dsh-agent')",
      'void agent',
      '',
    ].join('\n'),
  )

  const errors = await validateDependencyBoundaries(root)
  assert.equal(
    errors.some((error) => error.includes('must not declare react')),
    true,
  )
  assert.equal(
    errors.some((error) => error.includes('must import @deepseek-ai/cordis through')),
    true,
  )
  assert.equal(
    errors.some((error) => error.includes('must import @deepseek-ai/dsh-app-boot through')),
    true,
  )
  assert.equal(
    errors.some((error) => error.includes('must import @deepseek-ai/dsh-agent through')),
    true,
  )
  assert.equal(errors.filter((error) => error.includes('@deepseek-ai/cordis')).length, 1)
})

test('dependency boundary diagnostics handle a missing packages directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-boundary-missing-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))

  const errors = await validateDependencyBoundaries(root)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /^Cannot inspect packages:/u)
})
