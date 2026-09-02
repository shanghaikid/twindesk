export type FeishuReplyApprovalCapability = 'unavailable' | 'ready'
export type FeishuReplyApprovalDecision =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface FeishuReplyApprovalStatusSnapshot {
  readonly version: 1
  readonly capability: FeishuReplyApprovalCapability
  readonly actionType: 'feishu.reply'
  readonly ttlSeconds: 900
}

export interface FeishuReplyApprovalRequest {
  readonly version: 1
  readonly workItemId: string
  readonly draftRevision: number
}

export interface FeishuReplyApprovalDecisionRequest extends FeishuReplyApprovalRequest {
  readonly decision: 'approved' | 'rejected' | 'cancelled'
}

export interface FeishuReplyApprovalSnapshot {
  readonly version: 1
  readonly operation: 'request' | 'decision'
  readonly disposition: 'applied' | 'recovered' | 'repaired'
  readonly executionAvailable: false
  readonly approval: {
    readonly decision: FeishuReplyApprovalDecision
    readonly requestedAt: string
    readonly expiresAt: string
    readonly decidedAt?: string
  }
  readonly proposal: {
    readonly workItemId: string
    readonly draftRevision: number
    readonly actionType: 'feishu.reply'
    readonly risk: 'write'
    readonly state:
      | 'awaiting_approval'
      | 'approved'
      | 'rejected'
      | 'cancelled'
      | 'executing'
      | 'succeeded'
      | 'failed'
      | 'uncertain'
    readonly identity: {
      readonly connectorId: 'feishu'
      readonly accountId: string
      readonly identityType: 'user'
      readonly displayName: string
    }
    readonly target: {
      readonly connectorId: 'feishu'
      readonly accountId: string
      readonly objectType: 'message'
      readonly externalId: string
      readonly sourceTimestamp: string
    }
    readonly content: {
      readonly mediaType: 'text/plain'
      readonly text: string
    }
    readonly createdAt: string
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(message: string): never {
  throw new Error(message)
}

function recordAt(value: unknown, message: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(message)
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    return invalid(message)
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function exactKeys(record: UnknownRecord, expected: readonly string[], message: string): void {
  const keys = Object.keys(record)
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    invalid(message)
  }
}

function identifierAt(value: unknown, message: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > maximum * 4
  ) {
    return invalid(message)
  }
  return value
}

function timestampAt(value: unknown, message: string): string {
  if (typeof value !== 'string') return invalid(message)
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return invalid(message)
  const base = value.replace(/(?:\.\d{1,3})?Z$/u, '')
  const canonical = `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`
  if (new Date(value).toISOString() !== canonical) return invalid(message)
  return value
}

function draftIdentity(
  value: unknown,
  revision: unknown,
  message: string,
): FeishuReplyApprovalRequest {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > 100) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    workItemId: identifierAt(value, message, 200),
    draftRevision: revision as number,
  })
}

export function parseFeishuReplyApprovalStatusSnapshot(
  value: unknown,
): FeishuReplyApprovalStatusSnapshot {
  const message = 'Local API returned an invalid Feishu reply approval status.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'capability', 'actionType', 'ttlSeconds'], message)
  if (
    record.version !== 1 ||
    (record.capability !== 'unavailable' && record.capability !== 'ready') ||
    record.actionType !== 'feishu.reply' ||
    record.ttlSeconds !== 900
  ) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    capability: record.capability,
    actionType: 'feishu.reply',
    ttlSeconds: 900,
  })
}

export function parseFeishuReplyApprovalRequest(value: unknown): FeishuReplyApprovalRequest {
  const message = 'The Feishu reply approval request is invalid.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'workItemId', 'draftRevision'], message)
  if (record.version !== 1) return invalid(message)
  return draftIdentity(record.workItemId, record.draftRevision, message)
}

export function parseFeishuReplyApprovalDecisionRequest(
  value: unknown,
): FeishuReplyApprovalDecisionRequest {
  const message = 'The Feishu reply approval decision is invalid.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'workItemId', 'draftRevision', 'decision'], message)
  if (
    record.version !== 1 ||
    (record.decision !== 'approved' &&
      record.decision !== 'rejected' &&
      record.decision !== 'cancelled')
  ) {
    return invalid(message)
  }
  return Object.freeze({
    ...draftIdentity(record.workItemId, record.draftRevision, message),
    decision: record.decision,
  })
}

