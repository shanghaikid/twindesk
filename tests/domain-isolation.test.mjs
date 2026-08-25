import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

test('domain source loads while Harness and adapter imports are denied', () => {
  const hook = pathToFileURL(resolve('tests/fixtures/deny-upstream-imports.mjs')).href
  const domain = pathToFileURL(resolve('packages/domain/src/index.ts')).href
  const result = spawnSync(
    process.execPath,
    ['--import', hook, '--input-type=module', '--eval', `await import(${JSON.stringify(domain)})`],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr || result.stdout)
})
