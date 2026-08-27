import type { DatabaseSync } from 'node:sqlite'

import {
  parseActionProposal,
  parseApprovalRecord,
  parseIsoTimestamp,
  type ActionProposal,
  type ActionReceipt,
  type ApprovedAction,
  type ApprovalRecord,
  type ExternalReference,
  type IsoTimestamp,
} from '@twindesk/domain'

import {
  computeActionApprovalBindings,
  computeApprovalExecutionAttemptId,
  readActionApproval,
} from './approval-state.ts'
import { readActionProposal } from './draft-action-state.ts'

export const ACTION_EXECUTION_STATE_VERSION = 1 as const

export type ActionExecutionStateErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'missing_proposal'
  | 'missing_approval'
  | 'binding_mismatch'
  | 'approval_expired'
  | 'execution_state'
  | 'receipt_conflict'
  | 'stored_record_invalid'
  | 'storage_error'

export class ActionExecutionStateError extends Error {
  readonly code: ActionExecutionStateErrorCode

  constructor(code: ActionExecutionStateErrorCode, message: string) {
    super(message)
    this.name = 'ActionExecutionStateError'
    this.code = code
  }
}

export interface ActionExecutionStart {
  readonly kind: 'action_execution_start'
  readonly schemaVersion: typeof ACTION_EXECUTION_STATE_VERSION
  readonly action: ApprovedAction
  readonly startedAt: IsoTimestamp
}

export interface ActionExecutionStartResult {
  readonly disposition: 'started' | 'duplicate'
  readonly proposal: ActionProposal
}

export interface ActionExecutionReceiptWrite {
  readonly kind: 'action_execution_receipt_write'
  readonly schemaVersion: typeof ACTION_EXECUTION_STATE_VERSION
  readonly action: ApprovedAction
  readonly receipt: ActionReceipt
}

export interface StoredActionReceipt {
  readonly kind: 'action_receipt'
  readonly schemaVersion: typeof ACTION_EXECUTION_STATE_VERSION
  readonly executionAttemptId: string
  readonly receipt: ActionReceipt
}

export interface ActionExecutionReceiptWriteResult {
  readonly disposition: 'inserted' | 'updated' | 'duplicate'
  readonly storedReceipt: StoredActionReceipt
  readonly proposal: ActionProposal
}

export interface ActionExecutionRecoveryRequest {
  readonly kind: 'action_execution_recovery_request'
  readonly schemaVersion: typeof ACTION_EXECUTION_STATE_VERSION
  readonly approvalId: string
  readonly proposalId: string
  readonly executionAttemptId: string
}

export interface ActionExecutionRecoveryResult {
  readonly action: ApprovedAction
  readonly storedReceipt?: StoredActionReceipt
}

interface ParsedApprovedAction {
  readonly proposal: ActionProposal & { readonly state: 'approved' }
  readonly approval: ApprovalRecord & {
    readonly decision: 'approved'
    readonly consumedAt?: never
  }
  readonly executionAttemptId: string
}

interface ReceiptRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly execution_attempt_id: unknown
  readonly proposal_id: unknown
  readonly connector_id: unknown
  readonly account_id: unknown
  readonly idempotency_key: unknown
  readonly outcome: unknown
  readonly attempted_at: unknown
  readonly external_connector_id: unknown
  readonly external_account_id: unknown
  readonly external_object_type: unknown
  readonly external_id: unknown
  readonly external_source_timestamp: unknown
  readonly issue_code: unknown
  readonly issue_summary: unknown
  readonly issue_retryable: unknown
  readonly retry_disposition: unknown
}

type UnknownRecord = Readonly<Record<string, unknown>>

const RECEIPT_COLUMNS = `kind, schema_version, execution_attempt_id, proposal_id,
  connector_id, account_id, idempotency_key, outcome, attempted_at,
  external_connector_id, external_account_id, external_object_type, external_id,
  external_source_timestamp, issue_code, issue_summary, issue_retryable,
  retry_disposition`

function fail(code: ActionExecutionStateErrorCode, message: string): ActionExecutionStateError {
  return new ActionExecutionStateError(code, message)
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the normalized execution-state failure.
  }
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set([...requiredKeys, ...optionalKeys])
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.keys(descriptors).some((key) => !allowed.has(key))
    ) {
      throw new TypeError()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    throw fail('invalid_request', 'The action execution request is invalid.')
  }
}

function boundedString(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_request', 'The action execution request is invalid.')
  }
  return value
}

