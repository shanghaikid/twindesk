import { createHash } from 'node:crypto'

import {
  parseAuditRecord,
  parseIsoTimestamp,
  type ActionProposal,
  type ActionReceipt,
  type ApprovalRecord,
  type ApprovedAction,
  type AuditRecord,
  type IsoTimestamp,
} from '@twindesk/domain'
import {
  computeActionApprovalBindings,
  computeApprovalExecutionAttemptId,
  type ActionDispatchReservationResult,
  type ActionExecutionReceiptWriteResult,
  type StoredActionReceipt,
  type TwinDeskDatabase,
} from '@twindesk/storage-sqlite'

export const WORK_HUB_ACTION_EXECUTION_VERSION = 1 as const

export type WorkHubActionExecutionErrorCode =
  | 'invalid_request'
  | 'ownership_unavailable'
  | 'approval_unavailable'
  | 'execution_unavailable'
  | 'receipt_incomplete'
  | 'audit_incomplete'
  | 'stored_state_invalid'

export class WorkHubActionExecutionError extends Error {
  readonly code: WorkHubActionExecutionErrorCode

  constructor(code: WorkHubActionExecutionErrorCode, message: string) {
    super(message)
    this.name = 'WorkHubActionExecutionError'
    this.code = code
  }
}

export interface WorkHubActionExecutionRequest {
  readonly kind: 'work_hub_action_execution_request'
  readonly schemaVersion: typeof WORK_HUB_ACTION_EXECUTION_VERSION
  readonly approvalId: string
  readonly proposalId: string
}

export type WorkHubReserveActionDispatch = (
  action: ApprovedAction,
  reservedAt: IsoTimestamp,
) => ActionDispatchReservationResult['disposition']

export type WorkHubOwnedActionExecutor<TOwnership> = (
  action: ApprovedAction,
  ownership: TOwnership,
  signal: AbortSignal,
  reserveDispatch: WorkHubReserveActionDispatch,
) => Promise<ActionReceipt>

export type WorkHubExclusiveOperation<TOwnership> = <TResult>(
  signal: AbortSignal,
  operation: (ownership: TOwnership) => Promise<TResult>,
) => Promise<TResult>

export interface WorkHubActionExecutionHostOptions<TOwnership> {
  readonly database: TwinDeskDatabase
  readonly withExclusiveOperation: WorkHubExclusiveOperation<TOwnership>
  readonly execute: WorkHubOwnedActionExecutor<TOwnership>
  readonly now?: () => number
}

export interface WorkHubActionExecutionResult {
  readonly kind: 'work_hub_action_execution_result'
  readonly schemaVersion: typeof WORK_HUB_ACTION_EXECUTION_VERSION
  readonly executionAttemptId: string
  readonly source: 'executed' | 'recovered'
  readonly receipt: ActionReceipt
  readonly receiptDisposition: ActionExecutionReceiptWriteResult['disposition'] | 'existing'
  readonly auditInsertedCount: number
  readonly auditDuplicateCount: number
}

type UnknownRecord = Readonly<Record<string, unknown>>

interface ParsedRequest {
  readonly approvalId: string
  readonly proposalId: string
}

interface DurableExecutionSnapshot {
  readonly proposal: ActionProposal
  readonly approval: ApprovalRecord & {
    readonly decision: 'approved'
    readonly decidedAt: IsoTimestamp
    readonly responderUserId: string
    readonly consumedAt: IsoTimestamp
  }
  readonly executionAttemptId: string
}

interface AuditCounts {
  readonly inserted: number
  readonly duplicate: number
}

function fail(code: WorkHubActionExecutionErrorCode, message: string): WorkHubActionExecutionError {
  return new WorkHubActionExecutionError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    throw fail('invalid_request', 'The Work Hub action execution request is invalid.')
  }
}

function exactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw fail('invalid_request', 'The Work Hub action execution request is invalid.')
  }
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_request', 'The Work Hub action execution identity is invalid.')
  }
  return value
}

function request(value: unknown): ParsedRequest {
  const record = dataRecord(value)
  exactKeys(record, ['kind', 'schemaVersion', 'approvalId', 'proposalId'])
  if (
    record.kind !== 'work_hub_action_execution_request' ||
    record.schemaVersion !== WORK_HUB_ACTION_EXECUTION_VERSION
  ) {
    throw fail('invalid_request', 'The Work Hub action execution version is not supported.')
  }
  return Object.freeze({
    approvalId: identifier(record.approvalId),
    proposalId: identifier(record.proposalId),
  })
}

