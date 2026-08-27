import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  parseActionProposal,
  parseApprovalRecord,
  parseContentDigest,
  parseIsoTimestamp,
  type ActionProposal,
  type ActionProposalId,
  type ApprovalRecord,
  type ApprovalRecordId,
  type ApprovedAction,
  type ContentDigest,
  type IsoTimestamp,
} from '@twindesk/domain'

import { computeDraftContentDigest, readActionProposal } from './draft-action-state.ts'

export const APPROVAL_POLICY_VERSION = 1 as const
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000

export type ApprovalStateErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'missing_proposal'
  | 'missing_approval'
  | 'proposal_state'
  | 'approval_conflict'
  | 'binding_mismatch'
  | 'approval_expired'
  | 'already_consumed'
  | 'stored_record_invalid'
  | 'storage_error'

export class ApprovalStateError extends Error {
  readonly code: ApprovalStateErrorCode

  constructor(code: ApprovalStateErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalStateError'
    this.code = code
  }
}

export interface ActionApprovalBindings {
  readonly identityDigest: ContentDigest
  readonly targetDigest: ContentDigest
  readonly contentDigest: ContentDigest
}

export interface ActionApprovalRequest {
  readonly kind: 'action_approval_request'
  readonly schemaVersion: typeof APPROVAL_POLICY_VERSION
  readonly id: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly requestedAt: IsoTimestamp
  readonly expiresAt: IsoTimestamp
}

export interface ActionApprovalDecision {
  readonly kind: 'action_approval_decision'
  readonly schemaVersion: typeof APPROVAL_POLICY_VERSION
  readonly approvalId: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly decision: 'approved' | 'rejected' | 'cancelled' | 'expired'
  readonly identityDigest: ContentDigest
  readonly targetDigest: ContentDigest
  readonly contentDigest: ContentDigest
  readonly decidedAt: IsoTimestamp
  readonly responderUserId?: string
}

export interface ActionApprovalConsumption {
  readonly kind: 'action_approval_consumption'
  readonly schemaVersion: typeof APPROVAL_POLICY_VERSION
  readonly approvalId: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly identityDigest: ContentDigest
  readonly targetDigest: ContentDigest
  readonly contentDigest: ContentDigest
  readonly consumedAt: IsoTimestamp
}

export interface ActionApprovalRequestResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly approval: ApprovalRecord
  readonly proposal: ActionProposal
}

export interface ActionApprovalDecisionResult {
  readonly disposition: 'applied' | 'duplicate'
  readonly approval: ApprovalRecord
  readonly proposal: ActionProposal
}

export interface ActionApprovalConsumptionResult {
  /** Duplicate means the same one-time execution attempt is being resumed. */
  readonly disposition: 'consumed' | 'duplicate'
  readonly approval: ApprovalRecord
  readonly action: ApprovedAction
}

interface ApprovalRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly proposal_id: unknown
  readonly decision: unknown
  readonly identity_digest: unknown
  readonly target_digest: unknown
  readonly content_digest: unknown
  readonly requested_at: unknown
  readonly expires_at: unknown
  readonly decided_at: unknown
  readonly responder_user_id: unknown
  readonly consumed_at: unknown
}

interface ParsedApprovalRequest {
  readonly id: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly requestedAt: IsoTimestamp
  readonly expiresAt: IsoTimestamp
}

interface ParsedApprovalDecision {
  readonly approvalId: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly decision: ActionApprovalDecision['decision']
  readonly bindings: ActionApprovalBindings
  readonly decidedAt: IsoTimestamp
  readonly responderUserId: string | undefined
}

interface ParsedApprovalConsumption {
  readonly approvalId: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly bindings: ActionApprovalBindings
  readonly consumedAt: IsoTimestamp
}

function observedTimestamp(nowMs: number): IsoTimestamp {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
    throw fail('invalid_request', 'The approval policy clock is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(nowMs).toISOString())
  } catch {
    throw fail('invalid_request', 'The approval policy clock is invalid.')
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

const APPROVAL_COLUMNS = `kind, schema_version, id, proposal_id, decision,
  identity_digest, target_digest, content_digest, requested_at, expires_at,
  decided_at, responder_user_id, consumed_at`

function fail(code: ApprovalStateErrorCode, message: string): ApprovalStateError {
  return new ApprovalStateError(code, message)
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed approval failure if SQLite already rolled back.
  }
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail('invalid_request', 'The approval request must be an object.')
    }
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
      throw fail('invalid_request', 'The approval request has missing or unsupported fields.')
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof ApprovalStateError) throw error
    throw fail('invalid_request', 'The approval request is invalid.')
  }
}