function timestamp(value: unknown): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_request', 'The action execution timestamp is invalid.')
  }
}

function observedTimestamp(nowMs: number): IsoTimestamp {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw fail('invalid_request', 'The action execution policy clock is invalid.')
  }
  return timestamp(new Date(nowMs).toISOString())
}

function sameBindings(left: ApprovalRecord, right: ApprovalRecord): boolean {
  return (
    left.id === right.id &&
    left.proposalId === right.proposalId &&
    left.identityDigest === right.identityDigest &&
    left.targetDigest === right.targetDigest &&
    left.contentDigest === right.contentDigest &&
    left.requestedAt === right.requestedAt &&
    left.expiresAt === right.expiresAt &&
    left.decidedAt === right.decidedAt &&
    left.responderUserId === right.responderUserId
  )
}

function proposalFingerprint(proposal: ActionProposal): string {
  return JSON.stringify({
    id: proposal.id,
    workItemId: proposal.workItemId,
    draftId: proposal.draftId ?? null,
    actionType: proposal.actionType,
    risk: proposal.risk,
    identity: proposal.identity,
    target: proposal.target,
    content: proposal.content,
    contentDigest: proposal.contentDigest,
    idempotencyKey: proposal.idempotencyKey,
    createdAt: proposal.createdAt,
  })
}

function parseApprovedAction(value: ApprovedAction): ParsedApprovedAction {
  const record = dataRecord(value, ['proposal', 'approval', 'executionAttemptId'])
  let proposal: ActionProposal
  let approval: ApprovalRecord
  try {
    proposal = parseActionProposal(record.proposal)
    approval = parseApprovalRecord(record.approval)
  } catch {
    throw fail('invalid_request', 'The approved action is invalid.')
  }
  const executionAttemptId = boundedString(record.executionAttemptId)
  if (
    proposal.state !== 'approved' ||
    approval.decision !== 'approved' ||
    approval.consumedAt !== undefined ||
    approval.proposalId !== proposal.id ||
    executionAttemptId !== computeApprovalExecutionAttemptId(approval.id)
  ) {
    throw fail('invalid_request', 'The approved action is invalid.')
  }
  const bindings = computeActionApprovalBindings(proposal)
  if (
    bindings.identityDigest !== approval.identityDigest ||
    bindings.targetDigest !== approval.targetDigest ||
    bindings.contentDigest !== approval.contentDigest
  ) {
    throw fail('binding_mismatch', 'The approved action bindings no longer match.')
  }
  return Object.freeze({
    proposal: proposal as ParsedApprovedAction['proposal'],
    approval: approval as ParsedApprovedAction['approval'],
    executionAttemptId,
  })
}

function requireDurableAction(
  database: DatabaseSync,
  action: ParsedApprovedAction,
): ActionProposal {
  const proposal = readActionProposal(database, action.proposal.id)
  if (proposal === undefined) throw fail('missing_proposal', 'The ActionProposal is missing.')
  const approval = readActionApproval(database, action.approval.id)
  if (approval === undefined || approval.proposalId !== proposal.id) {
    throw fail('missing_approval', 'The ApprovalRecord is missing.')
  }
  if (
    approval.decision !== 'approved' ||
    approval.consumedAt === undefined ||
    !sameBindings(approval, action.approval) ||
    proposalFingerprint(proposal) !== proposalFingerprint(action.proposal) ||
    computeActionApprovalBindings(proposal).contentDigest !== approval.contentDigest
  ) {
    throw fail('binding_mismatch', 'The durable approved action no longer matches.')
  }
  return proposal
}

function parseStart(value: ActionExecutionStart): {
  readonly action: ParsedApprovedAction
  readonly startedAt: IsoTimestamp
} {
  const record = dataRecord(value, ['kind', 'schemaVersion', 'action', 'startedAt'])
  if (record.kind !== 'action_execution_start' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The action execution request version is not supported.')
  }
  return Object.freeze({
    action: parseApprovedAction(record.action as ApprovedAction),
    startedAt: timestamp(record.startedAt),
  })
}

function parseExternalReference(value: unknown): ExternalReference {
  const record = dataRecord(
    value,
    ['connectorId', 'accountId', 'objectType', 'externalId'],
    ['sourceTimestamp'],
  )
  return Object.freeze({
    connectorId: boundedString(record.connectorId),
    accountId: boundedString(record.accountId),
    objectType: boundedString(record.objectType),
    externalId: boundedString(record.externalId),
    ...(record.sourceTimestamp === undefined
      ? {}
      : { sourceTimestamp: timestamp(record.sourceTimestamp) }),
  })
}

