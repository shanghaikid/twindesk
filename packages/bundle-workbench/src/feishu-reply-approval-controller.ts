import { createHash } from 'node:crypto'

import {
  parseAuditRecord,
  parseIsoTimestamp,
  type ActionProposal,
  type ApprovalRecord,
  type ApprovalRecordId,
  type Draft,
  type IsoTimestamp,
} from '@twindesk/domain'
import { computeActionApprovalBindings, type TwinDeskDatabase } from '@twindesk/storage-sqlite'

import type {
  WorkbenchFeishuReplyProposalController,
  WorkbenchFeishuReplyProposalRequest,
  WorkbenchFeishuReplyProposalResolution,
} from './feishu-reply-proposal-controller.ts'

export const WORKBENCH_REPLY_APPROVAL_TTL_MS = 15 * 60 * 1_000

export type WorkbenchFeishuReplyApprovalErrorCode =
  | 'invalid_options'
  | 'invalid_request'
  | 'proposal_unavailable'
  | 'approval_unavailable'
  | 'runtime_unavailable'

export class WorkbenchFeishuReplyApprovalError extends Error {
  readonly code: WorkbenchFeishuReplyApprovalErrorCode

  constructor(code: WorkbenchFeishuReplyApprovalErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchFeishuReplyApprovalError'
    this.code = code
  }
}

export interface WorkbenchFeishuReplyApprovalDecisionRequest extends WorkbenchFeishuReplyProposalRequest {
  readonly decision: 'approved' | 'rejected' | 'cancelled'
}

export interface WorkbenchFeishuReplyApprovalControllerOptions {
  readonly database: TwinDeskDatabase
  readonly proposalController: WorkbenchFeishuReplyProposalController
  readonly now?: () => number
}

export interface WorkbenchFeishuReplyApprovalController {
  read(): Promise<unknown>
  request(request: WorkbenchFeishuReplyProposalRequest, signal: AbortSignal): Promise<unknown>
  decide(
    request: WorkbenchFeishuReplyApprovalDecisionRequest,
    signal: AbortSignal,
  ): Promise<unknown>
}

type ParsedOptions = Readonly<Required<WorkbenchFeishuReplyApprovalControllerOptions>>
type UserDecision = WorkbenchFeishuReplyApprovalDecisionRequest['decision']
type ApprovalOperation = 'request' | 'decision'
const LOCAL_RESPONDER_ID = 'local-user'
const REQUIRED_DATABASE_METHODS = Object.freeze([
  'appendAuditRecords',
  'decideActionApproval',
  'getActionApproval',
  'requestActionApproval',
])

function fail(
  code: WorkbenchFeishuReplyApprovalErrorCode,
  message: string,
): WorkbenchFeishuReplyApprovalError {
  return new WorkbenchFeishuReplyApprovalError(code, message)
}

function hasDataMethod(value: object, name: string): boolean {
  try {
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    return false
  } catch {
    return false
  }
}

function optionsAt(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const required = ['database', 'proposalController']
    const allowed = [...required, 'now']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const database = descriptors.database?.value
    const proposalController = descriptors.proposalController?.value
    if (
      typeof database !== 'object' ||
      database === null ||
      REQUIRED_DATABASE_METHODS.some((method) => !hasDataMethod(database, method)) ||
      typeof proposalController !== 'object' ||
      proposalController === null ||
      !hasDataMethod(proposalController, 'read') ||
      !hasDataMethod(proposalController, 'resolve') ||
      (descriptors.now?.value !== undefined && typeof descriptors.now.value !== 'function')
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      database: database as TwinDeskDatabase,
      proposalController: proposalController as WorkbenchFeishuReplyProposalController,
      now: (descriptors.now?.value as (() => number) | undefined) ?? Date.now,
    })
  } catch {
    throw fail('invalid_options', 'The Workbench Feishu reply approval options are invalid.')
  }
}

