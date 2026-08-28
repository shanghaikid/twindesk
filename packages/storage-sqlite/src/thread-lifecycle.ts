import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  RedactionConfigurationError,
  parseActionProposalStateTransition,
  parseApprovalRecord,
  parseDraftStateTransition,
  parseIsoTimestamp,
  parseWorkItem,
  redactForBoundary,
  type ActionProposalId,
  type DraftId,
  type ExternalThreadId,
  type IsoTimestamp,
  type JsonValue,
  type RedactionSummary,
} from '@twindesk/domain'

import { readAuditInSnapshot } from './audit-timeline.ts'
import { readActionProposal, readDraft } from './draft-action-state.ts'
import { readExternalEventInSnapshot } from './event-ingestion.ts'
import {
  readThreadInSnapshot,
  readWorkItemActionsInSnapshot,
  readWorkItemInSnapshot,
} from './work-item-projection.ts'

export const THREAD_RETENTION_POLICY_V1 = Object.freeze({
  kind: 'thread_retention_policy',
  schemaVersion: 1,
  threadScopedTwinDeskData: 'delete',
  sharedExternalEvents: 'retain_while_referenced',
  connectorCursors: 'retain_account_checkpoint',
  harnessSessionData: 'separate_store_not_modified',
  deletionReceipts: 'retain_hashes_counts_and_timestamps_only',
} as const)

export type ThreadLifecycleErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'thread_not_found'
  | 'thread_revision_conflict'
  | 'deletion_conflict'
  | 'cross_thread_audit'
  | 'export_limit'
  | 'stored_data_invalid'
  | 'storage_error'

export class ThreadLifecycleError extends Error {
  readonly code: ThreadLifecycleErrorCode

  constructor(code: ThreadLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'ThreadLifecycleError'
    this.code = code
  }
}

export interface ThreadExportRequest {
  readonly kind: 'thread_export_request'
  readonly schemaVersion: 1
  readonly threadId: ExternalThreadId
  /** Exact in-memory values to remove. They are never persisted or returned. */
  readonly knownSecrets?: readonly string[]
  readonly sensitiveKeys?: readonly string[]
}

export interface ThreadExportResult {
  /** The complete versioned document after the shared export redactor. */
  readonly document: JsonValue
  readonly redaction: RedactionSummary
}

export interface ThreadDeletionRequest {
  readonly kind: 'thread_deletion_request'
  readonly schemaVersion: 1
  readonly requestId: string
  readonly threadId: ExternalThreadId
  readonly expectedUpdatedAt: IsoTimestamp
  readonly requestedAt: IsoTimestamp
}

export interface ThreadDeletionCounts {
  readonly externalEvents: number
  readonly externalThreads: number
  readonly workItems: number
  readonly workItemProjectionBases: number
  readonly workItemUserActions: number
  readonly drafts: number
  readonly draftCreationRecords: number
  readonly draftStateTransitions: number
  readonly actionProposals: number
  readonly actionProposalCreationRecords: number
  readonly actionProposalStateTransitions: number
  readonly approvalRecords: number
  readonly actionDispatches: number
  readonly actionReceipts: number
  readonly auditRecords: number
}

export interface ThreadDeletionReceipt {
  readonly kind: 'thread_deletion_receipt'
  readonly schemaVersion: 1
  readonly threadIdentityDigest: string
  readonly requestedAt: IsoTimestamp
  readonly counts: ThreadDeletionCounts
}

export interface ThreadDeletionResult {
  readonly disposition: 'deleted' | 'duplicate' | 'already_deleted'
  readonly receipt: ThreadDeletionReceipt
}

interface ParsedExportRequest {
  readonly threadId: ExternalThreadId
  readonly knownSecrets: readonly string[]
  readonly sensitiveKeys: readonly string[]
}

interface ParsedDeletionRequest {
  readonly requestId: string
  readonly threadId: ExternalThreadId
  readonly expectedUpdatedAt: IsoTimestamp
  readonly requestedAt: IsoTimestamp
}

interface DeletionReceiptRow {
  readonly request_digest: unknown
  readonly thread_digest: unknown
  readonly expected_updated_at: unknown
  readonly requested_at: unknown
  readonly counts_json: unknown
}

const COUNT_KEYS = Object.freeze([
  'externalEvents',
  'externalThreads',
  'workItems',
  'workItemProjectionBases',
  'workItemUserActions',
  'drafts',
  'draftCreationRecords',
  'draftStateTransitions',
  'actionProposals',
  'actionProposalCreationRecords',
  'actionProposalStateTransitions',
  'approvalRecords',
  'actionDispatches',
  'actionReceipts',
  'auditRecords',
] as const)

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed lifecycle error.
  }
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ThreadLifecycleError('invalid_request', 'The Thread request must be an object.')
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set([...requiredKeys, ...optionalKeys])
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.keys(descriptors).some((key) => !allowed.has(key))
    ) {
      throw new ThreadLifecycleError(
        'invalid_request',
        'The Thread request must be an exact plain data object.',
      )
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof ThreadLifecycleError) throw error
    throw new ThreadLifecycleError('invalid_request', 'The Thread request is invalid.')
  }
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    throw new ThreadLifecycleError('invalid_request', `${label} is invalid.`)
  }
  return value
}