function parseReceipt(value: unknown): ActionReceipt {
  const record = dataRecord(
    value,
    ['proposalId', 'connectorId', 'accountId', 'idempotencyKey', 'outcome', 'attemptedAt'],
    ['externalReference', 'error', 'retryDisposition'],
  )
  const base = {
    proposalId: boundedString(record.proposalId) as ActionReceipt['proposalId'],
    connectorId: boundedString(record.connectorId),
    accountId: boundedString(record.accountId),
    idempotencyKey: boundedString(record.idempotencyKey),
    attemptedAt: timestamp(record.attemptedAt),
  }
  if (record.outcome === 'succeeded') {
    if (record.error !== undefined || record.retryDisposition !== undefined) {
      throw fail('invalid_request', 'The action receipt outcome is invalid.')
    }
    return Object.freeze({
      ...base,
      outcome: 'succeeded',
      externalReference: parseExternalReference(record.externalReference),
    })
  }
  if (record.outcome !== 'failed' && record.outcome !== 'uncertain') {
    throw fail('invalid_request', 'The action receipt outcome is invalid.')
  }
  if (record.externalReference !== undefined) {
    throw fail('invalid_request', 'The action receipt outcome is invalid.')
  }
  const issue = dataRecord(record.error, ['code', 'message', 'retryable'])
  if (typeof issue.retryable !== 'boolean') {
    throw fail('invalid_request', 'The action receipt issue is invalid.')
  }
  const error = Object.freeze({
    code: boundedString(issue.code, 128),
    message: boundedString(issue.message, 1_024),
    retryable: issue.retryable,
  })
  if (
    (record.outcome === 'uncertain' && record.retryDisposition !== 'reconcile_first') ||
    (record.outcome === 'failed' &&
      record.retryDisposition !== 'do_not_retry' &&
      record.retryDisposition !== 'retry_same_key')
  ) {
    throw fail('invalid_request', 'The action receipt retry disposition is invalid.')
  }
  return Object.freeze({
    ...base,
    outcome: record.outcome,
    error,
    retryDisposition: record.retryDisposition,
  }) as ActionReceipt
}

function parseReceiptWrite(value: ActionExecutionReceiptWrite): {
  readonly action: ParsedApprovedAction
  readonly receipt: ActionReceipt
} {
  const record = dataRecord(value, ['kind', 'schemaVersion', 'action', 'receipt'])
  if (record.kind !== 'action_execution_receipt_write' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The action receipt request version is not supported.')
  }
  return Object.freeze({
    action: parseApprovedAction(record.action as ApprovedAction),
    receipt: parseReceipt(record.receipt),
  })
}

function parseStoredReceipt(row: ReceiptRow): StoredActionReceipt {
  try {
    const base = {
      proposalId: row.proposal_id,
      connectorId: row.connector_id,
      accountId: row.account_id,
      idempotencyKey: row.idempotency_key,
      outcome: row.outcome,
      attemptedAt: row.attempted_at,
    }
    const receipt =
      row.outcome === 'succeeded'
        ? parseReceipt({
            ...base,
            externalReference: {
              connectorId: row.external_connector_id,
              accountId: row.external_account_id,
              objectType: row.external_object_type,
              externalId: row.external_id,
              ...(row.external_source_timestamp === null
                ? {}
                : { sourceTimestamp: row.external_source_timestamp }),
            },
          })
        : parseReceipt({
            ...base,
            error: {
              code: row.issue_code,
              message: row.issue_summary,
              retryable: row.issue_retryable === 1,
            },
            retryDisposition: row.retry_disposition,
          })
    if (row.kind !== 'action_receipt' || row.schema_version !== 1) throw new TypeError()
    return Object.freeze({
      kind: 'action_receipt',
      schemaVersion: ACTION_EXECUTION_STATE_VERSION,
      executionAttemptId: boundedString(row.execution_attempt_id),
      receipt,
    })
  } catch (error) {
    if (error instanceof ActionExecutionStateError && error.code === 'stored_record_invalid') {
      throw error
    }
    throw fail('stored_record_invalid', 'A stored ActionReceipt is invalid.')
  }
}