function requestAt(value: unknown): WorkbenchFeishuReplyProposalRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['version', 'workItemId', 'draftRevision']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.version?.value !== 1 ||
      typeof descriptors.workItemId?.value !== 'string' ||
      descriptors.workItemId.value.length === 0 ||
      descriptors.workItemId.value.length > 200 ||
      descriptors.workItemId.value.trim() !== descriptors.workItemId.value ||
      /[\u0000-\u001f\u007f]/u.test(descriptors.workItemId.value) ||
      Buffer.byteLength(descriptors.workItemId.value, 'utf8') > 512 ||
      !Number.isSafeInteger(descriptors.draftRevision?.value) ||
      (descriptors.draftRevision?.value as number) < 1 ||
      (descriptors.draftRevision?.value as number) > 100
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      version: 1,
      workItemId: descriptors.workItemId.value,
      draftRevision: descriptors.draftRevision?.value as number,
    })
  } catch {
    throw fail('invalid_request', 'The Workbench Feishu reply approval request is invalid.')
  }
}

function decisionAt(value: unknown): WorkbenchFeishuReplyApprovalDecisionRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['version', 'workItemId', 'draftRevision', 'decision']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      !['approved', 'rejected', 'cancelled'].includes(descriptors.decision?.value as string)
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      ...requestAt({
        version: descriptors.version?.value,
        workItemId: descriptors.workItemId?.value,
        draftRevision: descriptors.draftRevision?.value,
      }),
      decision: descriptors.decision?.value as UserDecision,
    })
  } catch (error) {
    if (error instanceof WorkbenchFeishuReplyApprovalError) throw error
    throw fail('invalid_request', 'The Workbench Feishu reply approval decision is invalid.')
  }
}

function signalAt(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Workbench Feishu reply approval request is invalid.')
  }
  return value
}

function throwIfCancelled(signal: AbortSignal): void {
  try {
    signal.throwIfAborted()
  } catch {
    throw fail('runtime_unavailable', 'The Workbench Feishu reply approval was cancelled.')
  }
}

function timestampAt(now: () => number): IsoTimestamp {
  try {
    const value = now()
    if (!Number.isSafeInteger(value)) throw new TypeError()
    return parseIsoTimestamp(new Date(value).toISOString())
  } catch {
    throw fail('runtime_unavailable', 'The Workbench Feishu reply approval clock is unavailable.')
  }
}

/** Stable Host-only approval identity derived from the durable proposal. */
export function workbenchFeishuReplyApprovalId(proposal: ActionProposal): ApprovalRecordId {
  const digest = createHash('sha256').update(proposal.id).digest('hex').slice(0, 32)
  return `approval-feishu-reply-${digest}` as ApprovalRecordId
}

function auditDisposition(
  database: TwinDeskDatabase,
  approval: ApprovalRecord,
  proposal: ActionProposal,
  draft: Draft,
  operation: ApprovalOperation,
): 'inserted' | 'duplicate' {
  try {
    const decision = approval.decision
    const auditDecision = operation === 'request' ? 'pending' : decision
    const occurredAt = operation === 'request' ? approval.requestedAt : approval.decidedAt
    if (occurredAt === undefined) throw new TypeError()
    const audit = parseAuditRecord({
      kind: 'audit_record',
      schemaVersion: 1,
      id:
        operation === 'request'
          ? `${approval.id}:user-requested`
          : `${approval.id}:decision:${decision}`,
      category: 'approval',
      outcome:
        operation === 'request' ? 'pending' : decision === 'approved' ? 'success' : 'cancelled',
      actor:
        auditDecision === 'expired' ? { type: 'system' } : { type: 'user', id: LOCAL_RESPONDER_ID },
      summary:
        operation === 'request'
          ? 'The user requested approval for the exact Feishu reply.'
          : decision === 'approved'
            ? 'The user granted one-time approval for the exact Feishu reply.'
            : decision === 'rejected'
              ? 'The user rejected the exact Feishu reply.'
              : decision === 'cancelled'
                ? 'The user cancelled the exact Feishu reply approval.'
                : 'The exact Feishu reply approval expired.',
      references: [
        { kind: 'work_item', id: proposal.workItemId },
        { kind: 'draft', id: draft.id },
        { kind: 'action_proposal', id: proposal.id },
        { kind: 'approval_record', id: approval.id },
      ],
      details: {
        action: operation === 'request' ? 'approval_requested' : 'approval_decided',
        actionType: proposal.actionType,
        identityType: proposal.identity.identityType,
        decision: auditDecision,
        authorityEffect: auditDecision === 'approved' ? 'one_time_exact_action' : 'none',
        externalWrite: false,
        execution: false,
      },
      occurredAt,
    })
    const result = database.appendAuditRecords([audit])
    const item = result.items[0]
    if (
      result.items.length !== 1 ||
      item?.inputIndex !== 0 ||
      (item.disposition !== 'inserted' && item.disposition !== 'duplicate') ||
      result.insertedCount + result.duplicateCount !== 1
    ) {
      throw new TypeError()
    }
    return item.disposition
  } catch {
    throw fail('runtime_unavailable', 'The Feishu reply approval Audit could not be stored.')
  }
}