function identifier<T extends string>(value: unknown): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_request', 'An approval identity is invalid.')
  }
  return value as T
}

function timestamp(value: unknown): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_request', 'An approval timestamp is invalid.')
  }
}

function digest(value: unknown): ContentDigest {
  try {
    return parseContentDigest(value)
  } catch {
    throw fail('invalid_request', 'An approval binding digest is invalid.')
  }
}

function canonicalDigest(value: unknown): ContentDigest {
  return parseContentDigest(
    `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`,
  )
}

export function computeActionApprovalBindings(
  proposalValue: ActionProposal,
): ActionApprovalBindings {
  const proposal = parseActionProposal(proposalValue)
  if (computeDraftContentDigest(proposal.content) !== proposal.contentDigest) {
    throw fail('binding_mismatch', 'The proposal content binding is invalid.')
  }
  return Object.freeze({
    identityDigest: canonicalDigest({
      connectorId: proposal.identity.connectorId,
      accountId: proposal.identity.accountId,
      identityType: proposal.identity.identityType,
      displayName: proposal.identity.displayName,
    }),
    targetDigest: canonicalDigest({
      connectorId: proposal.target.connectorId,
      accountId: proposal.target.accountId,
      objectType: proposal.target.objectType,
      externalId: proposal.target.externalId,
      sourceTimestamp: proposal.target.sourceTimestamp ?? null,
    }),
    contentDigest: proposal.contentDigest,
  })
}

function parseRequest(value: ActionApprovalRequest): ParsedApprovalRequest {
  const record = dataRecord(value, [
    'kind',
    'schemaVersion',
    'id',
    'proposalId',
    'requestedAt',
    'expiresAt',
  ])
  if (record.kind !== 'action_approval_request' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The approval request version is not supported.')
  }
  const requestedAt = timestamp(record.requestedAt)
  const expiresAt = timestamp(record.expiresAt)
  const duration = Date.parse(expiresAt) - Date.parse(requestedAt)
  if (duration <= 0 || duration > MAX_APPROVAL_TTL_MS) {
    throw fail('invalid_request', 'The approval expiration is outside the supported policy.')
  }
  return Object.freeze({
    id: identifier<ApprovalRecordId>(record.id),
    proposalId: identifier<ActionProposalId>(record.proposalId),
    requestedAt,
    expiresAt,
  })
}

function parseBindings(record: UnknownRecord): ActionApprovalBindings {
  return Object.freeze({
    identityDigest: digest(record.identityDigest),
    targetDigest: digest(record.targetDigest),
    contentDigest: digest(record.contentDigest),
  })
}

function parseDecision(value: ActionApprovalDecision): ParsedApprovalDecision {
  const record = dataRecord(
    value,
    [
      'kind',
      'schemaVersion',
      'approvalId',
      'proposalId',
      'decision',
      'identityDigest',
      'targetDigest',
      'contentDigest',
      'decidedAt',
    ],
    ['responderUserId'],
  )
  if (record.kind !== 'action_approval_decision' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The approval decision version is not supported.')
  }
  if (!['approved', 'rejected', 'cancelled', 'expired'].includes(record.decision as string)) {
    throw fail('invalid_request', 'The approval decision is invalid.')
  }
  const decision = record.decision as ActionApprovalDecision['decision']
  const responderUserId =
    record.responderUserId === undefined ? undefined : identifier<string>(record.responderUserId)
  if (decision === 'expired' ? responderUserId !== undefined : responderUserId === undefined) {
    throw fail('invalid_request', 'The approval decision responder is invalid.')
  }
  return Object.freeze({
    approvalId: identifier<ApprovalRecordId>(record.approvalId),
    proposalId: identifier<ActionProposalId>(record.proposalId),
    decision,
    bindings: parseBindings(record),
    decidedAt: timestamp(record.decidedAt),
    responderUserId,
  })
}

function parseConsumption(value: ActionApprovalConsumption): ParsedApprovalConsumption {
  const record = dataRecord(value, [
    'kind',
    'schemaVersion',
    'approvalId',
    'proposalId',
    'identityDigest',
    'targetDigest',
    'contentDigest',
    'consumedAt',
  ])
  if (record.kind !== 'action_approval_consumption' || record.schemaVersion !== 1) {
    throw fail('invalid_request', 'The approval consumption version is not supported.')
  }
  return Object.freeze({
    approvalId: identifier<ApprovalRecordId>(record.approvalId),
    proposalId: identifier<ActionProposalId>(record.proposalId),
    bindings: parseBindings(record),
    consumedAt: timestamp(record.consumedAt),
  })
}