function timestamp(now: () => number): IsoTimestamp {
  try {
    const value = now()
    if (!Number.isSafeInteger(value)) throw new TypeError()
    return parseIsoTimestamp(new Date(value).toISOString())
  } catch {
    throw fail('execution_unavailable', 'The Work Hub action execution clock is unavailable.')
  }
}

function digestId(namespace: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
  digest.update(namespace, 'utf8')
  for (const part of parts) {
    digest.update('\0', 'utf8')
    digest.update(part, 'utf8')
  }
  return `audit:${namespace}:${digest.digest('hex')}`
}

function auditOutcome(receipt: ActionReceipt): AuditRecord['outcome'] {
  return receipt.outcome === 'succeeded'
    ? 'success'
    : receipt.outcome === 'failed'
      ? 'failure'
      : 'uncertain'
}

function executionSummary(receipt: ActionReceipt): string {
  if (receipt.outcome === 'succeeded') return 'The approved external action completed.'
  if (receipt.outcome === 'failed')
    return 'The approved external action failed with a known result.'
  return 'The approved external action has an uncertain external result.'
}

function approvalAudit(snapshot: DurableExecutionSnapshot): AuditRecord {
  const proposal = snapshot.proposal
  const approval = snapshot.approval
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: digestId('action-approval', approval.id, approval.consumedAt),
    category: 'approval',
    outcome: 'success',
    actor: { type: 'user', id: approval.responderUserId },
    summary: 'The exact approved external action was consumed once for execution.',
    references: [
      { kind: 'work_item', id: proposal.workItemId },
      { kind: 'action_proposal', id: proposal.id },
      { kind: 'approval_record', id: approval.id },
    ],
    details: {
      actionType: proposal.actionType,
      identityType: proposal.identity.identityType,
      authorityEffect: 'one_time_exact_action',
    },
    occurredAt: approval.consumedAt,
  })
}

function executionAudit(snapshot: DurableExecutionSnapshot, receipt: ActionReceipt): AuditRecord {
  const proposal = snapshot.proposal
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: digestId(
      'action-execution',
      snapshot.executionAttemptId,
      createHash('sha256').update(JSON.stringify(receipt), 'utf8').digest('hex'),
    ),
    category: 'execution',
    outcome: auditOutcome(receipt),
    actor: { type: 'connector', id: proposal.identity.connectorId },
    summary: executionSummary(receipt),
    references: [
      { kind: 'work_item', id: proposal.workItemId },
      { kind: 'action_proposal', id: proposal.id },
      { kind: 'approval_record', id: snapshot.approval.id },
      { kind: 'action_receipt', id: snapshot.executionAttemptId },
    ],
    details: {
      connectorId: receipt.connectorId,
      identityType: proposal.identity.identityType,
      outcome: receipt.outcome,
      ...(receipt.outcome === 'succeeded' ? {} : { retryDisposition: receipt.retryDisposition }),
    },
    occurredAt: receipt.attemptedAt,
  })
}

function terminal(receipt: ActionReceipt): boolean {
  return (
    receipt.outcome === 'succeeded' ||
    (receipt.outcome === 'failed' && receipt.retryDisposition === 'do_not_retry')
  )
}

function snapshot(
  proposal: ActionProposal | undefined,
  approval: ApprovalRecord | undefined,
  parsedRequest: ParsedRequest,
): DurableExecutionSnapshot {
  if (
    proposal === undefined ||
    approval === undefined ||
    proposal.id !== parsedRequest.proposalId ||
    approval.id !== parsedRequest.approvalId ||
    approval.proposalId !== proposal.id ||
    approval.decision !== 'approved' ||
    approval.decidedAt === undefined ||
    approval.responderUserId === undefined ||
    approval.consumedAt === undefined
  ) {
    throw fail('stored_state_invalid', 'The durable approved action is incomplete.')
  }
  const bindings = computeActionApprovalBindings(proposal)
  if (
    bindings.identityDigest !== approval.identityDigest ||
    bindings.targetDigest !== approval.targetDigest ||
    bindings.contentDigest !== approval.contentDigest
  ) {
    throw fail('stored_state_invalid', 'The durable approved action bindings are invalid.')
  }
  return Object.freeze({
    proposal,
    approval: approval as DurableExecutionSnapshot['approval'],
    executionAttemptId: computeApprovalExecutionAttemptId(approval.id),
  })
}

