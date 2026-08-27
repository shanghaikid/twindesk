import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseActionProposal,
  parseAuditRecord,
  parseDraft,
  parseExternalEvent,
} from '../packages/domain/dist/index.js'
import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  AuditTimelineError,
  computeDraftContentDigest,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ActionProposal} SourceActionProposal */
/** @typedef {import('../packages/domain/src/model.ts').AuditRecord} SourceAuditRecord */
/** @typedef {import('../packages/domain/src/model.ts').Draft} SourceDraft */
/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} SourceExternalEvent */

const WORK_ITEM_ID = /** @type {import('../packages/domain/src/model.ts').WorkItemId} */ (
  /** @type {unknown} */ ('fixture-work-item-release-risk-question')
)
const OTHER_WORK_ITEM_ID = /** @type {import('../packages/domain/src/model.ts').WorkItemId} */ (
  /** @type {unknown} */ ('fixture-work-item-deployment-update-review')
)
const EVENT_ID = 'fixture-event-release-risk-question'
const CONTENT = Object.freeze({ mediaType: 'text/plain', text: 'Synthetic audited reply.' })

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-audit-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'twindesk.sqlite3')
  createFixtureInboxService(path).close()
  return path
}

/**
 * @param {string} id
 * @param {string} occurredAt
 * @param {object} [changes]
 * @returns {SourceAuditRecord}
 */
function audit(id, occurredAt, changes = {}) {
  return /** @type {SourceAuditRecord} */ (
    /** @type {unknown} */ (
      parseAuditRecord({
        kind: 'audit_record',
        schemaVersion: 1,
        id,
        category: 'routing',
        outcome: 'success',
        actor: { type: 'system' },
        summary: 'Synthetic fixture routing completed.',
        references: [
          { kind: 'work_item', id: WORK_ITEM_ID },
          { kind: 'external_event', id: EVENT_ID },
        ],
        details: { fixture: true, source: 'synthetic' },
        occurredAt,
        ...changes,
      })
    )
  )
}

/** @returns {SourceDraft} */
function draft() {
  return /** @type {SourceDraft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'audit-draft-1',
        workItemId: WORK_ITEM_ID,
        personaId: 'communication',
        revision: 1,
        state: 'ready_for_review',
        content: CONTENT,
        createdAt: '2026-08-26T09:16:00Z',
        updatedAt: '2026-08-26T09:16:00Z',
      })
    )
  )
}

/** @param {string} draftId @returns {SourceActionProposal} */
function proposal(draftId) {
  return /** @type {SourceActionProposal} */ (
    /** @type {unknown} */ (
      parseActionProposal({
        kind: 'action_proposal',
        schemaVersion: 1,
        id: 'audit-proposal-1',
        workItemId: WORK_ITEM_ID,
        draftId,
        actionType: 'fixture.reply.preview',
        risk: 'write',
        identity: {
          connectorId: 'fixture',
          accountId: 'synthetic-account',
          identityType: 'user',
          displayName: 'Synthetic User',
        },
        target: {
          connectorId: 'fixture',
          accountId: 'synthetic-account',
          objectType: 'message',
          externalId: 'synthetic-message-release-risk-question',
          sourceTimestamp: '2026-08-26T09:15:00Z',
        },
        content: CONTENT,
        contentDigest: computeDraftContentDigest(CONTENT),
        idempotencyKey: 'fixture:audit:proposal:v1',
        state: 'proposed',
        createdAt: '2026-08-26T09:17:00Z',
        updatedAt: '2026-08-26T09:17:00Z',
      })
    )
  )
}

test('audit records append idempotently and query by Work Item across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const routing = audit('audit-routing-1', '2026-08-26T09:16:00Z')
  const run = audit('audit-run-1', '2026-08-26T09:17:00Z', {
    category: 'run',
    actor: { type: 'persona', id: 'communication' },
    summary: 'Synthetic Persona run completed.',
    references: [
      { kind: 'work_item', id: WORK_ITEM_ID },
      { kind: 'session', id: 'synthetic-session-1' },
      { kind: 'run', id: 'synthetic-run-1' },
      { kind: 'tool_call', id: 'synthetic-tool-call-1' },
    ],
    details: { toolName: 'twindesk_status', fixture: true },
  })
  const result = database.appendAuditRecords([routing, routing, run])
  assert.equal(result.insertedCount, 2)
  assert.equal(result.duplicateCount, 1)
  assert.deepEqual(
    result.items.map(({ disposition }) => disposition),
    ['inserted', 'duplicate', 'inserted'],
  )
  assert.equal(Object.isFrozen(result), true)

  const firstPage = database.queryAuditTimeline({ workItemId: WORK_ITEM_ID, limit: 1 })
  assert.deepEqual(
    firstPage.records.map(({ id }) => id),
    [run.id],
  )
  assert.ok(firstPage.nextCursor)
  const secondPage = database.queryAuditTimeline({
    workItemId: WORK_ITEM_ID,
    limit: 1,
    after: firstPage.nextCursor,
  })
  assert.deepEqual(
    secondPage.records.map(({ id }) => id),
    [routing.id],
  )

  const sameInstantA = audit('audit-same-instant-a', '2026-08-26T09:18:00Z')
  const sameInstantB = audit('audit-same-instant-b', '2026-08-26T09:18:00.000Z')
  database.appendAuditRecords([sameInstantB, sameInstantA])
  const equalTimeFirst = database.queryAuditTimeline({ workItemId: WORK_ITEM_ID, limit: 1 })
  assert.deepEqual(
    equalTimeFirst.records.map(({ id }) => id),
    [sameInstantA.id],
  )
  const equalTimeCursor = equalTimeFirst.nextCursor
  assert.ok(equalTimeCursor)
  const equalTimeSecond = database.queryAuditTimeline({
    workItemId: WORK_ITEM_ID,
    limit: 1,
    after: equalTimeCursor,
  })
  assert.deepEqual(
    equalTimeSecond.records.map(({ id }) => id),
    [sameInstantB.id],
  )
  assert.equal(database.getAuditRecord(routing.id)?.summary, routing.summary)
  database.close()

  const restarted = openTwinDeskDatabase(path)
  const filtered = restarted.queryAuditTimeline({
    reference: { kind: 'session', id: 'synthetic-session-1' },
    categories: ['run'],
    outcomes: ['success'],
  })
  assert.deepEqual(
    filtered.records.map(({ id }) => id),
    [run.id],
  )
  assert.equal(restarted.appendAuditRecords([run]).duplicateCount, 1)
  restarted.close()
})