export function parseFeishuReplyApprovalSnapshot(value: unknown): FeishuReplyApprovalSnapshot {
  const message = 'Local API returned an invalid Feishu reply approval.'
  const record = recordAt(value, message)
  exactKeys(
    record,
    ['version', 'operation', 'disposition', 'executionAvailable', 'approval', 'proposal'],
    message,
  )
  const approval = recordAt(record.approval, message)
  const approvalKeys =
    approval.decidedAt === undefined
      ? ['decision', 'requestedAt', 'expiresAt']
      : ['decision', 'requestedAt', 'expiresAt', 'decidedAt']
  exactKeys(approval, approvalKeys, message)
  const proposal = recordAt(record.proposal, message)
  exactKeys(
    proposal,
    [
      'workItemId',
      'draftRevision',
      'actionType',
      'risk',
      'state',
      'identity',
      'target',
      'content',
      'createdAt',
    ],
    message,
  )
  const identity = recordAt(proposal.identity, message)
  exactKeys(identity, ['connectorId', 'accountId', 'identityType', 'displayName'], message)
  const target = recordAt(proposal.target, message)
  exactKeys(
    target,
    ['connectorId', 'accountId', 'objectType', 'externalId', 'sourceTimestamp'],
    message,
  )
  const content = recordAt(proposal.content, message)
  exactKeys(content, ['mediaType', 'text'], message)
  const decisions: readonly FeishuReplyApprovalDecision[] = [
    'pending',
    'approved',
    'rejected',
    'cancelled',
    'expired',
  ]
  const states: readonly FeishuReplyApprovalSnapshot['proposal']['state'][] = [
    'awaiting_approval',
    'approved',
    'rejected',
    'cancelled',
    'executing',
    'succeeded',
    'failed',
    'uncertain',
  ]
  if (
    record.version !== 1 ||
    (record.operation !== 'request' && record.operation !== 'decision') ||
    (record.disposition !== 'applied' &&
      record.disposition !== 'recovered' &&
      record.disposition !== 'repaired') ||
    record.executionAvailable !== false ||
    !decisions.includes(approval.decision as FeishuReplyApprovalDecision) ||
    !states.includes(proposal.state as FeishuReplyApprovalSnapshot['proposal']['state']) ||
    proposal.actionType !== 'feishu.reply' ||
    proposal.risk !== 'write' ||
    identity.connectorId !== 'feishu' ||
    identity.identityType !== 'user' ||
    target.connectorId !== 'feishu' ||
    target.accountId !== identity.accountId ||
    target.objectType !== 'message' ||
    content.mediaType !== 'text/plain' ||
    typeof content.text !== 'string' ||
    content.text.trim().length === 0 ||
    content.text.includes('\u0000') ||
    content.text.length > 20_000 ||
    new TextEncoder().encode(content.text).byteLength > 64 * 1_024
  ) {
    return invalid(message)
  }
  const decision = approval.decision as FeishuReplyApprovalDecision
  const state = proposal.state as FeishuReplyApprovalSnapshot['proposal']['state']
  if (
    (decision === 'pending' && state !== 'awaiting_approval') ||
    (decision === 'approved' &&
      !['approved', 'executing', 'succeeded', 'failed', 'uncertain'].includes(state)) ||
    (decision === 'rejected' && state !== 'rejected') ||
    ((decision === 'cancelled' || decision === 'expired') && state !== 'cancelled') ||
    (decision === 'pending') !== (approval.decidedAt === undefined)
  ) {
    return invalid(message)
  }
  const requestedAt = timestampAt(approval.requestedAt, message)
  const expiresAt = timestampAt(approval.expiresAt, message)
  const decidedAt =
    approval.decidedAt === undefined ? undefined : timestampAt(approval.decidedAt, message)
  const sourceTimestamp = timestampAt(target.sourceTimestamp, message)
  const createdAt = timestampAt(proposal.createdAt, message)
  if (
    Date.parse(createdAt) < Date.parse(sourceTimestamp) ||
    Date.parse(requestedAt) < Date.parse(createdAt) ||
    Date.parse(expiresAt) <= Date.parse(requestedAt) ||
    Date.parse(expiresAt) - Date.parse(requestedAt) !== 900_000 ||
    (decidedAt !== undefined && Date.parse(decidedAt) < Date.parse(requestedAt)) ||
    (decidedAt !== undefined &&
      decision !== 'expired' &&
      Date.parse(decidedAt) > Date.parse(expiresAt)) ||
    (decidedAt !== undefined &&
      decision === 'expired' &&
      Date.parse(decidedAt) < Date.parse(expiresAt))
  ) {
    return invalid(message)
  }
  const draft = draftIdentity(proposal.workItemId, proposal.draftRevision, message)
  return Object.freeze({
    version: 1,
    operation: record.operation,
    disposition: record.disposition,
    executionAvailable: false,
    approval: Object.freeze({
      decision,
      requestedAt,
      expiresAt,
      ...(decidedAt === undefined ? {} : { decidedAt }),
    }),
    proposal: Object.freeze({
      workItemId: draft.workItemId,
      draftRevision: draft.draftRevision,
      actionType: 'feishu.reply',
      risk: 'write',
      state,
      identity: Object.freeze({
        connectorId: 'feishu',
        accountId: identifierAt(identity.accountId, message),
        identityType: 'user',
        displayName: identifierAt(identity.displayName, message, 160),
      }),
      target: Object.freeze({
        connectorId: 'feishu',
        accountId: identifierAt(target.accountId, message),
        objectType: 'message',
        externalId: identifierAt(target.externalId, message),
        sourceTimestamp,
      }),
      content: Object.freeze({ mediaType: 'text/plain', text: content.text }),
      createdAt,
    }),
  })
}
