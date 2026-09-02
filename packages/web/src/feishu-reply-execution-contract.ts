export interface FeishuReplyExecutionStatusSnapshot {
  readonly version: 1
  readonly capability: 'unavailable' | 'ready'
  readonly actionType: 'feishu.reply'
}

export interface FeishuReplyExecutionRequest {
  readonly version: 1
  readonly workItemId: string
  readonly draftRevision: number
}

export interface FeishuReplyExecutionSnapshot {
  readonly version: 1
  readonly disposition: 'executed' | 'recovered'
  readonly proposal: {
    readonly workItemId: string
    readonly draftRevision: number
    readonly actionType: 'feishu.reply'
    readonly risk: 'write'
    readonly state: 'succeeded' | 'failed' | 'uncertain'
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
    readonly content: { readonly mediaType: 'text/plain'; readonly text: string }
    readonly createdAt: string
  }
  readonly execution:
    | {
        readonly outcome: 'succeeded'
        readonly attemptedAt: string
        readonly externalReference: {
          readonly connectorId: 'feishu'
          readonly accountId: string
          readonly objectType: 'message'
          readonly externalId: string
          readonly sourceTimestamp: string
        }
      }
    | {
        readonly outcome: 'failed'
        readonly attemptedAt: string
        readonly retryDisposition: 'do_not_retry' | 'retry_same_key'
        readonly issue: {
          readonly code: string
          readonly message: string
          readonly retryable: boolean
        }
      }
    | {
        readonly outcome: 'uncertain'
        readonly attemptedAt: string
        readonly retryDisposition: 'reconcile_first'
        readonly issue: {
          readonly code: string
          readonly message: string
          readonly retryable: boolean
        }
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
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
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
  if (new Date(value).toISOString() !== `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`) {
    return invalid(message)
  }
  return value
}

export function parseFeishuReplyExecutionStatusSnapshot(
  value: unknown,
): FeishuReplyExecutionStatusSnapshot {
  const message = 'Local API returned an invalid Feishu reply execution status.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'capability', 'actionType'], message)
  if (
    record.version !== 1 ||
    (record.capability !== 'ready' && record.capability !== 'unavailable') ||
    record.actionType !== 'feishu.reply'
  ) {
    return invalid(message)
  }
  return Object.freeze({ version: 1, capability: record.capability, actionType: 'feishu.reply' })
}

export function parseFeishuReplyExecutionRequest(value: unknown): FeishuReplyExecutionRequest {
  const message = 'The Feishu reply execution request is invalid.'
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

function proposalAt(value: unknown, message: string): FeishuReplyExecutionSnapshot['proposal'] {
  const proposal = recordAt(value, message)
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
  const request = parseFeishuReplyExecutionRequest({
    version: 1,
    workItemId: proposal.workItemId,
    draftRevision: proposal.draftRevision,
  })
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
    proposal.actionType !== 'feishu.reply' ||
    proposal.risk !== 'write' ||
    (proposal.state !== 'succeeded' &&
      proposal.state !== 'failed' &&
      proposal.state !== 'uncertain') ||
    identity.connectorId !== 'feishu' ||
    identity.identityType !== 'user' ||
    target.connectorId !== 'feishu' ||
    target.accountId !== identity.accountId ||
    target.objectType !== 'message' ||
    content.mediaType !== 'text/plain' ||
    typeof content.text !== 'string' ||
    content.text.trim().length === 0 ||
    content.text.includes('\u0000') ||
    new TextEncoder().encode(content.text).byteLength > 64 * 1_024
  ) {
    return invalid(message)
  }
  const sourceTimestamp = timestampAt(target.sourceTimestamp, message)
  const createdAt = timestampAt(proposal.createdAt, message)
  if (Date.parse(createdAt) < Date.parse(sourceTimestamp)) return invalid(message)
  return Object.freeze({
    workItemId: request.workItemId,
    draftRevision: request.draftRevision,
    actionType: 'feishu.reply',
    risk: 'write',
    state: proposal.state,
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
  })
}

export function parseFeishuReplyExecutionSnapshot(value: unknown): FeishuReplyExecutionSnapshot {
  const message = 'Local API returned an invalid Feishu reply execution result.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'disposition', 'proposal', 'execution'], message)
  if (
    record.version !== 1 ||
    (record.disposition !== 'executed' && record.disposition !== 'recovered')
  ) {
    return invalid(message)
  }
  const proposal = proposalAt(record.proposal, message)
  const execution = recordAt(record.execution, message)
  const attemptedAt = timestampAt(execution.attemptedAt, message)
  if (Date.parse(attemptedAt) < Date.parse(proposal.createdAt)) return invalid(message)
  if (execution.outcome === 'succeeded') {
    exactKeys(execution, ['outcome', 'attemptedAt', 'externalReference'], message)
    const reference = recordAt(execution.externalReference, message)
    exactKeys(
      reference,
      ['connectorId', 'accountId', 'objectType', 'externalId', 'sourceTimestamp'],
      message,
    )
    if (
      proposal.state !== 'succeeded' ||
      reference.connectorId !== 'feishu' ||
      reference.accountId !== proposal.identity.accountId ||
      reference.objectType !== 'message'
    ) {
      return invalid(message)
    }
    return Object.freeze({
      version: 1,
      disposition: record.disposition,
      proposal,
      execution: Object.freeze({
        outcome: 'succeeded',
        attemptedAt,
        externalReference: Object.freeze({
          connectorId: 'feishu',
          accountId: identifierAt(reference.accountId, message),
          objectType: 'message',
          externalId: identifierAt(reference.externalId, message),
          sourceTimestamp: timestampAt(reference.sourceTimestamp, message),
        }),
      }),
    })
  }
  exactKeys(execution, ['outcome', 'attemptedAt', 'retryDisposition', 'issue'], message)
  const issue = recordAt(execution.issue, message)
  exactKeys(issue, ['code', 'message', 'retryable'], message)
  if (
    (execution.outcome !== 'failed' && execution.outcome !== 'uncertain') ||
    proposal.state !== execution.outcome ||
    (execution.outcome === 'failed' &&
      execution.retryDisposition !== 'do_not_retry' &&
      execution.retryDisposition !== 'retry_same_key') ||
    (execution.outcome === 'uncertain' && execution.retryDisposition !== 'reconcile_first') ||
    typeof issue.retryable !== 'boolean'
  ) {
    return invalid(message)
  }
  const parsedIssue = Object.freeze({
    code: identifierAt(issue.code, message, 160),
    message: identifierAt(issue.message, message, 512),
    retryable: issue.retryable,
  })
  return Object.freeze({
    version: 1,
    disposition: record.disposition,
    proposal,
    execution:
      execution.outcome === 'failed'
        ? Object.freeze({
            outcome: 'failed',
            attemptedAt,
            retryDisposition: execution.retryDisposition as 'do_not_retry' | 'retry_same_key',
            issue: parsedIssue,
          })
        : Object.freeze({
            outcome: 'uncertain',
            attemptedAt,
            retryDisposition: 'reconcile_first',
            issue: parsedIssue,
          }),
  })
}