function assertReceipt(snapshotValue: DurableExecutionSnapshot, stored: StoredActionReceipt): void {
  const receipt = stored.receipt
  if (
    stored.executionAttemptId !== snapshotValue.executionAttemptId ||
    receipt.proposalId !== snapshotValue.proposal.id ||
    receipt.connectorId !== snapshotValue.proposal.identity.connectorId ||
    receipt.accountId !== snapshotValue.proposal.identity.accountId ||
    receipt.idempotencyKey !== snapshotValue.proposal.idempotencyKey
  ) {
    throw fail('stored_state_invalid', 'The durable action receipt bindings are invalid.')
  }
}

function result(
  executionAttemptId: string,
  source: WorkHubActionExecutionResult['source'],
  receipt: ActionReceipt,
  receiptDisposition: WorkHubActionExecutionResult['receiptDisposition'],
  audit: AuditCounts,
): WorkHubActionExecutionResult {
  return Object.freeze({
    kind: 'work_hub_action_execution_result',
    schemaVersion: WORK_HUB_ACTION_EXECUTION_VERSION,
    executionAttemptId,
    source,
    receipt,
    receiptDisposition,
    auditInsertedCount: audit.inserted,
    auditDuplicateCount: audit.duplicate,
  })
}

function addAuditCounts(left: AuditCounts, right: AuditCounts): AuditCounts {
  return Object.freeze({
    inserted: left.inserted + right.inserted,
    duplicate: left.duplicate + right.duplicate,
  })
}

/**
 * Connector-neutral Host operation for one exact, approved external action.
 *
 * The injected ownership boundary must cover the complete callback. For Feishu,
 * it is `FeishuRuntimeLeaseManager.withLease()` and the ownership value is the
 * callback's `FeishuRuntimeLease`.
 */
export class WorkHubActionExecutionHost<TOwnership> {
  readonly #database: TwinDeskDatabase
  readonly #withExclusiveOperation: WorkHubExclusiveOperation<TOwnership>
  readonly #execute: WorkHubOwnedActionExecutor<TOwnership>
  readonly #now: () => number

  constructor(optionsValue: WorkHubActionExecutionHostOptions<TOwnership>) {
    const options = dataRecord(optionsValue)
    exactKeys(options, ['database', 'withExclusiveOperation', 'execute'], ['now'])
    const now = Object.hasOwn(options, 'now') ? options.now : Date.now
    if (
      typeof options.database !== 'object' ||
      options.database === null ||
      typeof options.withExclusiveOperation !== 'function' ||
      typeof options.execute !== 'function' ||
      typeof now !== 'function'
    ) {
      throw fail('invalid_request', 'The Work Hub action execution options are invalid.')
    }
    this.#database = options.database as TwinDeskDatabase
    this.#withExclusiveOperation =
      options.withExclusiveOperation as WorkHubExclusiveOperation<TOwnership>
    this.#execute = options.execute as WorkHubOwnedActionExecutor<TOwnership>
    this.#now = now as () => number
  }