function safeStringList(value: unknown, label: string): readonly string[] {
  try {
    if (!Array.isArray(value)) {
      throw new ThreadLifecycleError('invalid_request', `${label} must be an array.`)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = (descriptors as Record<string, PropertyDescriptor>).length?.value
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > 128 ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new ThreadLifecycleError('invalid_request', `${label} is invalid.`)
    }
    const result: string[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)]
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0 ||
        descriptor.value.length > 4096
      ) {
        throw new ThreadLifecycleError('invalid_request', `${label} is invalid.`)
      }
      result.push(descriptor.value)
    }
    if (new Set(result).size !== result.length) {
      throw new ThreadLifecycleError('invalid_request', `${label} contains duplicates.`)
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof ThreadLifecycleError) throw error
    throw new ThreadLifecycleError('invalid_request', `${label} is invalid.`)
  }
}

function timestamp(value: unknown, label: string): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw new ThreadLifecycleError('invalid_request', `${label} is invalid.`)
  }
}

function parseExportRequest(value: ThreadExportRequest): ParsedExportRequest {
  const record = dataRecord(
    value,
    ['kind', 'schemaVersion', 'threadId'],
    ['knownSecrets', 'sensitiveKeys'],
  )
  if (record.kind !== 'thread_export_request' || record.schemaVersion !== 1) {
    throw new ThreadLifecycleError('invalid_request', 'The Thread export version is unsupported.')
  }
  const threadId = boundedString(record.threadId, 'The Thread identifier') as ExternalThreadId
  return Object.freeze({
    threadId,
    knownSecrets: Object.hasOwn(record, 'knownSecrets')
      ? safeStringList(record.knownSecrets, 'knownSecrets')
      : Object.freeze([]),
    sensitiveKeys: Object.hasOwn(record, 'sensitiveKeys')
      ? safeStringList(record.sensitiveKeys, 'sensitiveKeys')
      : Object.freeze([]),
  })
}

function parseDeletionRequest(value: ThreadDeletionRequest): ParsedDeletionRequest {
  const record = dataRecord(value, [
    'kind',
    'schemaVersion',
    'requestId',
    'threadId',
    'expectedUpdatedAt',
    'requestedAt',
  ])
  if (record.kind !== 'thread_deletion_request' || record.schemaVersion !== 1) {
    throw new ThreadLifecycleError('invalid_request', 'The Thread deletion version is unsupported.')
  }
  const requestId = boundedString(record.requestId, 'The deletion request identifier', 256)
  const threadId = boundedString(record.threadId, 'The Thread identifier') as ExternalThreadId
  const expectedUpdatedAt = timestamp(record.expectedUpdatedAt, 'The expected Thread revision')
  const requestedAt = timestamp(record.requestedAt, 'The deletion request timestamp')
  if (Date.parse(requestedAt) < Date.parse(expectedUpdatedAt)) {
    throw new ThreadLifecycleError(
      'invalid_request',
      'The deletion request precedes the expected Thread revision.',
    )
  }
  return Object.freeze({ requestId, threadId, expectedUpdatedAt, requestedAt })
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stringIds(rows: readonly { readonly id: unknown }[]): readonly string[] {
  const ids = rows.map((row) => {
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new ThreadLifecycleError('stored_data_invalid', 'A stored identifier is invalid.')
    }
    return row.id
  })
  if (new Set(ids).size !== ids.length) {
    throw new ThreadLifecycleError('stored_data_invalid', 'Stored identifiers are duplicated.')
  }
  return Object.freeze(ids)
}

function queryIds(database: DatabaseSync, sql: string, ...parameters: string[]): readonly string[] {
  return stringIds(
    database.prepare(sql).all(...parameters) as unknown as readonly { readonly id: unknown }[],
  )
}

function requireStored<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new ThreadLifecycleError('stored_data_invalid', `A stored ${label} is missing.`)
  }
  return value
}