function parseStoredApproval(row: ApprovalRow): ApprovalRecord {
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
    throw fail('stored_record_invalid', 'A stored ApprovalRecord is invalid.')
  }
}

function readApprovalInSnapshot(
  database: DatabaseSync,
  id: ApprovalRecordId,
): ApprovalRecord | undefined {
  const row = database
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approval_records WHERE id = ?`)
    .get(id) as ApprovalRow | undefined
  return row === undefined ? undefined : parseStoredApproval(row)
}

export function readActionApproval(
  database: DatabaseSync,
  idValue: ApprovalRecordId,
): ApprovalRecord | undefined {
  const id = identifier<ApprovalRecordId>(idValue)
  try {
    return readApprovalInSnapshot(database, id)
  } catch (error) {
    if (error instanceof ApprovalStateError) throw error
    throw fail('storage_error', 'The ApprovalRecord could not be read.')
  }
}

function sameBindings(left: ActionApprovalBindings, right: ActionApprovalBindings): boolean {
  return (
    left.identityDigest === right.identityDigest &&
    left.targetDigest === right.targetDigest &&
    left.contentDigest === right.contentDigest
  )
}

function approvalBindings(approval: ApprovalRecord): ActionApprovalBindings {
  return Object.freeze({
    identityDigest: approval.identityDigest,
    targetDigest: approval.targetDigest,
    contentDigest: approval.contentDigest,
  })
}

function requireProposal(database: DatabaseSync, proposalId: ActionProposalId): ActionProposal {
  const proposal = readActionProposal(database, proposalId)
  if (proposal === undefined) throw fail('missing_proposal', 'The ActionProposal is missing.')
  return proposal
}

function requireApproval(
  database: DatabaseSync,
  approvalId: ApprovalRecordId,
  proposalId: ActionProposalId,
): ApprovalRecord {
  const approval = readApprovalInSnapshot(database, approvalId)
  if (approval === undefined || approval.proposalId !== proposalId) {
    throw fail('missing_approval', 'The ApprovalRecord is missing.')
  }
  return approval
}

function assertBindings(
  proposal: ActionProposal,
  approval: ApprovalRecord,
  expected?: ActionApprovalBindings,
): void {
  const durable = computeActionApprovalBindings(proposal)
  if (
    !sameBindings(durable, approvalBindings(approval)) ||
    (expected !== undefined && !sameBindings(durable, expected))
  ) {
    throw fail('binding_mismatch', 'The approval no longer matches the proposed action.')
  }
}

function proposalForState(
  proposal: ActionProposal,
  state: ActionProposal['state'],
  updatedAt: IsoTimestamp,
): ActionProposal {
  return parseActionProposal({ ...proposal, state, updatedAt })
}

function requestTransitionId(approvalId: ApprovalRecordId): string {
  const digestValue = createHash('sha256').update(approvalId).digest('hex').slice(0, 32)
  return `transition-approval-request-${digestValue}`
}

export function requestActionApproval(
  database: DatabaseSync,
  input: ActionApprovalRequest,
  nowMs: number,
): ActionApprovalRequestResult {
  const request = parseRequest(input)
  const observedAt = observedTimestamp(nowMs)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The approval request transaction could not start.')
  }
  try {
    const existingRows = database
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approval_records WHERE id = ? OR proposal_id = ?`)
      .all(request.id, request.proposalId) as unknown as ApprovalRow[]
    if (existingRows.length > 0) {
      const approval =
        existingRows.length === 1 ? parseStoredApproval(existingRows[0] as ApprovalRow) : undefined
      const proposal = requireProposal(database, request.proposalId)
      const duplicate =
        approval !== undefined &&
        approval.id === request.id &&
        approval.proposalId === request.proposalId &&
        approval.requestedAt === request.requestedAt &&
        approval.expiresAt === request.expiresAt
      if (!duplicate) throw fail('approval_conflict', 'The approval request identity conflicts.')
      assertBindings(proposal, approval)
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', approval, proposal })
    }

    const proposal = requireProposal(database, request.proposalId)
    if (proposal.state !== 'proposed') {
      throw fail('proposal_state', 'The ActionProposal is not ready to request approval.')
    }
    if (Date.parse(request.requestedAt) < Date.parse(proposal.updatedAt)) {
      throw fail('invalid_request', 'The approval request chronology is invalid.')
    }
    if (
      Date.parse(observedAt) < Date.parse(request.requestedAt) ||
      Date.parse(observedAt) >= Date.parse(request.expiresAt)
    ) {
      throw fail('approval_expired', 'The approval request is outside its valid lifetime.')
    }
    const bindings = computeActionApprovalBindings(proposal)
    const approval = parseApprovalRecord({
      kind: 'approval_record',
      schemaVersion: APPROVAL_POLICY_VERSION,
      id: request.id,
      proposalId: request.proposalId,
      decision: 'pending',
      ...bindings,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
    })
    const inserted = database
      .prepare(
        `INSERT INTO approval_records (
           kind, schema_version, id, proposal_id, decision, identity_digest,
           target_digest, content_digest, requested_at, expires_at,
           decided_at, responder_user_id, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        approval.kind,
        approval.schemaVersion,
        approval.id,
        approval.proposalId,
        approval.decision,
        approval.identityDigest,
        approval.targetDigest,
        approval.contentDigest,
        approval.requestedAt,
        approval.expiresAt,
      )
    if (inserted.changes !== 1) throw fail('storage_error', 'The ApprovalRecord was not stored.')
    const transition = database
      .prepare(
        `INSERT INTO action_proposal_state_transitions (
           kind, schema_version, id, proposal_id, from_state, to_state, occurred_at
         ) VALUES ('action_proposal_state_transition', 1, ?, ?, 'proposed',
                   'awaiting_approval', ?)`,
      )
      .run(requestTransitionId(approval.id), approval.proposalId, approval.requestedAt)
    if (transition.changes !== 1) {
      throw fail('storage_error', 'The approval request transition was not stored.')
    }
    const updated = database
      .prepare(
        `UPDATE action_proposals SET state = 'awaiting_approval', updated_at = ?
         WHERE id = ? AND state = 'proposed'`,
      )
      .run(approval.requestedAt, approval.proposalId)
    if (updated.changes !== 1) {
      throw fail('proposal_state', 'The ActionProposal is not ready to request approval.')
    }
    database.exec('COMMIT')
    return Object.freeze({
      disposition: 'inserted',
      approval,
      proposal: proposalForState(proposal, 'awaiting_approval', approval.requestedAt),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ApprovalStateError) throw error
    throw fail('storage_error', 'The approval request could not be stored.')
  }
}

function sameDecision(approval: ApprovalRecord, decision: ParsedApprovalDecision): boolean {
  return (
    approval.decision === decision.decision &&
    approval.decidedAt === decision.decidedAt &&
    approval.responderUserId === decision.responderUserId &&
    sameBindings(approvalBindings(approval), decision.bindings)
  )
}

export function decideActionApproval(
  database: DatabaseSync,
  input: ActionApprovalDecision,
  nowMs: number,
): ActionApprovalDecisionResult {
  const decision = parseDecision(input)
  const observedAt = observedTimestamp(nowMs)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The approval decision transaction could not start.')
  }
  try {
    const approval = requireApproval(database, decision.approvalId, decision.proposalId)
    const proposal = requireProposal(database, decision.proposalId)
    assertBindings(proposal, approval, decision.bindings)
    if (approval.decision !== 'pending') {
      if (!sameDecision(approval, decision)) {
        throw fail('approval_conflict', 'The approval decision conflicts.')
      }
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', approval, proposal })
    }
    if (proposal.state !== 'awaiting_approval') {
      throw fail('proposal_state', 'The ActionProposal is not awaiting approval.')
    }
    if (Date.parse(decision.decidedAt) < Date.parse(approval.requestedAt)) {
      throw fail('invalid_request', 'The approval decision chronology is invalid.')
    }
    const expires = Date.parse(approval.expiresAt)
    const observed = Date.parse(observedAt)
    const decided = Date.parse(decision.decidedAt)
    if (
      decided > observed ||
      (decision.decision === 'expired' && (decided < expires || observed < expires)) ||
      (decision.decision !== 'expired' && (decided > expires || observed > expires))
    ) {
      throw fail('approval_expired', 'The approval decision is outside its valid lifetime.')
    }
    const decidedApproval = parseApprovalRecord({
      ...approval,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      ...(decision.responderUserId === undefined
        ? {}
        : { responderUserId: decision.responderUserId }),
    })
    const approvalUpdate = database
      .prepare(
        `UPDATE approval_records
         SET decision = ?, decided_at = ?, responder_user_id = ?
         WHERE id = ? AND decision = 'pending'`,
      )
      .run(
        decidedApproval.decision,
        decidedApproval.decidedAt as string,
        decidedApproval.responderUserId ?? null,
        decidedApproval.id,
      )
    if (approvalUpdate.changes !== 1) {
      throw fail('approval_conflict', 'The approval decision conflicts.')
    }
    const proposalState =
      decision.decision === 'approved'
        ? 'approved'
        : decision.decision === 'rejected'
          ? 'rejected'
          : 'cancelled'
    const proposalUpdate = database
      .prepare(
        `UPDATE action_proposals SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'awaiting_approval'`,
      )
      .run(proposalState, decision.decidedAt, proposal.id)
    if (proposalUpdate.changes !== 1) {
      throw fail('proposal_state', 'The ActionProposal is not awaiting approval.')
    }
    database.exec('COMMIT')
    return Object.freeze({
      disposition: 'applied',
      approval: decidedApproval,
      proposal: proposalForState(proposal, proposalState, decision.decidedAt),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ApprovalStateError) throw error
    throw fail('storage_error', 'The approval decision could not be stored.')
  }
}

export function computeApprovalExecutionAttemptId(approvalId: ApprovalRecordId): string {
  return `execution-approval-${createHash('sha256').update(approvalId).digest('hex').slice(0, 32)}`
}

function unconsumedApproval(approval: ApprovalRecord): ApprovalRecord & {
  readonly decision: 'approved'
  readonly consumedAt?: never
} {
  return parseApprovalRecord({
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
  }) as ApprovalRecord & { readonly decision: 'approved'; readonly consumedAt?: never }
}

function approvedProposalSnapshot(
  proposal: ActionProposal,
  approval: ApprovalRecord,
): ActionProposal {
  return parseActionProposal({
    ...proposal,
    state: 'approved',
    updatedAt: approval.decidedAt,
  })
}

function approvedAction(proposal: ActionProposal, approval: ApprovalRecord): ApprovedAction {
  return Object.freeze({
    proposal: approvedProposalSnapshot(proposal, approval),
    approval: unconsumedApproval(approval),
    executionAttemptId: computeApprovalExecutionAttemptId(approval.id),
  }) as unknown as ApprovedAction
}

export function consumeActionApproval(
  database: DatabaseSync,
  input: ActionApprovalConsumption,
  nowMs: number,
): ActionApprovalConsumptionResult {
  const consumption = parseConsumption(input)
  const observedAt = observedTimestamp(nowMs)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The approval consumption transaction could not start.')
  }
  try {
    const approval = requireApproval(database, consumption.approvalId, consumption.proposalId)
    const proposal = requireProposal(database, consumption.proposalId)
    assertBindings(proposal, approval, consumption.bindings)
    if (approval.decision !== 'approved' || approval.decidedAt === undefined) {
      throw fail('proposal_state', 'The action does not have an approved ApprovalRecord.')
    }
    if (
      Date.parse(consumption.consumedAt) < Date.parse(approval.decidedAt) ||
      Date.parse(consumption.consumedAt) > Date.parse(approval.expiresAt) ||
      Date.parse(consumption.consumedAt) > Date.parse(observedAt) ||
      Date.parse(observedAt) > Date.parse(approval.expiresAt)
    ) {
      throw fail('approval_expired', 'The approval is outside its valid lifetime.')
    }
    if (approval.consumedAt !== undefined) {
      database.exec('COMMIT')
      return Object.freeze({
        disposition: 'duplicate',
        approval,
        action: approvedAction(proposal, approval),
      })
    }
    if (proposal.state !== 'approved') {
      throw fail('proposal_state', 'The ActionProposal is not approved for execution.')
    }
    const update = database
      .prepare(
        `UPDATE approval_records SET consumed_at = ?
         WHERE id = ? AND decision = 'approved' AND consumed_at IS NULL`,
      )
      .run(consumption.consumedAt, approval.id)
    if (update.changes !== 1) {
      throw fail('already_consumed', 'The approval has already been consumed.')
    }
    const consumed = parseApprovalRecord({ ...approval, consumedAt: consumption.consumedAt })
    database.exec('COMMIT')
    return Object.freeze({
      disposition: 'consumed',
      approval: consumed,
      action: approvedAction(proposal, consumed),
    })
  } catch (error) {
    rollback(database)
    if (error instanceof ApprovalStateError) throw error
    throw fail('storage_error', 'The approval consumption could not be stored.')
  }
}
