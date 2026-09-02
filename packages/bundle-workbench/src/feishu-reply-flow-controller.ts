import type { ActionProposal, ApprovalRecord, Draft, WorkItemId } from '@twindesk/domain'
import { findBuiltInPersonaConfiguration } from '@twindesk/plugin-work-hub/persona-presets'
import {
  computeActionApprovalBindings,
  computeApprovalExecutionAttemptId,
  type StoredActionReceipt,
  type TwinDeskDatabase,
} from '@twindesk/storage-sqlite'

import { workbenchFeishuReplyApprovalId } from './feishu-reply-approval-controller.ts'

export type WorkbenchFeishuReplyFlowErrorCode =
  'invalid_options' | 'invalid_request' | 'flow_unavailable'

export class WorkbenchFeishuReplyFlowError extends Error {
  readonly code: WorkbenchFeishuReplyFlowErrorCode

  constructor(code: WorkbenchFeishuReplyFlowErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchFeishuReplyFlowError'
    this.code = code
  }
}

export interface WorkbenchFeishuReplyFlowControllerOptions {
  readonly database: TwinDeskDatabase
}

export interface WorkbenchFeishuReplyFlowController {
  read(workItemId: string, signal: AbortSignal): Promise<unknown>
}

const MAX_DRAFT_REVISION = 100
const REQUIRED_DATABASE_METHODS = Object.freeze([
  'getWorkItem',
  'getDraftByWorkItemRevision',
  'getLatestDraftByWorkItem',
  'getLatestActionProposalByWorkItem',
  'getActionApproval',
  'getActionExecutionReceipt',
])

function fail(
  code: WorkbenchFeishuReplyFlowErrorCode,
  message: string,
): WorkbenchFeishuReplyFlowError {
  return new WorkbenchFeishuReplyFlowError(code, message)
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

function optionsAt(value: unknown): WorkbenchFeishuReplyFlowControllerOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      !Object.hasOwn(descriptors, 'database') ||
      !Object.hasOwn(descriptors.database as PropertyDescriptor, 'value') ||
      typeof descriptors.database?.value !== 'object' ||
      descriptors.database.value === null ||
      REQUIRED_DATABASE_METHODS.some(
        (method) => !hasDataMethod(descriptors.database?.value as object, method),
      )
    ) {
      throw new TypeError()
    }
    return Object.freeze({ database: descriptors.database.value as TwinDeskDatabase })
  } catch {
    throw fail('invalid_options', 'The Workbench Feishu reply flow options are invalid.')
  }
}

function workItemIdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 512
  ) {
    throw fail('invalid_request', 'The Workbench Feishu reply flow request is invalid.')
  }
  return value
}

function signalAt(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Workbench Feishu reply flow request is invalid.')
  }
  return value
}

function throwIfCancelled(signal: AbortSignal): void {
  try {
    signal.throwIfAborted()
  } catch {
    throw fail('flow_unavailable', 'The Workbench Feishu reply flow read was cancelled.')
  }
}

function latestDraft(database: TwinDeskDatabase, workItemId: WorkItemId): Draft | undefined {
  const latest = database.getLatestDraftByWorkItem(workItemId)
  if (latest === undefined) return undefined
  if (
    latest.workItemId !== workItemId ||
    latest.revision < 1 ||
    latest.revision > MAX_DRAFT_REVISION ||
    latest.state === 'superseded'
  ) {
    throw fail('flow_unavailable', 'The durable Draft revision chain is invalid.')
  }
  let current: Draft | undefined
  for (let revision = 1; revision <= latest.revision; revision += 1) {
    const candidate = database.getDraftByWorkItemRevision(workItemId, revision)
    if (
      candidate === undefined ||
      candidate.workItemId !== workItemId ||
      candidate.revision !== revision ||
      (current !== undefined &&
        (current.state !== 'superseded' || candidate.personaId !== current.personaId))
    ) {
      throw fail('flow_unavailable', 'The durable Draft revision chain is invalid.')
    }
    current = candidate
  }
  if (current?.id !== latest.id || current.state !== latest.state) {
    throw fail('flow_unavailable', 'The durable Draft revision chain is invalid.')
  }
  return current
}