function readProjectionBase(database: DatabaseSync, workItemId: string): JsonValue {
  const row = database
    .prepare(
      `SELECT schema_version, work_item_id, thread_id, inbox_state, title, summary,
              attention_reason, selected_persona_id, created_at, updated_at
       FROM work_item_projection_bases WHERE work_item_id = ?`,
    )
    .get(workItemId) as Readonly<Record<string, unknown>> | undefined
  if (row === undefined) {
    throw new ThreadLifecycleError('stored_data_invalid', 'A projection base is missing.')
  }
  const eventIds = queryIds(
    database,
    `SELECT event_id AS id FROM work_item_projection_base_events
     WHERE work_item_id = ? ORDER BY ordinal`,
    workItemId,
  )
  try {
    const base = parseWorkItem({
      kind: 'work_item',
      schemaVersion: row.schema_version,
      id: row.work_item_id,
      threadId: row.thread_id,
      sourceEventIds: eventIds,
      inboxState: row.inbox_state,
      title: row.title,
      summary: row.summary,
      attentionReason: row.attention_reason,
      ...(row.selected_persona_id === null ? {} : { selectedPersonaId: row.selected_persona_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
    return Object.freeze({ ...base, kind: 'work_item_projection_base' }) as unknown as JsonValue
  } catch {
    throw new ThreadLifecycleError('stored_data_invalid', 'A stored projection base is invalid.')
  }
}

function readTransitionRecords(database: DatabaseSync, draftIds: readonly string[]): JsonValue {
  const transitions = draftIds.flatMap((draftId) => {
    const rows = database
      .prepare(
        `SELECT kind, schema_version, id, draft_id, from_state, to_state, occurred_at
         FROM draft_state_transitions WHERE draft_id = ? ORDER BY occurred_at, id`,
      )
      .all(draftId) as unknown as readonly Readonly<Record<string, unknown>>[]
    return rows.map((row) => {
      try {
        return parseDraftStateTransition({
          kind: row.kind,
          schemaVersion: row.schema_version,
          id: row.id,
          draftId: row.draft_id,
          fromState: row.from_state,
          toState: row.to_state,
          occurredAt: row.occurred_at,
        })
      } catch {
        throw new ThreadLifecycleError(
          'stored_data_invalid',
          'A stored Draft transition is invalid.',
        )
      }
    })
  })
  return Object.freeze(transitions) as unknown as JsonValue
}

function readProposalTransitionRecords(
  database: DatabaseSync,
  proposalIds: readonly string[],
): JsonValue {
  const transitions = proposalIds.flatMap((proposalId) => {
    const rows = database
      .prepare(
        `SELECT kind, schema_version, id, proposal_id, from_state, to_state, occurred_at
         FROM action_proposal_state_transitions
         WHERE proposal_id = ? ORDER BY occurred_at, id`,
      )
      .all(proposalId) as unknown as readonly Readonly<Record<string, unknown>>[]
    return rows.map((row) => {
      try {
        return parseActionProposalStateTransition({
          kind: row.kind,
          schemaVersion: row.schema_version,
          id: row.id,
          proposalId: row.proposal_id,
          fromState: row.from_state,
          toState: row.to_state,
          occurredAt: row.occurred_at,
        })
      } catch {
        throw new ThreadLifecycleError(
          'stored_data_invalid',
          'A stored ActionProposal transition is invalid.',
        )
      }
    })
  })
  return Object.freeze(transitions) as unknown as JsonValue
}

function readCreationRecords(
  database: DatabaseSync,
  table: 'draft_creation_records' | 'action_proposal_creation_records',
  idColumn: 'draft_id' | 'proposal_id',
  ids: readonly string[],
): JsonValue {
  const allowedStates =
    table === 'draft_creation_records'
      ? new Set(['editing', 'ready_for_review', 'superseded', 'cancelled'])
      : new Set([
          'proposed',
          'awaiting_approval',
          'approved',
          'rejected',
          'cancelled',
          'executing',
          'succeeded',
          'failed',
          'uncertain',
        ])
  const expectedKind =
    table === 'draft_creation_records' ? 'draft_creation_record' : 'action_proposal_creation_record'
  const records = ids.map((id) => {
    const row = database
      .prepare(
        `SELECT kind, schema_version, ${idColumn} AS record_id,
                initial_state, initial_updated_at
         FROM ${table} WHERE ${idColumn} = ?`,
      )
      .get(id) as Readonly<Record<string, unknown>> | undefined
    if (
      row === undefined ||
      row.kind !== expectedKind ||
      row.schema_version !== 1 ||
      row.record_id !== id ||
      typeof row.initial_state !== 'string' ||
      !allowedStates.has(row.initial_state)
    ) {
      throw new ThreadLifecycleError('stored_data_invalid', 'A creation record is invalid.')
    }
    const initialUpdatedAt = (() => {
      try {
        return parseIsoTimestamp(row.initial_updated_at)
      } catch {
        throw new ThreadLifecycleError('stored_data_invalid', 'A creation record is invalid.')
      }
    })()
    return Object.freeze({
      kind: expectedKind,
      schemaVersion: 1,
      [idColumn === 'draft_id' ? 'draftId' : 'proposalId']: id,
      initialState: row.initial_state,
      initialUpdatedAt,
    })
  })
  return Object.freeze(records) as unknown as JsonValue
}

function readApprovalRecords(database: DatabaseSync, proposalIds: readonly string[]): JsonValue {
  const approvals = proposalIds.flatMap((proposalId) => {
    const rows = database
      .prepare(
        `SELECT kind, schema_version, id, proposal_id, decision, identity_digest,
                target_digest, content_digest, requested_at, expires_at, decided_at,
                responder_user_id, consumed_at
         FROM approval_records WHERE proposal_id = ? ORDER BY requested_at, id`,
      )
      .all(proposalId) as unknown as readonly Readonly<Record<string, unknown>>[]
    return rows.map((row) => {
      try {
        return parseApprovalRecord({
          kind: row.kind,
          schemaVersion: row.schema_version,
          id: row.id,
          proposalId: row.proposal_id,
          decision: row.decision,
          identityDigest: row.identity_digest,
          targetDigest: row.target_digest,
          contentDigest: row.content_digest,
          requestedAt: row.requested_at,
          expiresAt: row.expires_at,
          ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
          ...(row.responder_user_id === null ? {} : { responderUserId: row.responder_user_id }),
          ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
        })
      } catch {
        throw new ThreadLifecycleError('stored_data_invalid', 'A stored ApprovalRecord is invalid.')
      }
    })
  })
  return Object.freeze(approvals) as unknown as JsonValue
}

function storedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ThreadLifecycleError('stored_data_invalid', 'A stored receipt is invalid.')
  }
  return value
}

function readActionReceipts(database: DatabaseSync, proposalIds: readonly string[]): JsonValue {
  const receipts = proposalIds.flatMap((proposalId) => {
    const rows = database
      .prepare(
        `SELECT kind, schema_version, execution_attempt_id, proposal_id, connector_id,
                account_id, idempotency_key, outcome, attempted_at,
                external_connector_id, external_account_id, external_object_type,
                external_id, external_source_timestamp, issue_code, issue_summary,
                issue_retryable, retry_disposition
         FROM action_receipts WHERE proposal_id = ?
         ORDER BY attempted_at, execution_attempt_id`,
      )
      .all(proposalId) as unknown as readonly Readonly<Record<string, unknown>>[]
    return rows.map((row) => {
      try {
        if (row.kind !== 'action_receipt' || row.schema_version !== 1) {
          throw new TypeError('invalid receipt version')
        }
        const base = {
          kind: 'action_receipt',
          schemaVersion: 1,
          executionAttemptId: storedString(row.execution_attempt_id),
          proposalId: storedString(row.proposal_id),
          connectorId: storedString(row.connector_id),
          accountId: storedString(row.account_id),
          idempotencyKey: storedString(row.idempotency_key),
          attemptedAt: parseIsoTimestamp(row.attempted_at),
        }
        if (row.outcome === 'succeeded') {
          return Object.freeze({
            ...base,
            outcome: 'succeeded',
            externalReference: {
              connectorId: storedString(row.external_connector_id),
              accountId: storedString(row.external_account_id),
              objectType: storedString(row.external_object_type),
              externalId: storedString(row.external_id),
              ...(row.external_source_timestamp === null
                ? {}
                : { sourceTimestamp: parseIsoTimestamp(row.external_source_timestamp) }),
            },
          })
        }
        if (
          (row.outcome !== 'failed' && row.outcome !== 'uncertain') ||
          (row.issue_retryable !== 0 && row.issue_retryable !== 1) ||
          (row.outcome === 'uncertain' && row.retry_disposition !== 'reconcile_first') ||
          (row.outcome === 'failed' &&
            row.retry_disposition !== 'do_not_retry' &&
            row.retry_disposition !== 'retry_same_key')
        ) {
          throw new TypeError('invalid receipt outcome')
        }
        return Object.freeze({
          ...base,
          outcome: row.outcome,
          error: {
            code: storedString(row.issue_code),
            message: storedString(row.issue_summary),
            retryable: row.issue_retryable === 1,
          },
          retryDisposition: row.retry_disposition,
        })
      } catch (error) {
        if (error instanceof ThreadLifecycleError) throw error
        throw new ThreadLifecycleError('stored_data_invalid', 'A stored receipt is invalid.')
      }
    })
  })
  return Object.freeze(receipts) as unknown as JsonValue
}

function readActionDispatches(database: DatabaseSync, proposalIds: readonly string[]): JsonValue {
  const dispatches = proposalIds.flatMap((proposalId) => {
    const rows = database
      .prepare(
        `SELECT kind, schema_version, execution_attempt_id, ordinal, proposal_id,
                connector_id, account_id, idempotency_key, reserved_at,
                settled_outcome, settled_at, retry_disposition
         FROM action_dispatches WHERE proposal_id = ?
         ORDER BY execution_attempt_id, ordinal`,
      )
      .all(proposalId) as unknown as readonly Readonly<Record<string, unknown>>[]
    return rows.map((row) => {
      try {
        if (
          row.kind !== 'action_dispatch' ||
          row.schema_version !== 1 ||
          !Number.isSafeInteger(row.ordinal) ||
          (row.ordinal as number) <= 0
        ) {
          throw new TypeError('invalid dispatch identity')
        }
        const base = {
          kind: 'action_dispatch',
          schemaVersion: 1,
          executionAttemptId: storedString(row.execution_attempt_id),
          ordinal: row.ordinal as number,
          proposalId: storedString(row.proposal_id),
          connectorId: storedString(row.connector_id),
          accountId: storedString(row.account_id),
          idempotencyKey: storedString(row.idempotency_key),
          reservedAt: parseIsoTimestamp(row.reserved_at),
        }
        if (row.settled_outcome === null) {
          if (row.settled_at !== null || row.retry_disposition !== null) throw new TypeError()
          return Object.freeze(base)
        }
        if (
          (row.settled_outcome !== 'succeeded' &&
            row.settled_outcome !== 'failed' &&
            row.settled_outcome !== 'uncertain') ||
          (row.settled_outcome === 'succeeded' && row.retry_disposition !== null) ||
          (row.settled_outcome === 'failed' &&
            row.retry_disposition !== 'do_not_retry' &&
            row.retry_disposition !== 'retry_same_key') ||
          (row.settled_outcome === 'uncertain' && row.retry_disposition !== 'reconcile_first')
        ) {
          throw new TypeError('invalid dispatch settlement')
        }
        return Object.freeze({
          ...base,
          settlement: {
            outcome: row.settled_outcome,
            settledAt: parseIsoTimestamp(row.settled_at),
            ...(row.settled_outcome === 'succeeded'
              ? {}
              : { retryDisposition: row.retry_disposition }),
          },
        })
      } catch (error) {
        if (error instanceof ThreadLifecycleError) throw error
        throw new ThreadLifecycleError('stored_data_invalid', 'A stored dispatch is invalid.')
      }
    })
  })
  return Object.freeze(dispatches) as unknown as JsonValue
}

function relatedAuditIds(
  database: DatabaseSync,
  threadId: string,
  eventIds: readonly string[],
): readonly string[] {
  const ids = new Set(
    queryIds(
      database,
      `SELECT DISTINCT reference.audit_record_id AS id
       FROM audit_references reference
       WHERE
         (reference.reference_kind = 'external_thread' AND reference.reference_id = ?) OR
         (reference.reference_kind = 'work_item' AND EXISTS (
           SELECT 1 FROM work_item_projection_bases base
           WHERE base.work_item_id = reference.reference_id AND base.thread_id = ?
         )) OR
         (reference.reference_kind = 'draft' AND EXISTS (
           SELECT 1 FROM drafts draft JOIN work_items item ON item.id = draft.work_item_id
           WHERE draft.id = reference.reference_id AND item.thread_id = ?
         )) OR
         (reference.reference_kind = 'action_proposal' AND EXISTS (
           SELECT 1 FROM action_proposals proposal
           JOIN work_items item ON item.id = proposal.work_item_id
           WHERE proposal.id = reference.reference_id AND item.thread_id = ?
         )) OR
         (reference.reference_kind = 'approval_record' AND EXISTS (
           SELECT 1 FROM approval_records approval
           JOIN action_proposals proposal ON proposal.id = approval.proposal_id
           JOIN work_items item ON item.id = proposal.work_item_id
           WHERE approval.id = reference.reference_id AND item.thread_id = ?
         )) OR
         (reference.reference_kind = 'action_receipt' AND EXISTS (
           SELECT 1 FROM action_receipts receipt
           JOIN action_proposals proposal ON proposal.id = receipt.proposal_id
           JOIN work_items item ON item.id = proposal.work_item_id
           WHERE receipt.execution_attempt_id = reference.reference_id AND item.thread_id = ?
         ))
       ORDER BY reference.audit_record_id`,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
    ),
  )
  const eventAudits = database.prepare(
    `SELECT audit_record_id AS id FROM audit_references
     WHERE reference_kind = 'external_event' AND reference_id = ?`,
  )
  for (const eventId of eventIds) {
    for (const id of stringIds(eventAudits.all(eventId) as unknown as { readonly id: unknown }[])) {
      ids.add(id)
    }
  }
  return Object.freeze([...ids].sort())
}

function assertAuditsBelongToThread(
  database: DatabaseSync,
  threadId: string,
  auditIds: readonly string[],
): void {
  const outside = database.prepare(
    `SELECT 1 AS outside
     FROM audit_references reference
     WHERE reference.audit_record_id = ? AND (
       (reference.reference_kind = 'external_thread' AND reference.reference_id != ?) OR
       (reference.reference_kind = 'work_item' AND NOT EXISTS (
         SELECT 1 FROM work_item_projection_bases base
         WHERE base.work_item_id = reference.reference_id AND base.thread_id = ?
       ))
     ) LIMIT 1`,
  )
  for (const auditId of auditIds) {
    if (outside.get(auditId, threadId, threadId) !== undefined) {
      throw new ThreadLifecycleError(
        'cross_thread_audit',
        'A related Audit record also belongs to another Thread.',
      )
    }
  }
}

function buildExportDocument(database: DatabaseSync, threadId: ExternalThreadId): unknown {
  const thread = readThreadInSnapshot(database, threadId)
  if (thread === undefined) {
    throw new ThreadLifecycleError('thread_not_found', 'The selected Thread does not exist.')
  }
  const events = thread.sourceEventIds.map((id) =>
    requireStored(readExternalEventInSnapshot(database, id), 'ExternalEvent'),
  )
  const workItemIds = queryIds(
    database,
    `SELECT id FROM work_items WHERE thread_id = ? ORDER BY created_at, id`,
    threadId,
  )
  const projectionBaseIds = queryIds(
    database,
    `SELECT work_item_id AS id FROM work_item_projection_bases
     WHERE thread_id = ? ORDER BY created_at, work_item_id`,
    threadId,
  )
  if (
    workItemIds.length !== projectionBaseIds.length ||
    workItemIds.some((id, index) => id !== projectionBaseIds[index])
  ) {
    throw new ThreadLifecycleError(
      'stored_data_invalid',
      'Stored Work Item projections are inconsistent.',
    )
  }
  const workItems = workItemIds.map((id) =>
    requireStored(readWorkItemInSnapshot(database, id), 'WorkItem'),
  )
  const projectionBases = projectionBaseIds.map((id) => readProjectionBase(database, id))
  const workItemUserActions = workItemIds.flatMap((id) =>
    readWorkItemActionsInSnapshot(database, id),
  )
  const draftIds = queryIds(
    database,
    `SELECT draft.id FROM drafts draft JOIN work_items item ON item.id = draft.work_item_id
     WHERE item.thread_id = ? ORDER BY draft.created_at, draft.id`,
    threadId,
  )
  const drafts = draftIds.map((id) => requireStored(readDraft(database, id as DraftId), 'Draft'))
  const proposalIds = queryIds(
    database,
    `SELECT proposal.id FROM action_proposals proposal
     JOIN work_items item ON item.id = proposal.work_item_id
     WHERE item.thread_id = ? ORDER BY proposal.created_at, proposal.id`,
    threadId,
  )
  const proposals = proposalIds.map((id) =>
    requireStored(readActionProposal(database, id as ActionProposalId), 'ActionProposal'),
  )
  const auditIds = relatedAuditIds(database, threadId, thread.sourceEventIds)
  assertAuditsBelongToThread(database, threadId, auditIds)
  const auditRecords = auditIds.map((id) =>
    requireStored(readAuditInSnapshot(database, id), 'AuditRecord'),
  )
  return {
    kind: 'thread_export',
    schemaVersion: 1,
    retentionPolicy: THREAD_RETENTION_POLICY_V1,
    thread,
    externalEvents: events,
    workItems,
    workItemProjectionBases: projectionBases,
    workItemUserActions,
    drafts,
    draftCreationRecords: readCreationRecords(
      database,
      'draft_creation_records',
      'draft_id',
      draftIds,
    ),
    draftStateTransitions: readTransitionRecords(database, draftIds),
    actionProposals: proposals,
    actionProposalCreationRecords: readCreationRecords(
      database,
      'action_proposal_creation_records',
      'proposal_id',
      proposalIds,
    ),
    actionProposalStateTransitions: readProposalTransitionRecords(database, proposalIds),
    approvalRecords: readApprovalRecords(database, proposalIds),
    actionDispatches: readActionDispatches(database, proposalIds),
    actionReceipts: readActionReceipts(database, proposalIds),
    auditRecords,
  }
}

export function exportThread(
  database: DatabaseSync,
  input: ThreadExportRequest,
): ThreadExportResult {
  const request = parseExportRequest(input)
  try {
    database.exec('BEGIN')
  } catch {
    throw new ThreadLifecycleError('storage_error', 'The Thread export could not start.')
  }
  try {
    const document = buildExportDocument(database, request.threadId)
    const redacted = redactForBoundary(document, {
      boundary: 'exports',
      knownSecrets: request.knownSecrets,
      sensitiveKeys: request.sensitiveKeys,
    })
    if (redacted.summary.counts.unsafe_value > 0) {
      throw new ThreadLifecycleError(
        'export_limit',
        'The Thread export exceeds a supported safety limit.',
      )
    }
    database.exec('COMMIT')
    return Object.freeze({ document: redacted.value, redaction: redacted.summary })
  } catch (error) {
    rollback(database)
    if (error instanceof ThreadLifecycleError) throw error
    if (error instanceof RedactionConfigurationError) {
      throw new ThreadLifecycleError('invalid_request', 'The export redaction request is invalid.')
    }
    throw new ThreadLifecycleError('storage_error', 'The Thread could not be exported.')
  }
}

function count(database: DatabaseSync, sql: string, threadId: string): number {
  const row = database.prepare(sql).get(threadId) as { readonly count: unknown } | undefined
  if (row === undefined || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
    throw new ThreadLifecycleError('stored_data_invalid', 'A deletion count is invalid.')
  }
  return row.count as number
}

function orphanEventIds(
  database: DatabaseSync,
  threadId: string,
  eventIds: readonly string[],
): readonly string[] {
  const usedElsewhere = database.prepare(
    `SELECT 1 AS used FROM thread_events link
     WHERE link.event_id = ? AND link.thread_id != ?
     UNION ALL
     SELECT 1 AS used FROM work_item_projection_base_events link
     JOIN work_item_projection_bases base ON base.work_item_id = link.work_item_id
     WHERE link.event_id = ? AND base.thread_id != ?
     UNION ALL
     SELECT 1 AS used FROM work_item_events link
     JOIN work_items item ON item.id = link.work_item_id
     WHERE link.event_id = ? AND item.thread_id != ?
     LIMIT 1`,
  )
  return Object.freeze(
    eventIds.filter(
      (eventId) =>
        usedElsewhere.get(eventId, threadId, eventId, threadId, eventId, threadId) === undefined,
    ),
  )
}

function deletionCounts(
  database: DatabaseSync,
  threadId: string,
  eventsToDelete: readonly string[],
  auditIds: readonly string[],
): ThreadDeletionCounts {
  return Object.freeze({
    externalEvents: eventsToDelete.length,
    externalThreads: 1,
    workItems: count(
      database,
      `SELECT count(*) AS count FROM work_items WHERE thread_id = ?`,
      threadId,
    ),
    workItemProjectionBases: count(
      database,
      `SELECT count(*) AS count FROM work_item_projection_bases WHERE thread_id = ?`,
      threadId,
    ),
    workItemUserActions: count(
      database,
      `SELECT count(*) AS count FROM work_item_user_actions action
       JOIN work_item_projection_bases base ON base.work_item_id = action.work_item_id
       WHERE base.thread_id = ?`,
      threadId,
    ),
    drafts: count(
      database,
      `SELECT count(*) AS count FROM drafts draft
       JOIN work_items item ON item.id = draft.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    draftCreationRecords: count(
      database,
      `SELECT count(*) AS count FROM draft_creation_records creation
       JOIN drafts draft ON draft.id = creation.draft_id
       JOIN work_items item ON item.id = draft.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    draftStateTransitions: count(
      database,
      `SELECT count(*) AS count FROM draft_state_transitions transition
       JOIN drafts draft ON draft.id = transition.draft_id
       JOIN work_items item ON item.id = draft.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    actionProposals: count(
      database,
      `SELECT count(*) AS count FROM action_proposals proposal
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    actionProposalCreationRecords: count(
      database,
      `SELECT count(*) AS count FROM action_proposal_creation_records creation
       JOIN action_proposals proposal ON proposal.id = creation.proposal_id
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    actionProposalStateTransitions: count(
      database,
      `SELECT count(*) AS count FROM action_proposal_state_transitions transition
       JOIN action_proposals proposal ON proposal.id = transition.proposal_id
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    approvalRecords: count(
      database,
      `SELECT count(*) AS count FROM approval_records approval
       JOIN action_proposals proposal ON proposal.id = approval.proposal_id
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    actionDispatches: count(
      database,
      `SELECT count(*) AS count FROM action_dispatches dispatch
       JOIN action_proposals proposal ON proposal.id = dispatch.proposal_id
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    actionReceipts: count(
      database,
      `SELECT count(*) AS count FROM action_receipts receipt
       JOIN action_proposals proposal ON proposal.id = receipt.proposal_id
       JOIN work_items item ON item.id = proposal.work_item_id WHERE item.thread_id = ?`,
      threadId,
    ),
    auditRecords: auditIds.length,
  })
}

function parseCounts(value: unknown): ThreadDeletionCounts {
  let parsed: unknown
  try {
    if (typeof value !== 'string') throw new TypeError('counts are not text')
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new ThreadLifecycleError('stored_data_invalid', 'A deletion receipt is invalid.')
  }
  let record: Readonly<Record<string, unknown>>
  try {
    const legacyKeys = COUNT_KEYS.filter((key) => key !== 'actionDispatches')
    const parsedRecord = dataRecord(parsed, legacyKeys, ['actionDispatches'])
    record = Object.freeze({
      ...parsedRecord,
      actionDispatches: parsedRecord.actionDispatches ?? 0,
    })
  } catch {
    throw new ThreadLifecycleError('stored_data_invalid', 'A deletion receipt is invalid.')
  }
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
      throw new ThreadLifecycleError('stored_data_invalid', 'A deletion receipt is invalid.')
    }
  }
  return Object.freeze(record as unknown as ThreadDeletionCounts)
}

function parseReceipt(row: DeletionReceiptRow): ThreadDeletionReceipt {
  if (
    typeof row.request_digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.request_digest) ||
    typeof row.thread_digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.thread_digest) ||
    typeof row.requested_at !== 'string'
  ) {
    throw new ThreadLifecycleError('stored_data_invalid', 'A deletion receipt is invalid.')
  }
  try {
    parseIsoTimestamp(row.expected_updated_at)
    return Object.freeze({
      kind: 'thread_deletion_receipt',
      schemaVersion: 1,
      threadIdentityDigest: `sha256:${row.thread_digest}`,
      requestedAt: parseIsoTimestamp(row.requested_at),
      counts: parseCounts(row.counts_json),
    })
  } catch (error) {
    if (error instanceof ThreadLifecycleError) throw error
    throw new ThreadLifecycleError('stored_data_invalid', 'A deletion receipt is invalid.')
  }
}

function existingReceipts(
  database: DatabaseSync,
  requestDigest: string,
  threadDigest: string,
): readonly DeletionReceiptRow[] {
  const rows = database
    .prepare(
      `SELECT request_digest, thread_digest, expected_updated_at, requested_at, counts_json
       FROM thread_deletion_receipts
       WHERE request_digest = ? OR thread_digest = ?
       ORDER BY request_digest`,
    )
    .all(requestDigest, threadDigest) as unknown as readonly DeletionReceiptRow[]
  if (rows.length > 1) {
    throw new ThreadLifecycleError('deletion_conflict', 'Deletion receipt identities conflict.')
  }
  return rows
}

export function deleteThread(
  database: DatabaseSync,
  input: ThreadDeletionRequest,
): ThreadDeletionResult {
  const request = parseDeletionRequest(input)
  const requestDigest = sha256(request.requestId)
  const threadDigest = sha256(request.threadId)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new ThreadLifecycleError('storage_error', 'The Thread deletion could not start.')
  }
  try {
    const receiptRows = existingReceipts(database, requestDigest, threadDigest)
    const receiptRow = receiptRows[0]
    const thread = readThreadInSnapshot(database, request.threadId)
    if (receiptRow !== undefined) {
      if (thread !== undefined) {
        throw new ThreadLifecycleError(
          'deletion_conflict',
          'The Thread identity was recreated after a durable deletion.',
        )
      }
      if (receiptRow.request_digest === requestDigest) {
        if (
          receiptRow.thread_digest !== threadDigest ||
          receiptRow.expected_updated_at !== request.expectedUpdatedAt ||
          receiptRow.requested_at !== request.requestedAt
        ) {
          throw new ThreadLifecycleError(
            'deletion_conflict',
            'The deletion request identity conflicts with its durable receipt.',
          )
        }
        const receipt = parseReceipt(receiptRow)
        database.exec('COMMIT')
        return Object.freeze({ disposition: 'duplicate', receipt })
      }
      if (receiptRow.thread_digest !== threadDigest) {
        throw new ThreadLifecycleError('deletion_conflict', 'Deletion receipt identities conflict.')
      }
      const receipt = parseReceipt(receiptRow)
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'already_deleted', receipt })
    }
    if (thread === undefined) {
      throw new ThreadLifecycleError('thread_not_found', 'The selected Thread does not exist.')
    }
    if (thread.updatedAt !== request.expectedUpdatedAt) {
      throw new ThreadLifecycleError(
        'thread_revision_conflict',
        'The selected Thread changed after deletion was requested.',
      )
    }
    const eventsToDelete = orphanEventIds(database, request.threadId, thread.sourceEventIds)
    const auditIds = relatedAuditIds(database, request.threadId, eventsToDelete)
    assertAuditsBelongToThread(database, request.threadId, auditIds)
    const counts = deletionCounts(database, request.threadId, eventsToDelete, auditIds)
    const deleteAudit = database.prepare(`DELETE FROM audit_records WHERE id = ?`)
    for (const auditId of auditIds) {
      if (deleteAudit.run(auditId).changes !== 1) {
        throw new ThreadLifecycleError('storage_error', 'A related Audit record was not deleted.')
      }
    }
    if (
      database.prepare(`DELETE FROM external_threads WHERE id = ?`).run(request.threadId)
        .changes !== 1
    ) {
      throw new ThreadLifecycleError('storage_error', 'The selected Thread was not deleted.')
    }
    const deleteEvent = database.prepare(`DELETE FROM external_events WHERE id = ?`)
    for (const eventId of eventsToDelete) {
      if (deleteEvent.run(eventId).changes !== 1) {
        throw new ThreadLifecycleError('storage_error', 'An orphaned source event was not deleted.')
      }
    }
    const stored = database
      .prepare(
        `INSERT INTO thread_deletion_receipts (
           kind, schema_version, request_digest, thread_digest,
           expected_updated_at, requested_at, counts_json
         ) VALUES ('thread_deletion_receipt', 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestDigest,
        threadDigest,
        request.expectedUpdatedAt,
        request.requestedAt,
        JSON.stringify(counts),
      )
    if (stored.changes !== 1) {
      throw new ThreadLifecycleError('storage_error', 'The deletion receipt was not stored.')
    }
    database.exec('COMMIT')
    return Object.freeze({
      disposition: 'deleted',
      receipt: Object.freeze({
        kind: 'thread_deletion_receipt',
        schemaVersion: 1,
        threadIdentityDigest: `sha256:${threadDigest}`,
        requestedAt: request.requestedAt,
        counts,
      }),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ThreadLifecycleError) throw error
    throw new ThreadLifecycleError('storage_error', 'The Thread could not be deleted.')
  }
}
