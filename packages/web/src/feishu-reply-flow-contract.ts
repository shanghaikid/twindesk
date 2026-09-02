import {
  parseModelDraftCreateRequest,
  parseModelDraftCreateSnapshot,
  type ModelDraftCreateSnapshot,
} from './model-draft-contract.ts'
import {
  parseFeishuReplyApprovalSnapshot,
  type FeishuReplyApprovalSnapshot,
} from './feishu-reply-approval-contract.ts'
import {
  parseFeishuReplyExecutionSnapshot,
  type FeishuReplyExecutionSnapshot,
} from './feishu-reply-execution-contract.ts'
import {
  parseFeishuReplyProposalSnapshot,
  type FeishuReplyProposalSnapshot,
} from './feishu-reply-proposal-contract.ts'

export interface FeishuReplyFlowRequest {
  readonly version: 1
  readonly workItemId: string
}

export type FeishuReplyFlowSnapshot =
  | { readonly version: 1; readonly stage: 'empty' }
  | {
      readonly version: 1
      readonly stage: 'draft'
      readonly draft: ModelDraftCreateSnapshot
    }
  | {
      readonly version: 1
      readonly stage: 'proposal'
      readonly draft: ModelDraftCreateSnapshot
      readonly proposal: FeishuReplyProposalSnapshot
    }
  | {
      readonly version: 1
      readonly stage: 'approval'
      readonly draft: ModelDraftCreateSnapshot
      readonly approval: FeishuReplyApprovalSnapshot
    }
  | {
      readonly version: 1
      readonly stage: 'execution'
      readonly draft: ModelDraftCreateSnapshot
      readonly approval: FeishuReplyApprovalSnapshot
      readonly execution: FeishuReplyExecutionSnapshot
    }

type UnknownRecord = Readonly<Record<string, unknown>>
type ProposalView = FeishuReplyApprovalSnapshot['proposal']
type AnyProposalView = ProposalView | FeishuReplyProposalSnapshot['proposal']

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu reply flow.')
}

function recordAt(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    return invalid()
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    invalid()
  }
}

export function parseFeishuReplyFlowRequest(value: unknown): FeishuReplyFlowRequest {
  const parsed = parseModelDraftCreateRequest(value)
  return Object.freeze({ version: 1, workItemId: parsed.workItemId })
}

function assertDraftBinding(draft: ModelDraftCreateSnapshot, proposal: AnyProposalView): void {
  if (
    draft.disposition !== 'recovered' ||
    draft.draft.workItemId !== proposal.workItemId ||
    draft.draft.revision !== proposal.draftRevision ||
    draft.draft.state !== 'ready_for_review' ||
    draft.draft.content.mediaType !== proposal.content.mediaType ||
    draft.draft.content.text !== proposal.content.text
  ) {
    invalid()
  }
}

function assertSameProposal(left: ProposalView, right: ProposalView): void {
  if (
    left.workItemId !== right.workItemId ||
    left.draftRevision !== right.draftRevision ||
    left.actionType !== right.actionType ||
    left.risk !== right.risk ||
    left.state !== right.state ||
    left.identity.connectorId !== right.identity.connectorId ||
    left.identity.accountId !== right.identity.accountId ||
    left.identity.identityType !== right.identity.identityType ||
    left.identity.displayName !== right.identity.displayName ||
    left.target.connectorId !== right.target.connectorId ||
    left.target.accountId !== right.target.accountId ||
    left.target.objectType !== right.target.objectType ||
    left.target.externalId !== right.target.externalId ||
    left.target.sourceTimestamp !== right.target.sourceTimestamp ||
    left.content.mediaType !== right.content.mediaType ||
    left.content.text !== right.content.text ||
    left.createdAt !== right.createdAt
  ) {
    invalid()
  }
}

export function parseFeishuReplyFlowSnapshot(value: unknown): FeishuReplyFlowSnapshot {
  const record = recordAt(value)
  if (record.version !== 1) return invalid()
  if (record.stage === 'empty') {
    exactKeys(record, ['version', 'stage'])
    return Object.freeze({ version: 1, stage: 'empty' })
  }
  if (record.stage === 'draft') {
    exactKeys(record, ['version', 'stage', 'draft'])
    const draft = parseModelDraftCreateSnapshot(record.draft)
    if (draft.disposition !== 'recovered') return invalid()
    return Object.freeze({ version: 1, stage: 'draft', draft })
  }
  if (record.stage === 'proposal') {
    exactKeys(record, ['version', 'stage', 'draft', 'proposal'])
    const draft = parseModelDraftCreateSnapshot(record.draft)
    const proposal = parseFeishuReplyProposalSnapshot(record.proposal)
    assertDraftBinding(draft, proposal.proposal)
    return Object.freeze({ version: 1, stage: 'proposal', draft, proposal })
  }
  if (record.stage === 'approval') {
    exactKeys(record, ['version', 'stage', 'draft', 'approval'])
    const draft = parseModelDraftCreateSnapshot(record.draft)
    const approval = parseFeishuReplyApprovalSnapshot(record.approval)
    if (
      approval.disposition !== 'recovered' ||
      (approval.approval.decision === 'pending') !== (approval.operation === 'request') ||
      ['succeeded', 'failed', 'uncertain'].includes(approval.proposal.state)
    ) {
      return invalid()
    }
    assertDraftBinding(draft, approval.proposal)
    return Object.freeze({ version: 1, stage: 'approval', draft, approval })
  }
  if (record.stage === 'execution') {
    exactKeys(record, ['version', 'stage', 'draft', 'approval', 'execution'])
    const draft = parseModelDraftCreateSnapshot(record.draft)
    const approval = parseFeishuReplyApprovalSnapshot(record.approval)
    const execution = parseFeishuReplyExecutionSnapshot(record.execution)
    if (
      approval.disposition !== 'recovered' ||
      approval.operation !== 'decision' ||
      approval.approval.decision !== 'approved' ||
      execution.disposition !== 'recovered'
    ) {
      return invalid()
    }
    assertDraftBinding(draft, approval.proposal)
    assertSameProposal(approval.proposal, execution.proposal)
    return Object.freeze({ version: 1, stage: 'execution', draft, approval, execution })
  }
  return invalid()
}