function draftSnapshot(draft: Draft, personaLabel: string): unknown {
  return Object.freeze({
    version: 1,
    disposition: 'recovered',
    autonomy: 'draft_only',
    externalWritesAvailable: false,
    draft: Object.freeze({
      workItemId: draft.workItemId,
      personaLabel,
      revision: draft.revision,
      state: draft.state,
      content: Object.freeze({ ...draft.content }),
      updatedAt: draft.updatedAt,
    }),
  })
}

function proposalView(proposal: ActionProposal, draft: Draft): unknown {
  return Object.freeze({
    workItemId: proposal.workItemId,
    draftRevision: draft.revision,
    actionType: proposal.actionType,
    risk: proposal.risk,
    state: proposal.state,
    identity: Object.freeze({ ...proposal.identity }),
    target: Object.freeze({ ...proposal.target }),
    content: Object.freeze({ ...proposal.content }),
    createdAt: proposal.createdAt,
  })
}

function proposalSnapshot(proposal: ActionProposal, draft: Draft): unknown {
  return Object.freeze({
    version: 1,
    disposition: 'recovered',
    approvalAvailable: false,
    executionAvailable: false,
    proposal: proposalView(proposal, draft),
  })
}

function approvalSnapshot(
  proposal: ActionProposal,
  draft: Draft,
  approval: ApprovalRecord,
): unknown {
  return Object.freeze({
    version: 1,
    operation: approval.decision === 'pending' ? 'request' : 'decision',
    disposition: 'recovered',
    executionAvailable: false,
    approval: Object.freeze({
      decision: approval.decision,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
    }),
    proposal: proposalView(proposal, draft),
  })
}

function executionSnapshot(
  proposal: ActionProposal,
  draft: Draft,
  stored: StoredActionReceipt,
): unknown {
  const receipt = stored.receipt
  return Object.freeze({
    version: 1,
    disposition: 'recovered',
    proposal: Object.freeze({
      ...(proposalView(proposal, draft) as Record<string, unknown>),
      state: receipt.outcome,
    }),
    execution: Object.freeze({
      outcome: receipt.outcome,
      attemptedAt: receipt.attemptedAt,
      ...(receipt.outcome === 'succeeded'
        ? { externalReference: Object.freeze({ ...receipt.externalReference }) }
        : {
            retryDisposition: receipt.retryDisposition,
            issue: Object.freeze({ ...receipt.error }),
          }),
    }),
  })
}

function assertProposal(proposal: ActionProposal, draft: Draft): void {
  if (
    proposal.workItemId !== draft.workItemId ||
    proposal.draftId !== draft.id ||
    proposal.actionType !== 'feishu.reply' ||
    proposal.risk !== 'write' ||
    proposal.identity.connectorId !== 'feishu' ||
    proposal.identity.identityType !== 'user' ||
    proposal.target.connectorId !== 'feishu' ||
    proposal.target.accountId !== proposal.identity.accountId ||
    proposal.target.objectType !== 'message' ||
    proposal.content.mediaType !== 'text/plain' ||
    draft.state !== 'ready_for_review' ||
    proposal.content.mediaType !== draft.content.mediaType ||
    proposal.content.text !== draft.content.text
  ) {
    throw fail('flow_unavailable', 'The durable Feishu reply proposal is invalid.')
  }
}

function assertApproval(proposal: ActionProposal, approval: ApprovalRecord): void {
  const bindings = computeActionApprovalBindings(proposal)
  const stateMatches =
    (approval.decision === 'pending' && proposal.state === 'awaiting_approval') ||
    (approval.decision === 'approved' &&
      ['approved', 'executing', 'succeeded', 'failed', 'uncertain'].includes(proposal.state)) ||
    (approval.decision === 'rejected' && proposal.state === 'rejected') ||
    ((approval.decision === 'cancelled' || approval.decision === 'expired') &&
      proposal.state === 'cancelled')
  if (
    approval.id !== workbenchFeishuReplyApprovalId(proposal) ||
    approval.proposalId !== proposal.id ||
    approval.identityDigest !== bindings.identityDigest ||
    approval.targetDigest !== bindings.targetDigest ||
    approval.contentDigest !== bindings.contentDigest ||
    !stateMatches
  ) {
    throw fail('flow_unavailable', 'The durable Feishu reply approval is invalid.')
  }
}

