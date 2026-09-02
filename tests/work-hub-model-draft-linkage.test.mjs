import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseAuditRecord,
  parseDraft,
  parseDraftStateTransition,
} from '../packages/domain/dist/index.js'
import { createFixtureInboxServiceFromDatabase } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  createWorkHubModelDraftLinkage,
  WorkHubModelDraftLinkageError,
} from '../packages/plugin-work-hub/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

const DRAFTED_AT = '2026-08-26T10:00:00.000Z'
const PRIVATE_VALUE = 'synthetic-private-model-draft-linkage'

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryDatabase(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-model-draft-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'twindesk.sqlite3')
}

/** @param {Record<string, unknown>} [changes] */
function request(changes = {}) {
  return /** @type {any} */ ({
    kind: 'work_hub_model_draft_linkage_request',
    schemaVersion: 1,
    draft: parseDraft({
      kind: 'draft',
      schemaVersion: 1,
      id: 'draft-model-linked-synthetic',
      workItemId: 'fixture-work-item-release-risk-question',
      personaId: 'communication',
      sessionId: 'session-model-linked-synthetic',
      runId: 'run-model-linked-synthetic',
      revision: 1,
      state: 'editing',
      content: {
        mediaType: 'text/plain',
        text: 'Synthetic model output retained only in the local Draft.',
      },
      rationale: 'User-visible synthetic decision summary.',
      createdAt: DRAFTED_AT,
      updatedAt: DRAFTED_AT,
      ...changes,
    }),
  })
}

/** @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} database */
function seed(database) {
  const fixture = createFixtureInboxServiceFromDatabase(database)
  fixture.close()
}

test('model Draft linkage persists the exact Session and Run chain across restart', async (context) => {
  const path = await temporaryDatabase(context, 'restart')
  const database = openTwinDeskDatabase(path)
  seed(database)
  const linkage = createWorkHubModelDraftLinkage({ database })

  const inserted = linkage.record(request())
  assert.equal(inserted.disposition, 'inserted')
  assert.equal(inserted.draft.state, 'editing')
  assert.equal(inserted.draft.sessionId, 'session-model-linked-synthetic')
  assert.equal(inserted.draft.runId, 'run-model-linked-synthetic')
  assert.deepEqual(inserted.audit.references, [
    { kind: 'work_item', id: 'fixture-work-item-release-risk-question' },
    { kind: 'draft', id: 'draft-model-linked-synthetic' },
    { kind: 'session', id: 'session-model-linked-synthetic' },
    { kind: 'run', id: 'run-model-linked-synthetic' },
  ])
  assert.deepEqual(inserted.audit.details, {
    modelInvocation: true,
    revision: 1,
    state: 'editing',
  })
  database.close()

  const restarted = openTwinDeskDatabase(path)
  context.after(() => restarted.close())
  assert.equal(
    createWorkHubModelDraftLinkage({ database: restarted }).record(request()).disposition,
    'duplicate',
  )
  assert.equal(
    restarted.queryAuditTimeline({
      reference: /** @type {any} */ ({ kind: 'run', id: 'run-model-linked-synthetic' }),
      limit: 10,
    }).records.length,
    1,
  )
})

test('model Draft linkage repairs interrupted Audit without repeating Draft creation', async (context) => {
  const path = await temporaryDatabase(context, 'repair')
  const database = openTwinDeskDatabase(path)
  context.after(() => database.close())
  seed(database)
  const raw = new DatabaseSync(path)
  raw.exec(`
    CREATE TRIGGER fail_model_draft_audit
    BEFORE INSERT ON audit_records
    WHEN NEW.id = 'draft-model-linked-synthetic:model-run'
    BEGIN
      SELECT RAISE(ABORT, '${PRIVATE_VALUE}');
    END
  `)
  raw.close()
  const linkage = createWorkHubModelDraftLinkage({ database })

  assert.throws(
    () => linkage.record(request()),
    (error) =>
      error instanceof WorkHubModelDraftLinkageError &&
      error.code === 'audit_unavailable' &&
      !error.message.includes(PRIVATE_VALUE),
  )
  assert.ok(database.getDraft(/** @type {any} */ ('draft-model-linked-synthetic')) !== undefined)
  assert.equal(
    database.getAuditRecord(/** @type {any} */ ('draft-model-linked-synthetic:model-run')),
    undefined,
  )
  database.transitionDraft(
    /** @type {any} */ (
      parseDraftStateTransition({
        kind: 'draft_state_transition',
        schemaVersion: 1,
        id: 'transition-model-linked-ready-for-review',
        draftId: 'draft-model-linked-synthetic',
        fromState: 'editing',
        toState: 'ready_for_review',
        occurredAt: '2026-08-26T10:01:00.000Z',
      })
    ),
  )

  const repair = new DatabaseSync(path)
  repair.exec('DROP TRIGGER fail_model_draft_audit')
  repair.close()
  const repaired = linkage.record(request())
  assert.equal(repaired.disposition, 'repaired')
  assert.equal(repaired.draft.state, 'ready_for_review')
  assert.equal(repaired.audit.occurredAt, DRAFTED_AT)
  const audit = database.getAuditRecord(
    /** @type {any} */ ('draft-model-linked-synthetic:model-run'),
  )
  assert.ok(audit !== undefined)
  assert.equal(JSON.stringify(audit).includes('Synthetic model output retained'), false)
  assert.equal(JSON.stringify(audit).includes(PRIVATE_VALUE), false)
})

