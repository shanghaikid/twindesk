import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the Stage 0 report stays aligned with the pinned compatibility baseline', async () => {
  const [report, versionRecord, manifest] = await Promise.all([
    readFile(new URL('../docs/STAGE_0_COMPATIBILITY_REPORT.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/HARNESS_VERSION.md', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ])
  const commit = versionRecord.match(/\| Git commit \| `([a-f0-9]{40})` \|/u)?.[1]
  assert.ok(commit)
  assert.equal(report.includes(`Harness commit: \`${commit}\``), true)
  assert.equal(
    report.includes(
      `Harness package: \`@deepseek-ai/dsh@${manifest.devDependencies['@deepseek-ai/dsh']}\``,
    ),
    true,
  )
  assert.match(
    report,
    /\*\*GO for Stage 1 with Harness retained as a replaceable Agent Runtime\.\*\*/u,
  )
  assert.match(report, /No TwinDesk-specific Harness core patch or fork is approved\./u)
  assert.match(
    report,
    /No public Harness primary navigation, keyed page registry, or route service/u,
  )
  assert.match(report, /TwinDesk product delivery does not depend on it/u)
  assert.match(report, /compat:check/u)
  assert.match(report, /## Implementation Surface Estimate/u)
  assert.match(report, /## Gate Completion Record/u)
})
