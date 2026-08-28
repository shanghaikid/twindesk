import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseActionProposal,
  parseActionProposalStateTransition,
  parseAuditRecord,
  parseDraft,
  parseDraftStateTransition,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'
import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  THREAD_RETENTION_POLICY_V1,
  ThreadLifecycleError,
  WorkItemProjectionError,
  computeDraftContentDigest,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

const THREAD_ID = 'fixture-thread-release-risk-question'
const WORK_ITEM_ID = 'fixture-work-item-release-risk-question'
const EVENT_ID = 'fixture-event-release-risk-question'
const UPDATED_AT = '2026-08-26T09:15:00Z'
const SECRET = 'synthetic-secret-value-td111'
const CONTENT = Object.freeze({
  mediaType: 'text/markdown',
  text: `Synthetic authorized draft containing ${SECRET}.`,
})

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-thread-lifecycle-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'twindesk.sqlite3')
  createFixtureInboxService(path, { includeAudit: true }).close()
  return path
}

/**
 * @param {Record<string, unknown>} [changes]
 * @returns {import('../packages/storage-sqlite/src/thread-lifecycle.ts').ThreadDeletionRequest}
 */
function deletionRequest(changes = {}) {
  return /** @type {import('../packages/storage-sqlite/src/thread-lifecycle.ts').ThreadDeletionRequest} */ (
    /** @type {unknown} */ ({
      kind: 'thread_deletion_request',
      schemaVersion: 1,
      requestId: 'thread-delete:release-risk-question:v1',
      threadId: THREAD_ID,
      expectedUpdatedAt: UPDATED_AT,
      requestedAt: '2026-08-26T10:00:00Z',
      ...changes,
    })
  )
}

/**
 * @param {any} database
 * @param {string} path
 */