test('audit references fail closed on conflicts, missing links, mismatches, and chronology', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const routing = audit('audit-boundary-1', '2026-08-26T09:16:00Z')
  database.appendAuditRecords([routing])
  const raw = new DatabaseSync(path)
  assert.throws(
    () =>
      raw
        .prepare('UPDATE audit_records SET summary = ? WHERE id = ?')
        .run('Mutated synthetic summary.', routing.id),
    /audit records are immutable/u,
  )
  assert.throws(
    () =>
      raw
        .prepare('UPDATE audit_references SET reference_id = ? WHERE audit_record_id = ?')
        .run('mutated-reference', routing.id),
    /Audit references are immutable/u,
  )
  raw.close()
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit(routing.id, routing.occurredAt, { summary: 'Conflicting synthetic summary.' }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'record_conflict',
  )
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-missing-event', '2026-08-26T09:16:00Z', {
          references: [
            { kind: 'work_item', id: WORK_ITEM_ID },
            { kind: 'external_event', id: 'missing-event' },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'missing_reference',
  )
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-run-without-session', '2026-08-26T09:16:00Z', {
          category: 'run',
          references: [
            { kind: 'work_item', id: WORK_ITEM_ID },
            { kind: 'run', id: 'synthetic-run-without-session' },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_mismatch',
  )
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-cross-thread', '2026-08-26T09:16:00Z', {
          references: [
            { kind: 'work_item', id: WORK_ITEM_ID },
            { kind: 'work_item', id: OTHER_WORK_ITEM_ID },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_mismatch',
  )

  const storedDraft = draft()
  database.createDraft(storedDraft)
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-wrong-work-item', '2026-08-26T09:18:00Z', {
          category: 'draft',
          references: [
            { kind: 'work_item', id: OTHER_WORK_ITEM_ID },
            { kind: 'draft', id: storedDraft.id },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_mismatch',
  )
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-before-draft', '2026-08-26T09:15:30Z', {
          category: 'draft',
          references: [
            { kind: 'work_item', id: WORK_ITEM_ID },
            { kind: 'draft', id: storedDraft.id },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_chronology',
  )

  const delayedEvent = /** @type {SourceExternalEvent} */ (
    /** @type {unknown} */ (
      parseExternalEvent({
        kind: 'external_event',
        schemaVersion: 1,
        id: 'audit-delayed-event',
        idempotencyKey: 'fixture:audit:delayed-event:v1',
        source: {
          connectorId: 'fixture',
          accountId: 'synthetic-account',
          objectType: 'message',
          externalId: 'synthetic-delayed-message',
        },
        eventType: 'message.received',
        occurredAt: '2026-08-26T09:00:00Z',
        receivedAt: '2026-08-26T09:10:00Z',
        context: { status: 'complete' },
        normalized: { fixture: true },
      })
    )
  )
  database.ingestExternalEvents([delayedEvent])
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-before-local-receive', '2026-08-26T09:05:00Z', {
          category: 'ingestion',
          references: [{ kind: 'external_event', id: delayedEvent.id }],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_chronology',
  )
  assert.throws(
    () =>
      database.appendAuditRecords([
        audit('audit-unlinked-event', '2026-08-26T09:16:00Z', {
          category: 'ingestion',
          references: [
            { kind: 'work_item', id: WORK_ITEM_ID },
            { kind: 'external_event', id: delayedEvent.id },
          ],
        }),
      ]),
    (error) => error instanceof AuditTimelineError && error.code === 'reference_mismatch',
  )
  database.close()
})