function readReceiptInSnapshot(
  database: DatabaseSync,
  executionAttemptId: string,
): StoredActionReceipt | undefined {
  const row = database
    .prepare(`SELECT ${RECEIPT_COLUMNS} FROM action_receipts WHERE execution_attempt_id = ?`)
    .get(executionAttemptId) as ReceiptRow | undefined
  return row === undefined ? undefined : parseStoredReceipt(row)
}

export function readActionExecutionReceipt(
  database: DatabaseSync,
  executionAttemptIdValue: string,
): StoredActionReceipt | undefined {
  const executionAttemptId = boundedString(executionAttemptIdValue)
  try {
    return readReceiptInSnapshot(database, executionAttemptId)
  } catch (error) {
    if (error instanceof ActionExecutionStateError) throw error
    throw fail('storage_error', 'The ActionReceipt could not be read.')
  }
}

function proposalForState(
  proposal: ActionProposal,
  state: ActionProposal['state'],
  updatedAt: IsoTimestamp,
): ActionProposal {
  return parseActionProposal({ ...proposal, state, updatedAt })
}

function recoveryAction(proposal: ActionProposal, approval: ApprovalRecord): ApprovedAction {
  if (approval.decision !== 'approved' || approval.decidedAt === undefined) {
    throw fail('execution_state', 'The action execution is not recoverable.')
  }
  const approvalSnapshot = parseApprovalRecord({
    kind: approval.kind,
    schemaVersion: approval.schemaVersion,
    id: approval.id,
    proposalId: approval.proposalId,
    decision: 'approved',
    identityDigest: approval.identityDigest,
    targetDigest: approval.targetDigest,
    contentDigest: approval.contentDigest,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt,
    responderUserId: approval.responderUserId,
  })
  return Object.freeze({
    proposal: proposalForState(proposal, 'approved', approval.decidedAt),
    approval: approvalSnapshot,
    executionAttemptId: computeApprovalExecutionAttemptId(approval.id),
  }) as unknown as ApprovedAction
}

export function recoverActionExecution(
  database: DatabaseSync,
  input: ActionExecutionRecoveryRequest,
): ActionExecutionRecoveryResult {
  const record = dataRecord(input, [
    'kind',
    'schemaVersion',
    'approvalId',
    'proposalId',
    'executionAttemptId',
  ])
  if (record.kind !== 'action_execution_recovery_request' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The action execution recovery version is not supported.')
  }
  const approvalId = boundedString(record.approvalId)
  const proposalId = boundedString(record.proposalId)
  const executionAttemptId = boundedString(record.executionAttemptId)
  if (
    executionAttemptId !== computeApprovalExecutionAttemptId(approvalId as ApprovalRecord['id'])
  ) {
    throw fail('binding_mismatch', 'The action execution recovery identity does not match.')
  }
  try {
    database.exec('BEGIN')
  } catch {
    throw fail('storage_error', 'The action execution recovery snapshot could not start.')
  }
  try {
    const proposal = readActionProposal(database, proposalId as ActionProposal['id'])
    const approval = readActionApproval(database, approvalId as ApprovalRecord['id'])
    if (proposal === undefined) throw fail('missing_proposal', 'The ActionProposal is missing.')
    if (approval === undefined || approval.proposalId !== proposal.id) {
      throw fail('missing_approval', 'The ApprovalRecord is missing.')
    }
    const storedReceipt = readReceiptInSnapshot(database, executionAttemptId)
    const recoverableReceipt =
      storedReceipt === undefined ||
      storedReceipt.receipt.outcome === 'uncertain' ||
      (storedReceipt.receipt.outcome === 'failed' &&
        storedReceipt.receipt.retryDisposition === 'retry_same_key')
    if (
      approval.decision !== 'approved' ||
      approval.consumedAt === undefined ||
      !['executing', 'uncertain', 'failed'].includes(proposal.state) ||
      !recoverableReceipt
    ) {
      throw fail('execution_state', 'The action execution is not recoverable.')
    }
    const bindings = computeActionApprovalBindings(proposal)
    if (
      bindings.identityDigest !== approval.identityDigest ||
      bindings.targetDigest !== approval.targetDigest ||
      bindings.contentDigest !== approval.contentDigest
    ) {
      throw fail('binding_mismatch', 'The durable approved action no longer matches.')
    }
    const result = Object.freeze({
      action: recoveryAction(proposal, approval),
      ...(storedReceipt === undefined ? {} : { storedReceipt }),
    })
    database.exec('COMMIT')
    return result
  } catch (error) {
    rollback(database)
    if (error instanceof ActionExecutionStateError) throw error
    throw fail('storage_error', 'The action execution could not be recovered.')
  }
}