function addLifecycleRecords(database, path) {
  database.applyWorkItemUserAction(
    parseWorkItemUserAction({
      kind: 'work_item_user_action',
      schemaVersion: 1,
      id: 'thread-export-persona-action-1',
      workItemId: WORK_ITEM_ID,
      revision: 1,
      action: 'select_persona',
      personaId: 'communication',
      occurredAt: '2026-08-26T09:15:30Z',
    }),
  )
  const draft = parseDraft({
    kind: 'draft',
    schemaVersion: 1,
    id: 'thread-export-draft-1',
    workItemId: WORK_ITEM_ID,
    personaId: 'communication',
    sessionId: 'synthetic-session-td111',
    runId: 'synthetic-run-td111',
    revision: 1,
    state: 'editing',
    content: CONTENT,
    rationale: `Synthetic rationale containing ${SECRET}.`,
    createdAt: '2026-08-26T09:16:00Z',
    updatedAt: '2026-08-26T09:16:00Z',
  })
  database.createDraft(draft)
  database.transitionDraft(
    parseDraftStateTransition({
      kind: 'draft_state_transition',
      schemaVersion: 1,
      id: 'thread-export-draft-ready-1',
      draftId: draft.id,
      fromState: 'editing',
      toState: 'ready_for_review',
      occurredAt: '2026-08-26T09:17:00Z',
    }),
  )
  const proposal = parseActionProposal({
    kind: 'action_proposal',
    schemaVersion: 1,
    id: 'thread-export-proposal-1',
    workItemId: WORK_ITEM_ID,
    draftId: draft.id,
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
      sourceTimestamp: UPDATED_AT,
    },
    content: CONTENT,
    contentDigest: computeDraftContentDigest(CONTENT),
    idempotencyKey: 'fixture:thread-export:proposal:v1',
    state: 'proposed',
    createdAt: '2026-08-26T09:18:00Z',
    updatedAt: '2026-08-26T09:18:00Z',
  })
  database.createActionProposal(proposal)
  database.transitionActionProposal(
    parseActionProposalStateTransition({
      kind: 'action_proposal_state_transition',
      schemaVersion: 1,
      id: 'thread-export-proposal-awaiting-1',
      proposalId: proposal.id,
      fromState: 'proposed',
      toState: 'awaiting_approval',
      occurredAt: '2026-08-26T09:19:00Z',
    }),
  )
  database.transitionActionProposal(
    parseActionProposalStateTransition({
      kind: 'action_proposal_state_transition',
      schemaVersion: 1,
      id: 'thread-export-proposal-rejected-1',
      proposalId: proposal.id,
      fromState: 'awaiting_approval',
      toState: 'rejected',
      occurredAt: '2026-08-26T09:20:00Z',
    }),
  )

  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  raw
    .prepare(
      `INSERT INTO approval_records (
         kind, schema_version, id, proposal_id, decision, identity_digest,
         target_digest, content_digest, requested_at, expires_at
       ) VALUES ('approval_record', 1, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      'thread-export-approval-1',
      proposal.id,
      proposal.contentDigest,
      proposal.contentDigest,
      proposal.contentDigest,
      '2026-08-26T09:21:00Z',
      '2026-08-26T09:31:00Z',
    )
  raw
    .prepare(
      `INSERT INTO action_dispatches (
         kind, schema_version, execution_attempt_id, ordinal, proposal_id, connector_id,
         account_id, idempotency_key, reserved_at, settled_outcome, settled_at
       ) VALUES ('action_dispatch', 1, ?, 1, ?, 'fixture', 'synthetic-account', ?, ?,
                 'succeeded', ?)`,
    )
    .run(
      'thread-export-receipt-1',
      proposal.id,
      proposal.idempotencyKey,
      '2026-08-26T09:21:30Z',
      '2026-08-26T09:22:00Z',
    )
  raw
    .prepare(
      `INSERT INTO action_receipts (
         kind, schema_version, execution_attempt_id, proposal_id, connector_id,
         account_id, idempotency_key, outcome, attempted_at, external_connector_id,
         external_account_id, external_object_type, external_id, external_source_timestamp
       ) VALUES ('action_receipt', 1, ?, ?, 'fixture', 'synthetic-account', ?,
                 'succeeded', ?, 'fixture', 'synthetic-account', 'message', ?, ?)`,
    )
    .run(
      'thread-export-receipt-1',
      proposal.id,
      proposal.idempotencyKey,
      '2026-08-26T09:22:00Z',
      'synthetic-message-release-risk-question',
      UPDATED_AT,
    )
  raw
    .prepare(
      `INSERT INTO connector_cursors (
         kind, schema_version, id, connector_id, account_id, stream,
         position, committed_through, updated_at
       ) VALUES ('connector_cursor', 1, 'thread-export-cursor-1', 'fixture',
                 'synthetic-account', 'messages', 'cursor-after-thread', ?, ?)`,
    )
    .run(UPDATED_AT, '2026-08-26T09:22:00Z')
  raw.close()

  database.appendAuditRecords([
    parseAuditRecord({
      kind: 'audit_record',
      schemaVersion: 1,
      id: 'thread-export-audit-1',
      category: 'execution',
      outcome: 'success',
      actor: { type: 'system' },
      summary: `Synthetic lifecycle audit containing ${SECRET}.`,
      references: [
        { kind: 'work_item', id: WORK_ITEM_ID },
        { kind: 'session', id: 'synthetic-session-td111' },
        { kind: 'run', id: 'synthetic-run-td111' },
        { kind: 'draft', id: draft.id },
        { kind: 'action_proposal', id: proposal.id },
        { kind: 'approval_record', id: 'thread-export-approval-1' },
        { kind: 'action_receipt', id: 'thread-export-receipt-1' },
      ],
      details: {
        fixture: true,
        hiddenReasoning: 'Synthetic hidden reasoning must not be exported.',
      },
      occurredAt: '2026-08-26T09:23:00Z',
    }),
  ])
}

test('Thread export is complete, versioned, immutable, and redacted', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  addLifecycleRecords(database, path)

  const result = database.exportThread({
    kind: 'thread_export_request',
    schemaVersion: 1,
    threadId: /** @type {any} */ (THREAD_ID),
    knownSecrets: [SECRET],
  })
  const document = /** @type {any} */ (result.document)
  const serialized = JSON.stringify(document)
  assert.equal(document.kind, 'thread_export')
  assert.equal(document.schemaVersion, 1)
  assert.deepEqual(document.retentionPolicy, THREAD_RETENTION_POLICY_V1)
  assert.equal(document.thread.id, THREAD_ID)
  assert.equal(document.externalEvents.length, 1)
  assert.equal(document.workItems.length, 1)
  assert.equal(document.workItemProjectionBases.length, 1)
  assert.equal(document.workItemUserActions.length, 1)
  assert.equal(document.drafts.length, 1)
  assert.equal(document.draftCreationRecords.length, 1)
  assert.equal(document.draftStateTransitions.length, 1)
  assert.equal(document.actionProposals.length, 1)
  assert.equal(document.actionProposalCreationRecords.length, 1)
  assert.equal(document.actionProposalStateTransitions.length, 2)
  assert.equal(document.approvalRecords.length, 1)
  assert.equal(document.actionDispatches.length, 1)
  assert.equal(document.actionReceipts.length, 1)
  assert.equal(document.auditRecords.length, 2)
  assert.equal(serialized.includes(SECRET), false)
  assert.equal(serialized.includes('Synthetic hidden reasoning must not be exported.'), false)
  assert.equal(serialized.includes('Synthetic authorized draft'), true)
  assert.ok(result.redaction.counts.known_secret >= 3)
  assert.ok(result.redaction.counts.hidden_reasoning >= 1)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(document), true)
  database.close()
})

test('Thread deletion cascades local data, retains policy state, and replays after restart', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const beforeDeletion = /** @type {any} */ (
    database.exportThread({
      kind: 'thread_export_request',
      schemaVersion: 1,
      threadId: /** @type {any} */ (THREAD_ID),
    }).document
  )
  addLifecycleRecords(database, path)
  const request = deletionRequest()
  const deleted = database.deleteThread(request)
  assert.equal(deleted.disposition, 'deleted')
  assert.deepEqual(deleted.receipt.counts, {
    externalEvents: 1,
    externalThreads: 1,
    workItems: 1,
    workItemProjectionBases: 1,
    workItemUserActions: 1,
    drafts: 1,
    draftCreationRecords: 1,
    draftStateTransitions: 1,
    actionProposals: 1,
    actionProposalCreationRecords: 1,
    actionProposalStateTransitions: 2,
    approvalRecords: 1,
    actionDispatches: 1,
    actionReceipts: 1,
    auditRecords: 2,
  })
  assert.match(deleted.receipt.threadIdentityDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(database.getWorkItem(/** @type {any} */ (WORK_ITEM_ID)), undefined)
  assert.throws(
    () =>
      database.exportThread({
        kind: 'thread_export_request',
        schemaVersion: 1,
        threadId: /** @type {any} */ (THREAD_ID),
      }),
    (error) => error instanceof ThreadLifecycleError && error.code === 'thread_not_found',
  )
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM external_events WHERE id = ?`).get(EVENT_ID)
      ?.count,
    0,
  )
  assert.equal(inspection.prepare(`SELECT count(*) AS count FROM work_items`).get()?.count, 3)
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM connector_cursors`).get()?.count,
    1,
  )
  const receiptRow = inspection.prepare(`SELECT * FROM thread_deletion_receipts`).get()
  assert.ok(receiptRow)
  const receiptText = JSON.stringify(receiptRow)
  assert.equal(receiptText.includes(THREAD_ID), false)
  assert.equal(receiptText.includes(SECRET), false)
  const deletedRecordCounts = [
    { table: 'external_threads', column: 'id', id: THREAD_ID },
    { table: 'work_items', column: 'id', id: WORK_ITEM_ID },
    { table: 'work_item_projection_bases', column: 'work_item_id', id: WORK_ITEM_ID },
    { table: 'work_item_user_actions', column: 'id', id: 'thread-export-persona-action-1' },
    { table: 'drafts', column: 'id', id: 'thread-export-draft-1' },
    { table: 'draft_creation_records', column: 'draft_id', id: 'thread-export-draft-1' },
    { table: 'draft_state_transitions', column: 'id', id: 'thread-export-draft-ready-1' },
    { table: 'action_proposals', column: 'id', id: 'thread-export-proposal-1' },
    {
      table: 'action_proposal_creation_records',
      column: 'proposal_id',
      id: 'thread-export-proposal-1',
    },
    {
      table: 'action_proposal_state_transitions',
      column: 'proposal_id',
      id: 'thread-export-proposal-1',
    },
    { table: 'approval_records', column: 'id', id: 'thread-export-approval-1' },
    {
      table: 'action_dispatches',
      column: 'execution_attempt_id',
      id: 'thread-export-receipt-1',
    },
    {
      table: 'action_receipts',
      column: 'execution_attempt_id',
      id: 'thread-export-receipt-1',
    },
    { table: 'audit_records', column: 'id', id: 'thread-export-audit-1' },
  ]
  for (const { table, column, id } of deletedRecordCounts) {
    assert.equal(
      inspection.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`).get(id)
        ?.count,
      0,
    )
  }
  inspection.close()
  const receiptWriter = new DatabaseSync(path)
  assert.throws(
    () => receiptWriter.prepare(`UPDATE thread_deletion_receipts SET counts_json = '{}'`).run(),
    /Thread deletion receipts are immutable/u,
  )
  receiptWriter.close()

  const restarted = openTwinDeskDatabase(path)
  assert.throws(
    () =>
      restarted.putWorkItemProjection({
        thread: beforeDeletion.thread,
        workItem: beforeDeletion.workItems[0],
      }),
    (error) =>
      error instanceof WorkItemProjectionError &&
      /** @type {any} */ (error).code === 'deleted_thread',
  )
  assert.equal(restarted.deleteThread(request).disposition, 'duplicate')
  assert.throws(
    () => restarted.deleteThread(deletionRequest({ requestedAt: '2026-08-26T10:00:01Z' })),
    (error) => error instanceof ThreadLifecycleError && error.code === 'deletion_conflict',
  )
  assert.equal(
    restarted.deleteThread(
      deletionRequest({
        requestId: 'thread-delete:release-risk-question:v2',
        requestedAt: '2026-08-26T10:01:00Z',
      }),
    ).disposition,
    'already_deleted',
  )
  restarted.close()
})