function snapshot(
  resolution: WorkbenchFeishuReplyProposalResolution,
  approval: ApprovalRecord,
  operation: ApprovalOperation,
  disposition: 'applied' | 'recovered' | 'repaired',
): unknown {
  const proposal = resolution.proposal
  return Object.freeze({
    version: 1,
    operation,
    disposition,
    executionAvailable: false,
    approval: Object.freeze({
      decision: approval.decision,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
    }),
    proposal: Object.freeze({
      workItemId: proposal.workItemId,
      draftRevision: resolution.draft.revision,
      actionType: proposal.actionType,
      risk: proposal.risk,
      state: proposal.state,
      identity: Object.freeze({ ...proposal.identity }),
      target: Object.freeze({ ...proposal.target }),
      content: Object.freeze({ ...proposal.content }),
      createdAt: proposal.createdAt,
    }),
  })
}

async function resolve(
  options: ParsedOptions,
  request: WorkbenchFeishuReplyProposalRequest,
  signal: AbortSignal,
): Promise<WorkbenchFeishuReplyProposalResolution> {
  try {
    return await options.proposalController.resolve(request, signal)
  } catch {
    if (signal.aborted) throwIfCancelled(signal)
    throw fail('proposal_unavailable', 'The exact Feishu reply preview is unavailable.')
  }
}

function currentApproval(
  database: TwinDeskDatabase,
  proposal: ActionProposal,
): ApprovalRecord | undefined {
  try {
    return database.getActionApproval(workbenchFeishuReplyApprovalId(proposal))
  } catch {
    throw fail('approval_unavailable', 'The Feishu reply approval is unavailable.')
  }
}