export function beginActionExecution(
  database: DatabaseSync,
  input: ActionExecutionStart,
  nowMs: number,
): ActionExecutionStartResult {
  const start = parseStart(input)
  const observedAt = observedTimestamp(nowMs)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The action execution transaction could not start.')
  }
  try {
    const proposal = requireDurableAction(database, start.action)
    const durableApproval = readActionApproval(database, start.action.approval.id) as ApprovalRecord
    if (
      Date.parse(start.startedAt) < Date.parse(durableApproval.consumedAt as IsoTimestamp) ||
      Date.parse(start.startedAt) > Date.parse(observedAt) ||
      Date.parse(observedAt) > Date.parse(durableApproval.expiresAt)
    ) {
      throw fail('approval_expired', 'The action execution is outside its valid lifetime.')
    }
    const existing = readReceiptInSnapshot(database, start.action.executionAttemptId)
    if (
      existing?.receipt.outcome === 'succeeded' ||
      (existing?.receipt.outcome === 'failed' &&
        existing.receipt.retryDisposition === 'do_not_retry')
    ) {
      throw fail('execution_state', 'The action execution is already terminal.')
    }
    if (proposal.state === 'executing') {
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', proposal })
    }
    const retryableState =
      (proposal.state === 'approved' && existing === undefined) ||
      (proposal.state === 'failed' &&
        existing?.receipt.outcome === 'failed' &&
        existing.receipt.retryDisposition === 'retry_same_key') ||
      (proposal.state === 'uncertain' && existing?.receipt.outcome === 'uncertain')
    if (!retryableState) {
      throw fail('execution_state', 'The action execution is not ready to start.')
    }
    const update = database
      .prepare(
        `UPDATE action_proposals SET state = 'executing', updated_at = ? WHERE id = ? AND state = ?`,
      )
      .run(start.startedAt, proposal.id, proposal.state)
    if (update.changes !== 1) throw fail('execution_state', 'The action execution state changed.')
    database.exec('COMMIT')
    return Object.freeze({
      disposition: 'started',
      proposal: proposalForState(proposal, 'executing', start.startedAt),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ActionExecutionStateError) throw error
    throw fail('storage_error', 'The action execution could not be started.')
  }
}

