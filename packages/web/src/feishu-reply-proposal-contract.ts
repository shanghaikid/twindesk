export type FeishuReplyProposalCapability = 'unavailable' | 'ready'

export interface FeishuReplyProposalStatusSnapshot {
  readonly version: 1
  readonly capability: FeishuReplyProposalCapability
  readonly actionType: 'feishu.reply'
}

export interface FeishuReplyProposalCreateRequest {
  readonly version: 1
  readonly workItemId: string
  readonly draftRevision: number
}

export interface FeishuReplyProposalSnapshot {
  readonly version: 1
  readonly disposition: 'created' | 'recovered' | 'repaired'
  readonly approvalAvailable: false
  readonly executionAvailable: false
  readonly proposal: {
    readonly workItemId: string
    readonly draftRevision: number
    readonly actionType: 'feishu.reply'
    readonly risk: 'write'
    readonly state: 'proposed'
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

export function parseFeishuReplyProposalStatusSnapshot(
  value: unknown,
): FeishuReplyProposalStatusSnapshot {
  const message = 'Local API returned an invalid Feishu reply preview status.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'capability', 'actionType'], message)
  if (
    record.version !== 1 ||
    (record.capability !== 'unavailable' && record.capability !== 'ready') ||
    record.actionType !== 'feishu.reply'
  ) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    capability: record.capability,
    actionType: 'feishu.reply',
  })
}

export function parseFeishuReplyProposalCreateRequest(
  value: unknown,
): FeishuReplyProposalCreateRequest {
  const message = 'The Feishu reply preview request is invalid.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'workItemId', 'draftRevision'], message)
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.draftRevision) ||
    (record.draftRevision as number) < 1 ||
    (record.draftRevision as number) > 100
  ) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    workItemId: identifierAt(record.workItemId, message, 200),
    draftRevision: record.draftRevision as number,
  })
}

export function parseFeishuReplyProposalSnapshot(value: unknown): FeishuReplyProposalSnapshot {
  const message = 'Local API returned an invalid Feishu reply preview.'
  const record = recordAt(value, message)
  exactKeys(
    record,
    ['version', 'disposition', 'approvalAvailable', 'executionAvailable', 'proposal'],
    message,
  )
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
  if (
    record.version !== 1 ||
    (record.disposition !== 'created' &&
      record.disposition !== 'recovered' &&
      record.disposition !== 'repaired') ||
    record.approvalAvailable !== false ||
    record.executionAvailable !== false ||
    !Number.isSafeInteger(proposal.draftRevision) ||
    (proposal.draftRevision as number) < 1 ||
    (proposal.draftRevision as number) > 100 ||
    proposal.actionType !== 'feishu.reply' ||
    proposal.risk !== 'write' ||
    proposal.state !== 'proposed' ||
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
  const targetTimestamp = timestampAt(target.sourceTimestamp, message)
  const createdAt = timestampAt(proposal.createdAt, message)
  if (Date.parse(createdAt) < Date.parse(targetTimestamp)) return invalid(message)
  return Object.freeze({
    version: 1,
    disposition: record.disposition,
    approvalAvailable: false,
    executionAvailable: false,
    proposal: Object.freeze({
      workItemId: identifierAt(proposal.workItemId, message, 200),
      draftRevision: proposal.draftRevision as number,
      actionType: 'feishu.reply',
      risk: 'write',
      state: 'proposed',
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
        sourceTimestamp: targetTimestamp,
      }),
      content: Object.freeze({ mediaType: 'text/plain', text: content.text }),
      createdAt,
    }),
  })
}
