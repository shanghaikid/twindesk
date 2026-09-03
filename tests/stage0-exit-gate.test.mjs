import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the TD-052 audit advances Stage 1 through the product-owned Web shell', async () => {
  const [gate, proposal, tracker, report, roadmap, oldDecision, decision, manifest] =
    await Promise.all([
      readFile(new URL('../docs/STAGE_0_EXIT_GATE.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/HARNESS_UPSTREAM_NAVIGATION_PROPOSAL.md', import.meta.url), 'utf8'),
      readFile(new URL('../TODO.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/STAGE_0_COMPATIBILITY_REPORT.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8'),
      readFile(
        new URL(
          '../docs/decisions/0001-upstream-generic-inbox-extension-points.md',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL('../docs/decisions/0002-twindesk-owned-product-web-shell.md', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    ])

  assert.match(gate, /\*\*PASSED\. Stage 1 may begin\.\*\*/u)
  assert.equal(
    gate.includes(
      `Harness package: \`@deepseek-ai/dsh@${manifest.devDependencies['@deepseek-ai/dsh']}\``,
    ),
    true,
  )
  assert.equal([...gate.matchAll(/\| \*\*Fail\*\* \|/gu)].length, 0)
  assert.equal([...gate.matchAll(/\| \*\*Pass\*\* \|/gu)].length, 4)
  assert.match(gate, /Harness Web UI -> runtime and Client compatibility diagnostics only/u)
  assert.match(gate, /no Work Hub API/u)

  assert.match(
    proposal,
    /Status: Reference draft — not submitted and not a TwinDesk product blocker/u,
  )
  assert.match(proposal, /optional ecosystem input/u)
  assert.equal(
    proposal.includes(
      `Evidence revision: \`dsh-v${manifest.devDependencies['@deepseek-ai/dsh']}\``,
    ),
    true,
  )

  assert.match(tracker, /- \[x\] \*\*TD-052 — Pass the Stage 0 exit gate\*\*/u)
  assert.match(tracker, /Gate audit \(2026-08-26\): \*\*PASSED\*\*/u)
  assert.match(tracker, /## Completed Milestone: Stage 1 — Local Work Hub/u)
  assert.match(tracker, /## Current Milestone: Stage 2 — Feishu Closed-Loop MVP/u)

  assert.match(
    report,
    /\*\*GO for Stage 1 with Harness retained as a replaceable Agent Runtime\.\*\*/u,
  )
  assert.match(roadmap, /Current gate status \(2026-08-26\): \*\*PASSED\*\*/u)
  assert.match(oldDecision, /Status: Superseded by \[ADR 0002\]/u)
  assert.match(decision, /- Status: Accepted/u)
  assert.match(decision, /TwinDesk will own a standalone, local Web application/u)
  assert.match(decision, /No Harness fork or core patch is required/u)
})
