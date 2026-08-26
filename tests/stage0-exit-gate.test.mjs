import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the TD-052 audit keeps Stage 1 gated while its product criterion fails', async () => {
  const [gate, tracker, report, roadmap, decision, manifest] = await Promise.all([
    readFile(new URL('../docs/STAGE_0_EXIT_GATE.md', import.meta.url), 'utf8'),
    readFile(new URL('../TODO.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/STAGE_0_COMPATIBILITY_REPORT.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8'),
    readFile(
      new URL('../docs/decisions/0001-upstream-generic-inbox-extension-points.md', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ])

  assert.match(gate, /\*\*NOT PASSED\. Stage 1 remains gated\.\*\*/u)
  assert.equal(
    gate.includes(
      `Harness package: \`@deepseek-ai/dsh@${manifest.devDependencies['@deepseek-ai/dsh']}\``,
    ),
    true,
  )
  assert.equal([...gate.matchAll(/\| \*\*Fail\*\* \|/gu)].length, 1)
  assert.equal([...gate.matchAll(/\| \*\*Pass\*\* \|/gu)].length, 3)
  assert.match(gate, /no Stage 1 backlog item may start/u)

  assert.match(tracker, /- \[ \] \*\*TD-052 — Pass the Stage 0 exit gate\*\*/u)
  assert.match(tracker, /Latest gate audit \(2026-08-26\): \*\*NOT PASSED\*\*/u)
  assert.match(tracker, /Do not start Stage 1 implementation before TD-052 is complete\./u)

  assert.match(report, /\*\*NO-GO for the Stage 1 gate on the validated Harness revision\.\*\*/u)
  assert.match(roadmap, /Current gate status \(2026-08-26\): \*\*NOT PASSED\*\*/u)
  assert.match(decision, /- Status: Accepted/u)
  assert.match(decision, /will not maintain a Harness fork or a temporary core patch/u)
})
