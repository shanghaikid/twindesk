import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FeishuOAuthRotationJournal } from '../packages/plugin-feishu/dist/index.js'
import { createWorkbenchFeishuOAuthRecoveryPresentation } from '../packages/bundle-workbench/dist/index.js'

const SOURCE = '2026-08-31T08:00:00.000Z'
const RESERVED = '2026-08-31T08:01:00.000Z'
const SETTLED = '2026-08-31T08:02:00.000Z'
const RESULT = '2026-08-31T08:01:30.000Z'

/** @param {import('node:test').TestContext} context @param {string} name */
async function journalFixture(context, name) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-recovery-${name}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  return new FeishuOAuthRotationJournal(join(root, 'rotation.jsonl'))
}

/** @param {FeishuOAuthRotationJournal} journal */
function presentation(journal) {
  return createWorkbenchFeishuOAuthRecoveryPresentation({ rotationJournal: journal })
}

test('Workbench minimizes durable OAuth recovery states without identifiers or timestamps', async (context) => {
  const empty = await journalFixture(context, 'empty')
  assert.deepEqual(await presentation(empty).read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'not_started',
  })

  const active = await journalFixture(context, 'active')
  const activeReservation = await active.reserve(SOURCE, RESERVED)
  assert.deepEqual(await presentation(active).read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'rotation_active',
  })
  await active.settle(activeReservation.sequence, 'completed', SETTLED, RESULT)
  assert.deepEqual(await presentation(active).read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'ready',
  })

  const uncertain = await journalFixture(context, 'uncertain')
  const uncertainReservation = await uncertain.reserve(SOURCE, RESERVED)
  await uncertain.settle(uncertainReservation.sequence, 'uncertain', SETTLED)
  assert.deepEqual(await presentation(uncertain).read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'reconciliation_required',
  })

  const reauthorization = await journalFixture(context, 'reauthorization')
  const reauthorizationReservation = await reauthorization.reserve(SOURCE, RESERVED)
  await reauthorization.settle(
    reauthorizationReservation.sequence,
    'reauthorization_required',
    SETTLED,
  )
  assert.deepEqual(await presentation(reauthorization).read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'reauthorization_required',
  })

  for (const result of [
    await presentation(empty).read(),
    await presentation(active).read(),
    await presentation(uncertain).read(),
    await presentation(reauthorization).read(),
  ]) {
    assert.deepEqual(Object.keys(result).sort(), ['connectorId', 'state', 'version'])
    assert.doesNotMatch(
      JSON.stringify(result),
      /sequence|timestamp|obtained|recorded|principal|account/iu,
    )
  }
})

test('Workbench treats a reserved journal from another process as reconciliation-required', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-recovery-stale-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'rotation.jsonl')
  await writeFile(
    path,
    `${JSON.stringify({
      kind: 'feishu_oauth_rotation_event',
      schemaVersion: 2,
      sequence: 1,
      state: 'reserved',
      sourceObtainedAt: SOURCE,
      recordedAt: RESERVED,
    })}\n`,
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
  assert.equal(
    (await presentation(new FeishuOAuthRotationJournal(path)).read()).state,
    'reconciliation_required',
  )
})

test('Workbench recovery presentation rejects hostile options without reading accessors', () => {
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'rotationJournal', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-recovery-option')
    },
  })
  assert.throws(
    () => createWorkbenchFeishuOAuthRecoveryPresentation(/** @type {never} */ (hostile)),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})