function sameReceipt(left: ActionReceipt, right: ActionReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function receiptState(receipt: ActionReceipt): ActionProposal['state'] {
  return receipt.outcome === 'succeeded'
    ? 'succeeded'
    : receipt.outcome === 'failed'
      ? 'failed'
      : 'uncertain'
}

function writeReceiptRow(
  statement: ReturnType<DatabaseSync['prepare']>,
  action: ParsedApprovedAction,
  receipt: ActionReceipt,
): void {
  const external = receipt.outcome === 'succeeded' ? receipt.externalReference : undefined
  const issue = receipt.outcome === 'succeeded' ? undefined : receipt.error
  statement.run(
    action.executionAttemptId,
    receipt.proposalId,
    receipt.connectorId,
    receipt.accountId,
    receipt.idempotencyKey,
    receipt.outcome,
    receipt.attemptedAt,
    external?.connectorId ?? null,
    external?.accountId ?? null,
    external?.objectType ?? null,
    external?.externalId ?? null,
    external?.sourceTimestamp ?? null,
    issue?.code ?? null,
    issue?.message ?? null,
    issue === undefined ? null : issue.retryable ? 1 : 0,
    receipt.outcome === 'succeeded' ? null : receipt.retryDisposition,
  )
}

export function recordActionExecutionReceipt(
  database: DatabaseSync,
  input: ActionExecutionReceiptWrite,
  nowMs: number,
): ActionExecutionReceiptWriteResult {
  const write = parseReceiptWrite(input)
  const observedAt = observedTimestamp(nowMs)
  if (Date.parse(write.receipt.attemptedAt) > Date.parse(observedAt)) {
    throw fail('invalid_request', 'The ActionReceipt timestamp is in the future.')
  }
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The ActionReceipt transaction could not start.')
  }
  try {
    const proposal = requireDurableAction(database, write.action)
    const receipt = write.receipt
    if (
      receipt.proposalId !== proposal.id ||
      receipt.connectorId !== proposal.identity.connectorId ||
      receipt.accountId !== proposal.identity.accountId ||
      receipt.idempotencyKey !== proposal.idempotencyKey ||
      Date.parse(receipt.attemptedAt) < Date.parse(proposal.updatedAt) ||
      (receipt.outcome === 'succeeded' &&
        (receipt.externalReference.connectorId !== proposal.identity.connectorId ||
          receipt.externalReference.accountId !== proposal.identity.accountId))
    ) {
      throw fail('binding_mismatch', 'The ActionReceipt does not match the approved action.')
    }
    const existing = readReceiptInSnapshot(database, write.action.executionAttemptId)
    const targetState = receiptState(receipt)
    if (existing !== undefined && sameReceipt(existing.receipt, receipt)) {
      if (proposal.state !== targetState) {
        throw fail('stored_record_invalid', 'The stored execution state is inconsistent.')
      }
      database.exec('COMMIT')
      return Object.freeze({
        disposition: 'duplicate',
        storedReceipt: existing,
        proposal,
      })
    }
    let disposition: 'inserted' | 'updated'
    if (existing === undefined) {
      if (proposal.state !== 'executing') {
        throw fail('execution_state', 'The action execution has not started.')
      }
      const statement = database.prepare(
        `INSERT INTO action_receipts (
           kind, schema_version, execution_attempt_id, proposal_id, connector_id,
           account_id, idempotency_key, outcome, attempted_at, external_connector_id,
           external_account_id, external_object_type, external_id,
           external_source_timestamp, issue_code, issue_summary, issue_retryable,
           retry_disposition
         ) VALUES ('action_receipt', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      writeReceiptRow(statement, write.action, receipt)
      disposition = 'inserted'
    } else {
      const recoverable =
        existing.receipt.outcome === 'uncertain' ||
        (existing.receipt.outcome === 'failed' &&
          existing.receipt.retryDisposition === 'retry_same_key')
      if (
        !recoverable ||
        (proposal.state !== 'executing' && proposal.state !== 'uncertain') ||
        Date.parse(receipt.attemptedAt) < Date.parse(existing.receipt.attemptedAt)
      ) {
        throw fail('receipt_conflict', 'The ActionReceipt conflicts with a terminal result.')
      }
      const statement = database.prepare(
        `UPDATE action_receipts SET
           proposal_id = ?, connector_id = ?, account_id = ?, idempotency_key = ?,
           outcome = ?, attempted_at = ?, external_connector_id = ?,
           external_account_id = ?, external_object_type = ?, external_id = ?,
           external_source_timestamp = ?, issue_code = ?, issue_summary = ?,
           issue_retryable = ?, retry_disposition = ?
         WHERE execution_attempt_id = ?`,
      )
      const external = receipt.outcome === 'succeeded' ? receipt.externalReference : undefined
      const issue = receipt.outcome === 'succeeded' ? undefined : receipt.error
      const result = statement.run(
        receipt.proposalId,
        receipt.connectorId,
        receipt.accountId,
        receipt.idempotencyKey,
        receipt.outcome,
        receipt.attemptedAt,
        external?.connectorId ?? null,
        external?.accountId ?? null,
        external?.objectType ?? null,
        external?.externalId ?? null,
        external?.sourceTimestamp ?? null,
        issue?.code ?? null,
        issue?.message ?? null,
        issue === undefined ? null : issue.retryable ? 1 : 0,
        receipt.outcome === 'succeeded' ? null : receipt.retryDisposition,
        write.action.executionAttemptId,
      )
      if (result.changes !== 1) throw fail('receipt_conflict', 'The ActionReceipt changed.')
      disposition = 'updated'
    }
    const proposalUpdate = database
      .prepare(
        `UPDATE action_proposals SET state = ?, updated_at = ? WHERE id = ? AND state IN ('executing', 'uncertain')`,
      )
      .run(targetState, receipt.attemptedAt, proposal.id)
    if (proposalUpdate.changes !== 1) {
      throw fail('execution_state', 'The ActionProposal execution state changed.')
    }
    const storedReceipt = readReceiptInSnapshot(database, write.action.executionAttemptId)
    if (storedReceipt === undefined) throw fail('storage_error', 'The ActionReceipt is missing.')
    database.exec('COMMIT')
    return Object.freeze({
      disposition,
      storedReceipt,
      proposal: proposalForState(proposal, targetState, receipt.attemptedAt),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ActionExecutionStateError) throw error
    throw fail('storage_error', 'The ActionReceipt could not be stored.')
  }
}