test('shared events are retained while Thread-owned records are deleted', async (context) => {
  const path = await temporaryDatabase(context)
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  raw
    .prepare(`INSERT INTO thread_events (thread_id, event_id, ordinal) VALUES (?, ?, 1)`)
    .run('fixture-thread-deployment-update-review', EVENT_ID)
  raw.close()

  const database = openTwinDeskDatabase(path)
  const result = database.deleteThread(deletionRequest())
  assert.equal(result.receipt.counts.externalEvents, 0)
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM external_events WHERE id = ?`).get(EVENT_ID)
      ?.count,
    1,
  )
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM connector_cursors`).get()?.count,
    0,
  )
  inspection.close()
})

test('pre-dispatch deletion receipts remain readable after migration 6', async (context) => {
  const path = await temporaryDatabase(context)
  const request = deletionRequest({
    requestId: 'thread-delete:legacy-pre-dispatch:v1',
    threadId: 'fixture-thread-already-deleted-before-dispatch-journal',
    expectedUpdatedAt: '2026-08-26T08:00:00Z',
    requestedAt: '2026-08-26T08:01:00Z',
  })
  /** @param {string} value */
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
  const legacyCounts = {
    externalEvents: 0,
    externalThreads: 1,
    workItems: 0,
    workItemProjectionBases: 0,
    workItemUserActions: 0,
    drafts: 0,
    draftCreationRecords: 0,
    draftStateTransitions: 0,
    actionProposals: 0,
    actionProposalCreationRecords: 0,
    actionProposalStateTransitions: 0,
    approvalRecords: 0,
    actionReceipts: 0,
    auditRecords: 0,
  }
  const raw = new DatabaseSync(path)
  raw
    .prepare(
      `INSERT INTO thread_deletion_receipts (
         kind, schema_version, request_digest, thread_digest,
         expected_updated_at, requested_at, counts_json
       ) VALUES ('thread_deletion_receipt', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      digest(request.requestId),
      digest(request.threadId),
      request.expectedUpdatedAt,
      request.requestedAt,
      JSON.stringify(legacyCounts),
    )
  raw.close()

  const database = openTwinDeskDatabase(path)
  const result = database.deleteThread(request)
  assert.equal(result.disposition, 'duplicate')
  assert.equal(result.receipt.counts.actionDispatches, 0)
  database.close()
})

test('stale, interrupted, accessor, and closed-handle requests fail without partial deletion', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  assert.throws(
    () => database.deleteThread(deletionRequest({ expectedUpdatedAt: '2026-08-26T09:14:00Z' })),
    (error) => error instanceof ThreadLifecycleError && error.code === 'thread_revision_conflict',
  )

  let accessorCalls = 0
  const accessorRequest = Object.defineProperty(
    { kind: 'thread_export_request', schemaVersion: 1 },
    'threadId',
    {
      enumerable: true,
      get() {
        accessorCalls += 1
        return SECRET
      },
    },
  )
  assert.throws(
    // @ts-expect-error hostile boundary fixture
    () => database.exportThread(accessorRequest),
    (error) => error instanceof ThreadLifecycleError && error.code === 'invalid_request',
  )
  assert.equal(accessorCalls, 0)

  const raw = new DatabaseSync(path)
  raw.exec(`
    CREATE TRIGGER interrupt_thread_deletion
    BEFORE DELETE ON external_threads
    WHEN OLD.id = '${THREAD_ID}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic interruption');
    END;
  `)
  raw.close()
  assert.throws(
    () => database.deleteThread(deletionRequest()),
    (error) => error instanceof ThreadLifecycleError && error.code === 'storage_error',
  )
  const exported = database.exportThread({
    kind: 'thread_export_request',
    schemaVersion: 1,
    threadId: /** @type {any} */ (THREAD_ID),
  })
  assert.equal(/** @type {any} */ (exported.document).thread.id, THREAD_ID)
  database.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM thread_deletion_receipts`).get()?.count,
    0,
  )
  assert.equal(
    inspection.prepare(`SELECT count(*) AS count FROM external_threads WHERE id = ?`).get(THREAD_ID)
      ?.count,
    1,
  )
  inspection.close()

  assert.throws(
    () => database.deleteThread(deletionRequest()),
    (error) => error instanceof ThreadLifecycleError && error.code === 'database_closed',
  )
  assert.throws(
    () =>
      database.exportThread({
        kind: 'thread_export_request',
        schemaVersion: 1,
        threadId: /** @type {any} */ (THREAD_ID),
      }),
    (error) => error instanceof ThreadLifecycleError && error.code === 'database_closed',
  )
})