/** Compose exact proposal display, durable decisions, and content-free Audit without execution. */
export function createWorkbenchFeishuReplyApprovalController(
  optionsValue: WorkbenchFeishuReplyApprovalControllerOptions,
): WorkbenchFeishuReplyApprovalController {
  const options = optionsAt(optionsValue)
  return Object.freeze({
    async read() {
      try {
        const status = await options.proposalController.read()
        if (typeof status !== 'object' || status === null || Array.isArray(status)) {
          throw new TypeError()
        }
        const descriptors = Object.getOwnPropertyDescriptors(status)
        if (
          Object.getPrototypeOf(status) !== Object.prototype ||
          Object.getOwnPropertySymbols(status).length !== 0 ||
          Object.keys(descriptors).length !== 3 ||
          descriptors.version?.value !== 1 ||
          descriptors.actionType?.value !== 'feishu.reply' ||
          (descriptors.capability?.value !== 'ready' &&
            descriptors.capability?.value !== 'unavailable') ||
          Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
        ) {
          throw new TypeError()
        }
        return Object.freeze({
          version: 1,
          capability: descriptors.capability.value,
          actionType: 'feishu.reply',
          ttlSeconds: WORKBENCH_REPLY_APPROVAL_TTL_MS / 1_000,
        })
      } catch {
        return Object.freeze({
          version: 1,
          capability: 'unavailable',
          actionType: 'feishu.reply',
          ttlSeconds: WORKBENCH_REPLY_APPROVAL_TTL_MS / 1_000,
        })
      }
    },
    async request(requestValue: WorkbenchFeishuReplyProposalRequest, signalValue: AbortSignal) {
      const request = requestAt(requestValue)
      const signal = signalAt(signalValue)
      throwIfCancelled(signal)
      const resolution = await resolve(
        options,
        {
          version: 1,
          workItemId: request.workItemId,
          draftRevision: request.draftRevision,
        },
        signal,
      )
      throwIfCancelled(signal)
      const existing = currentApproval(options.database, resolution.proposal)
      const requestedAt = existing?.requestedAt ?? timestampAt(options.now)
      const expiresAt =
        existing?.expiresAt ??
        parseIsoTimestamp(
          new Date(Date.parse(requestedAt) + WORKBENCH_REPLY_APPROVAL_TTL_MS).toISOString(),
        )
      let stored: ReturnType<TwinDeskDatabase['requestActionApproval']>
      try {
        stored = options.database.requestActionApproval({
          kind: 'action_approval_request',
          schemaVersion: 1,
          id: workbenchFeishuReplyApprovalId(resolution.proposal),
          proposalId: resolution.proposal.id,
          requestedAt,
          expiresAt,
        })
      } catch {
        throw fail('approval_unavailable', 'The Feishu reply approval could not be requested.')
      }
      const audit = auditDisposition(
        options.database,
        stored.approval,
        stored.proposal,
        resolution.draft,
        'request',
      )
      return snapshot(
        { draft: resolution.draft, proposal: stored.proposal },
        stored.approval,
        'request',
        stored.disposition === 'inserted'
          ? 'applied'
          : audit === 'inserted'
            ? 'repaired'
            : 'recovered',
      )
    },
    async decide(
      requestValue: WorkbenchFeishuReplyApprovalDecisionRequest,
      signalValue: AbortSignal,
    ) {
      const request = decisionAt(requestValue)
      const signal = signalAt(signalValue)
      throwIfCancelled(signal)
      const resolution = await resolve(
        options,
        {
          version: 1,
          workItemId: request.workItemId,
          draftRevision: request.draftRevision,
        },
        signal,
      )
      throwIfCancelled(signal)
      const existing = currentApproval(options.database, resolution.proposal)
      if (existing === undefined) {
        throw fail('approval_unavailable', 'Request approval for the exact Feishu reply first.')
      }
      const now = timestampAt(options.now)
      const chosenDecision =
        existing.decision === 'expired' ||
        (existing.decision === 'pending' && Date.parse(now) > Date.parse(existing.expiresAt))
          ? 'expired'
          : request.decision
      if (existing.decision !== 'pending' && existing.decision !== chosenDecision) {
        throw fail('approval_unavailable', 'The Feishu reply approval already has a decision.')
      }
      const decidedAt = existing.decidedAt ?? now
      let stored: ReturnType<TwinDeskDatabase['decideActionApproval']>
      try {
        stored = options.database.decideActionApproval({
          kind: 'action_approval_decision',
          schemaVersion: 1,
          approvalId: existing.id,
          proposalId: resolution.proposal.id,
          decision: chosenDecision,
          ...computeActionApprovalBindings(resolution.proposal),
          decidedAt,
          ...(chosenDecision === 'expired' ? {} : { responderUserId: LOCAL_RESPONDER_ID }),
        })
      } catch {
        throw fail(
          'approval_unavailable',
          'The Feishu reply approval decision could not be stored.',
        )
      }
      const audit = auditDisposition(
        options.database,
        stored.approval,
        stored.proposal,
        resolution.draft,
        'decision',
      )
      return snapshot(
        { draft: resolution.draft, proposal: stored.proposal },
        stored.approval,
        'decision',
        stored.disposition === 'applied'
          ? 'applied'
          : audit === 'inserted'
            ? 'repaired'
            : 'recovered',
      )
    },
  })
}