test('model Draft linkage rejects incomplete runtime chains and hostile requests before writes', () => {
  const database = openTwinDeskDatabase(':memory:')
  seed(database)
  const linkage = createWorkHubModelDraftLinkage({ database })
  const valid = request()
  const missingSession = /** @type {any} */ ({ ...valid, draft: { ...valid.draft } })
  delete missingSession.draft.sessionId
  const missingRun = /** @type {any} */ ({ ...valid, draft: { ...valid.draft } })
  delete missingRun.draft.runId
  const readyForReview = /** @type {any} */ ({
    ...valid,
    draft: { ...valid.draft, state: 'ready_for_review' },
  })
  const identifyingRun = /** @type {any} */ ({
    ...valid,
    draft: { ...valid.draft, runId: 'run id with unsafe whitespace' },
  })
  const oversized = request({ content: { mediaType: 'text/plain', text: 'x'.repeat(65 * 1_024) } })
  for (const invalid of [missingSession, missingRun, readyForReview, identifyingRun, oversized]) {
    assert.throws(
      () => linkage.record(invalid),
      (error) => error instanceof WorkHubModelDraftLinkageError && error.code === 'invalid_request',
    )
  }
  let accessed = false
  const hostile = Object.defineProperty({}, 'draft', {
    enumerable: true,
    get() {
      accessed = true
      throw new Error(PRIVATE_VALUE)
    },
  })
  assert.throws(
    () => linkage.record(/** @type {never} */ (hostile)),
    (error) =>
      error instanceof WorkHubModelDraftLinkageError &&
      error.code === 'invalid_request' &&
      !error.message.includes(PRIVATE_VALUE),
  )
  assert.equal(accessed, false)
  assert.equal(database.queryAuditTimeline({ limit: 10 }).records.length, 0)
  database.close()
})

test('model Draft linkage options reject hostile database accessors', () => {
  let accessed = false
  const hostile = Object.defineProperty({}, 'database', {
    enumerable: true,
    get() {
      accessed = true
      throw new Error(PRIVATE_VALUE)
    },
  })
  assert.throws(
    () => createWorkHubModelDraftLinkage(/** @type {never} */ (hostile)),
    (error) =>
      error instanceof WorkHubModelDraftLinkageError &&
      error.code === 'invalid_options' &&
      !error.message.includes(PRIVATE_VALUE),
  )
  assert.equal(accessed, false)
})

test('model Draft linkage fails closed on closed storage and conflicting Audit evidence', () => {
  const closed = openTwinDeskDatabase(':memory:')
  seed(closed)
  const closedLinkage = createWorkHubModelDraftLinkage({ database: closed })
  closed.close()
  assert.throws(
    () => closedLinkage.record(request()),
    (error) => error instanceof WorkHubModelDraftLinkageError && error.code === 'draft_unavailable',
  )

  const database = openTwinDeskDatabase(':memory:')
  seed(database)
  const input = request()
  database.createDraft(input.draft)
  database.appendAuditRecords([
    /** @type {any} */ (
      parseAuditRecord({
        kind: 'audit_record',
        schemaVersion: 1,
        id: 'draft-model-linked-synthetic:model-run',
        category: 'run',
        outcome: 'success',
        actor: { type: 'persona', id: 'communication' },
        summary: 'Conflicting synthetic runtime evidence.',
        references: [
          { kind: 'work_item', id: 'fixture-work-item-release-risk-question' },
          { kind: 'draft', id: 'draft-model-linked-synthetic' },
          { kind: 'session', id: 'session-model-linked-synthetic' },
          { kind: 'run', id: 'run-model-linked-synthetic' },
        ],
        details: { modelInvocation: false },
        occurredAt: DRAFTED_AT,
      })
    ),
  ])
  const linkage = createWorkHubModelDraftLinkage({ database })
  assert.throws(
    () => linkage.record(input),
    (error) => error instanceof WorkHubModelDraftLinkageError && error.code === 'audit_unavailable',
  )
  assert.equal(database.queryAuditTimeline({ limit: 10 }).records.length, 1)
  database.close()
})

test('model Draft linkage rejects malformed collaborator results without leaking accessors', () => {
  const input = request()
  let accessed = false
  const malformedDraft = createWorkHubModelDraftLinkage({
    database: /** @type {never} */ ({
      createDraft() {
        return Object.defineProperty({}, 'disposition', {
          enumerable: true,
          get() {
            accessed = true
            throw new Error(PRIVATE_VALUE)
          },
        })
      },
      appendAuditRecords() {
        throw new Error('must not run')
      },
    }),
  })
  assert.throws(
    () => malformedDraft.record(input),
    (error) =>
      error instanceof WorkHubModelDraftLinkageError &&
      error.code === 'draft_unavailable' &&
      !error.message.includes(PRIVATE_VALUE),
  )
  assert.equal(accessed, false)

  const malformedAudit = createWorkHubModelDraftLinkage({
    database: /** @type {never} */ ({
      createDraft() {
        return Object.freeze({ disposition: 'inserted', draft: input.draft })
      },
      appendAuditRecords() {
        return Object.freeze({ insertedCount: 1, duplicateCount: 0, items: Object.freeze([]) })
      },
    }),
  })
  assert.throws(
    () => malformedAudit.record(input),
    (error) => error instanceof WorkHubModelDraftLinkageError && error.code === 'audit_unavailable',
  )
})