function assertReceipt(
  proposal: ActionProposal,
  approval: ApprovalRecord,
  stored: StoredActionReceipt,
): void {
  const receipt = stored.receipt
  if (
    approval.decision !== 'approved' ||
    stored.executionAttemptId !== computeApprovalExecutionAttemptId(approval.id) ||
    receipt.proposalId !== proposal.id ||
    receipt.connectorId !== 'feishu' ||
    receipt.accountId !== proposal.identity.accountId ||
    receipt.idempotencyKey !== proposal.idempotencyKey ||
    proposal.state !== receipt.outcome
  ) {
    throw fail('flow_unavailable', 'The durable Feishu reply receipt is invalid.')
  }
}

/** Rebuild the presentation-only action flow from durable local records after a refresh. */
export function createWorkbenchFeishuReplyFlowController(
  optionsValue: WorkbenchFeishuReplyFlowControllerOptions,
): WorkbenchFeishuReplyFlowController {
  const options = optionsAt(optionsValue)
  return Object.freeze({
    async read(workItemIdValue: string, signalValue: AbortSignal) {
      const workItemId = workItemIdAt(workItemIdValue) as WorkItemId
      const signal = signalAt(signalValue)
      throwIfCancelled(signal)
      try {
        const workItem = options.database.getWorkItem(workItemId)
        if (workItem === undefined || workItem.id !== workItemId) {
          throw fail('flow_unavailable', 'The Work Item is unavailable.')
        }
        const draft = latestDraft(options.database, workItem.id)
        if (draft === undefined) return Object.freeze({ version: 1, stage: 'empty' })
        if (
          workItem.selectedPersonaId === undefined ||
          draft.personaId !== workItem.selectedPersonaId
        ) {
          throw fail('flow_unavailable', 'The durable Draft Persona binding is invalid.')
        }
        const persona = findBuiltInPersonaConfiguration(draft.personaId)
        if (persona === undefined) {
          throw fail('flow_unavailable', 'The durable Draft Persona is unavailable.')
        }
        const draftResult = draftSnapshot(draft, persona.name)
        throwIfCancelled(signal)
        const proposal = options.database.getLatestActionProposalByWorkItem(workItem.id)
        if (proposal === undefined || proposal.draftId !== draft.id) {
          if (proposal !== undefined) {
            const staleApproval = options.database.getActionApproval(
              workbenchFeishuReplyApprovalId(proposal),
            )
            if (staleApproval?.decision === 'pending' || staleApproval?.decision === 'approved') {
              throw fail('flow_unavailable', 'The durable Feishu reply flow is inconsistent.')
            }
          }
          return Object.freeze({ version: 1, stage: 'draft', draft: draftResult })
        }
        assertProposal(proposal, draft)
        const approvalId = workbenchFeishuReplyApprovalId(proposal)
        const approval = options.database.getActionApproval(approvalId)
        if (approval === undefined) {
          if (proposal.state !== 'proposed') {
            throw fail('flow_unavailable', 'The durable Feishu reply approval is missing.')
          }
          return Object.freeze({
            version: 1,
            stage: 'proposal',
            draft: draftResult,
            proposal: proposalSnapshot(proposal, draft),
          })
        }
        assertApproval(proposal, approval)
        const approvalResult = approvalSnapshot(proposal, draft, approval)
        const stored = options.database.getActionExecutionReceipt(
          computeApprovalExecutionAttemptId(approval.id),
        )
        if (stored === undefined) {
          if (['succeeded', 'failed', 'uncertain'].includes(proposal.state)) {
            throw fail('flow_unavailable', 'The durable Feishu reply receipt is missing.')
          }
          return Object.freeze({
            version: 1,
            stage: 'approval',
            draft: draftResult,
            approval: approvalResult,
          })
        }
        assertReceipt(proposal, approval, stored)
        return Object.freeze({
          version: 1,
          stage: 'execution',
          draft: draftResult,
          approval: approvalResult,
          execution: executionSnapshot(proposal, draft, stored),
        })
      } catch (error) {
        if (error instanceof WorkbenchFeishuReplyFlowError) throw error
        if (signal.aborted) throwIfCancelled(signal)
        throw fail('flow_unavailable', 'The durable Feishu reply flow is unavailable.')
      }
    },
  })
}