test('approval and receipt references resolve through their persisted proposal', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const storedDraft = draft()
  const storedProposal = proposal(storedDraft.id)
  database.createDraft(storedDraft)
  database.createActionProposal(storedProposal)
  database.close()

  const fixtureWriter = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  const digest = computeDraftContentDigest(CONTENT)
  fixtureWriter
    .prepare(
      `INSERT INTO approval_records (
         kind, schema_version, id, proposal_id, decision, identity_digest,
         target_digest, content_digest, requested_at, expires_at
       ) VALUES ('approval_record', 1, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      'synthetic-approval-1',
      storedProposal.id,
      digest,
      digest,
      digest,
      '2026-08-26T09:18:00Z',
      '2026-08-26T09:28:00Z',
    )
  fixtureWriter
    .prepare(
      `INSERT INTO action_receipts (
         kind, schema_version, execution_attempt_id, proposal_id, connector_id,
         account_id, idempotency_key, outcome, attempted_at, external_connector_id,
         external_account_id, external_object_type, external_id, external_source_timestamp
       ) VALUES ('action_receipt', 1, ?, ?, 'fixture', 'synthetic-account', ?,
                 'succeeded', ?, 'fixture', 'synthetic-account', 'message', ?, ?)`,
    )
    .run(
      'synthetic-receipt-1',
      storedProposal.id,
      storedProposal.idempotencyKey,
      '2026-08-26T09:19:00Z',
      'synthetic-message-release-risk-question',
      '2026-08-26T09:15:00Z',
    )
  fixtureWriter.close()

  const timeline = openTwinDeskDatabase(path)
  const approvalAudit = audit('audit-approval-1', '2026-08-26T09:18:00Z', {
    category: 'approval',
    outcome: 'pending',
    actor: { type: 'user', id: 'synthetic-user' },
    references: [
      { kind: 'work_item', id: WORK_ITEM_ID },
      { kind: 'action_proposal', id: storedProposal.id },
      { kind: 'approval_record', id: 'synthetic-approval-1' },
    ],
  })
  const receiptAudit = audit('audit-receipt-1', '2026-08-26T09:19:00Z', {
    category: 'execution',
    actor: { type: 'connector', id: 'fixture' },
    references: [
      { kind: 'work_item', id: WORK_ITEM_ID },
      { kind: 'action_proposal', id: storedProposal.id },
      { kind: 'action_receipt', id: 'synthetic-receipt-1' },
    ],
  })
  assert.equal(timeline.appendAuditRecords([approvalAudit, receiptAudit]).insertedCount, 2)
  assert.equal(
    timeline.queryAuditTimeline({
      reference: { kind: 'action_receipt', id: 'synthetic-receipt-1' },
    }).records[0]?.id,
    receiptAudit.id,
  )
  timeline.close()
})

test('an interrupted audit batch rolls back records and references together', async (context) => {
  const path = await temporaryDatabase(context)
  const faultInjector = new DatabaseSync(path)
  faultInjector.exec(`
    CREATE TRIGGER synthetic_audit_reference_failure
    BEFORE INSERT ON audit_references
    BEGIN
      SELECT RAISE(ABORT, 'synthetic audit interruption');
    END;
  `)
  faultInjector.close()

  const database = openTwinDeskDatabase(path)
  assert.throws(
    () => database.appendAuditRecords([audit('audit-interrupted-1', '2026-08-26T09:16:00Z')]),
    (error) => {
      assert.ok(error instanceof AuditTimelineError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic audit interruption'), false)
      return true
    },
  )
  database.close()
  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_records').get()?.count, 0)
  assert.equal(inspection.prepare('SELECT count(*) AS count FROM audit_references').get()?.count, 0)
})

test('audit query boundaries and closed handles fail without payloads', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const secret = 'synthetic-private-audit-value'
  const query = Object.defineProperty({}, 'limit', {
    enumerable: true,
    get: () => secret,
  })
  assert.throws(
    () => database.queryAuditTimeline(query),
    (error) => {
      assert.ok(error instanceof AuditTimelineError)
      assert.equal(error.code, 'invalid_request')
      assert.equal(error.message.includes(secret), false)
      return true
    },
  )
  const record = audit('audit-closed-1', '2026-08-26T09:16:00Z')
  database.close()
  const operations = [
    () => database.appendAuditRecords([record]),
    () => database.getAuditRecord(record.id),
    () => database.queryAuditTimeline(),
  ]
  for (const operation of operations) {
    assert.throws(
      operation,
      (error) => error instanceof AuditTimelineError && error.code === 'database_closed',
    )
  }
})