  async execute(
    requestValue: WorkHubActionExecutionRequest,
    signal: AbortSignal,
  ): Promise<WorkHubActionExecutionResult> {
    if (!(signal instanceof AbortSignal)) {
      throw fail('invalid_request', 'The Work Hub action execution signal is invalid.')
    }
    signal.throwIfAborted()
    const parsedRequest = request(requestValue)
    try {
      return await this.#withExclusiveOperation(signal, (ownership) =>
        this.#executeOwned(parsedRequest, ownership, signal),
      )
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof WorkHubActionExecutionError) throw error
      throw fail('ownership_unavailable', 'The exclusive action operation is unavailable.')
    }
  }

  async #executeOwned(
    parsedRequest: ParsedRequest,
    ownership: TOwnership,
    signal: AbortSignal,
  ): Promise<WorkHubActionExecutionResult> {
    signal.throwIfAborted()
    let proposal: ActionProposal | undefined
    let approval: ApprovalRecord | undefined
    try {
      proposal = this.#database.getActionProposal(parsedRequest.proposalId as ActionProposal['id'])
      approval = this.#database.getActionApproval(parsedRequest.approvalId as ApprovalRecord['id'])
    } catch {
      throw fail('approval_unavailable', 'The durable approved action is unavailable.')
    }

    const attemptId = computeApprovalExecutionAttemptId(
      parsedRequest.approvalId as ApprovalRecord['id'],
    )
    let priorReceipt: StoredActionReceipt | undefined
    try {
      priorReceipt = this.#database.getActionExecutionReceipt(attemptId)
    } catch {
      throw fail('receipt_incomplete', 'The durable action receipt is unavailable.')
    }

    let priorAudit: AuditCounts = Object.freeze({ inserted: 0, duplicate: 0 })
    if (approval?.consumedAt !== undefined) {
      const durable = snapshot(proposal, approval, parsedRequest)
      priorAudit = this.#appendAudit(approvalAudit(durable))
      if (priorReceipt !== undefined) {
        assertReceipt(durable, priorReceipt)
        priorAudit = addAuditCounts(
          priorAudit,
          this.#appendAudit(executionAudit(durable, priorReceipt.receipt)),
        )
      }
      if (priorReceipt !== undefined && terminal(priorReceipt.receipt)) {
        return result(
          durable.executionAttemptId,
          'recovered',
          priorReceipt.receipt,
          'existing',
          priorAudit,
        )
      }
    } else if (priorReceipt !== undefined) {
      throw fail('stored_state_invalid', 'The durable approved action is incomplete.')
    }

    let action: ApprovedAction
    try {
      if (approval?.consumedAt === undefined) {
        if (proposal === undefined || approval === undefined) throw new TypeError()
        const bindings = computeActionApprovalBindings(proposal)
        const consumed = this.#database.consumeActionApproval({
          kind: 'action_approval_consumption',
          schemaVersion: 1,
          approvalId: approval.id,
          proposalId: proposal.id,
          ...bindings,
          consumedAt: timestamp(this.#now),
        })
        action = consumed.action
        proposal = consumed.action.proposal
        approval = consumed.approval
        const durable = snapshot(proposal, approval, parsedRequest)
        priorAudit = addAuditCounts(priorAudit, this.#appendAudit(approvalAudit(durable)))
      } else if (proposal?.state === 'approved') {
        const bindings = computeActionApprovalBindings(proposal)
        action = this.#database.consumeActionApproval({
          kind: 'action_approval_consumption',
          schemaVersion: 1,
          approvalId: approval.id,
          proposalId: proposal.id,
          ...bindings,
          consumedAt: approval.consumedAt,
        }).action
      } else {
        action = this.#database.recoverActionExecution({
          kind: 'action_execution_recovery_request',
          schemaVersion: 1,
          approvalId: parsedRequest.approvalId,
          proposalId: parsedRequest.proposalId,
          executionAttemptId: attemptId,
        }).action
      }
    } catch (error) {
      if (error instanceof WorkHubActionExecutionError) throw error
      throw fail('approval_unavailable', 'The approved action cannot be consumed or recovered.')
    }

    const startedAt = timestamp(this.#now)
    try {
      this.#database.beginActionExecution({
        kind: 'action_execution_start',
        schemaVersion: 1,
        action,
        startedAt,
      })
    } catch {
      throw fail('execution_unavailable', 'The approved action execution cannot start.')
    }

    let receipt: ActionReceipt
    try {
      receipt = await this.#execute(action, ownership, signal, (reservedAction, reservedAt) => {
        signal.throwIfAborted()
        try {
          return this.#database.reserveActionDispatch({
            kind: 'action_dispatch_reservation',
            schemaVersion: 1,
            action: reservedAction,
            reservedAt,
          }).disposition
        } catch {
          throw fail('execution_unavailable', 'The action dispatch cannot be reserved.')
        }
      })
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof WorkHubActionExecutionError) throw error
      throw fail('execution_unavailable', 'The approved action execution was interrupted.')
    }

    let stored: ActionExecutionReceiptWriteResult
    try {
      stored = this.#database.recordActionExecutionReceipt({
        kind: 'action_execution_receipt_write',
        schemaVersion: 1,
        action,
        receipt,
      })
    } catch {
      throw fail('receipt_incomplete', 'The action result could not be durably recorded.')
    }

    proposal = stored.proposal
    try {
      approval = this.#database.getActionApproval(parsedRequest.approvalId as ApprovalRecord['id'])
    } catch {
      throw fail('audit_incomplete', 'The action Audit record could not be completed.')
    }
    const durable = snapshot(proposal, approval, parsedRequest)
    assertReceipt(durable, stored.storedReceipt)
    const currentAudit = this.#appendAudit(executionAudit(durable, stored.storedReceipt.receipt))
    return result(
      durable.executionAttemptId,
      'executed',
      stored.storedReceipt.receipt,
      stored.disposition,
      addAuditCounts(priorAudit, currentAudit),
    )
  }

  #appendAudit(record: AuditRecord): AuditCounts {
    try {
      const appended = this.#database.appendAuditRecords([record])
      return Object.freeze({
        inserted: appended.insertedCount,
        duplicate: appended.duplicateCount,
      })
    } catch {
      throw fail('audit_incomplete', 'The action Audit record could not be completed.')
    }
  }
}
