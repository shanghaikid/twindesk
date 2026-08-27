import { createHash } from 'node:crypto'

import {
  parseActionProposal,
  parseApprovalRecord,
  parseContentDigest,
  parseIsoTimestamp,
  type ActionProposal,
  type ActionReceipt,
  type ApprovedAction,
  type ApprovalRecord,
  type ContentDigest,
  type IsoTimestamp,
  type SecretReference,
} from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  toFeishuActionIdentity,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import {
  FEISHU_REPLY_ACTION_TYPE,
  computeFeishuReplyIdentityFingerprint,
} from './reply-proposal.ts'

export const FEISHU_REPLY_EXECUTION_VERSION = 1 as const
const MAX_REMOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000

export type FeishuReplyExecutionErrorCode =
  | 'invalid_action'
  | 'identity_mismatch'
  | 'binding_mismatch'
  | 'approval_expired'
  | 'invalid_response'

export class FeishuReplyExecutionError extends Error {
  readonly code: FeishuReplyExecutionErrorCode

  constructor(code: FeishuReplyExecutionErrorCode, message: string) {
    super(message)
    this.name = 'FeishuReplyExecutionError'
    this.code = code
  }
}

export type FeishuReplyExecutionClientErrorCode =
  | 'not_authorized'
  | 'scope_missing'
  | 'rate_limited'
  | 'network'
  | 'rejected'
  | 'invalid_response'
  | 'unknown'

/** Payload-free failure raised by the credential-resolving Feishu adapter. */
export class FeishuReplyExecutionClientError extends Error {
  readonly code: FeishuReplyExecutionClientErrorCode

  constructor(code: FeishuReplyExecutionClientErrorCode) {
    const supported = [
      'not_authorized',
      'scope_missing',
      'rate_limited',
      'network',
      'rejected',
      'invalid_response',
      'unknown',
    ] as const
    const normalized =
      typeof code === 'string' && supported.includes(code as (typeof supported)[number])
        ? (code as FeishuReplyExecutionClientErrorCode)
        : 'unknown'
    super('The Feishu reply execution adapter failed.')
    this.name = 'FeishuReplyExecutionClientError'
    this.code = normalized
  }
}

export interface FeishuReplyExecutionRequest {
  readonly kind: 'feishu_reply_execution_request'
  readonly schemaVersion: typeof FEISHU_REPLY_EXECUTION_VERSION
  readonly accountId: string
  readonly appId: string
  readonly identityType: 'bot' | 'user'
  readonly principalId: string
  readonly credentialReference: SecretReference
  readonly targetMessageId: string
  readonly content: string
  readonly idempotencyKey: string
}

export interface FeishuReplyExecutionClient {
  /** Look up the exact idempotency key before every possible send. */
  reconcile(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown>
  /** Resolve the credential reference, recheck scopes, and send with the exact key. */
  send(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown>
}

export interface FeishuReplyExecutorOptions {
  readonly now?: () => number
}

interface ParsedAction {
  readonly proposal: ActionProposal & { readonly state: 'approved' }
  readonly approval: ApprovalRecord & {
    readonly decision: 'approved'
    readonly consumedAt?: never
  }
  readonly executionAttemptId: string
}

interface ReconciliationIdentity {
  readonly accountId: string
  readonly identityType: 'bot' | 'user'
  readonly idempotencyKey: string
  readonly targetMessageId: string
}

type ReconciliationResult =
  | (ReconciliationIdentity & { readonly status: 'absent' })
  | (ReconciliationIdentity & {
      readonly status: 'found'
      readonly messageId: string
      readonly sentAt: IsoTimestamp
    })

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(code: FeishuReplyExecutionErrorCode, message: string): FeishuReplyExecutionError {
  return new FeishuReplyExecutionError(code, message)
}

function dataRecord(value: unknown, message: string): UnknownRecord {
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
    throw fail('invalid_response', message)
  }
}

function exactKeys(record: UnknownRecord, required: readonly string[]): void {
  const allowed = new Set(required)
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw fail('invalid_response', 'The Feishu reply execution response is invalid.')
  }
}

function boundedString(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_response', 'The Feishu reply execution response is invalid.')
  }
  return value
}

function canonicalDigest(value: unknown): ContentDigest {
  return parseContentDigest(
    `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`,
  )
}

function parseAction(
  value: ApprovedAction,
  configuration: FeishuIdentityConfiguration,
): ParsedAction {
  let record: UnknownRecord
  try {
    record = dataRecord(value, 'The approved Feishu action is invalid.')
    exactKeys(record, ['proposal', 'approval', 'executionAttemptId'])
  } catch {
    throw fail('invalid_action', 'The approved Feishu action is invalid.')
  }
  let proposal: ActionProposal
  let approval: ApprovalRecord
  try {
    proposal = parseActionProposal(record.proposal)
    approval = parseApprovalRecord(record.approval)
  } catch {
    throw fail('invalid_action', 'The approved Feishu action is invalid.')
  }
  const expectedAttempt = `execution-approval-${createHash('sha256')
    .update(approval.id)
    .digest('hex')
    .slice(0, 32)}`
  if (
    proposal.actionType !== FEISHU_REPLY_ACTION_TYPE ||
    proposal.risk !== 'write' ||
    proposal.state !== 'approved' ||
    approval.decision !== 'approved' ||
    approval.consumedAt !== undefined ||
    approval.proposalId !== proposal.id ||
    record.executionAttemptId !== expectedAttempt
  ) {
    throw fail('invalid_action', 'The approved Feishu action is invalid.')
  }
  const configuredIdentity = toFeishuActionIdentity(configuration, proposal.identity.identityType)
  const keyMatch = /^feishu:reply:([a-f0-9]{64}):identity:([a-f0-9]{64}):v1$/u.exec(
    proposal.idempotencyKey,
  )
  if (
    proposal.identity.connectorId !== configuredIdentity.connectorId ||
    proposal.identity.accountId !== configuredIdentity.accountId ||
    proposal.identity.displayName !== configuredIdentity.displayName ||
    proposal.target.connectorId !== 'feishu' ||
    proposal.target.accountId !== configuration.accountId ||
    proposal.target.objectType !== 'message' ||
    proposal.target.sourceTimestamp === undefined ||
    proposal.content.mediaType !== 'text/plain' ||
    keyMatch === null ||
    keyMatch[2] !==
      computeFeishuReplyIdentityFingerprint(
        configuration,
        proposal.identity.identityType,
        keyMatch[1] as string,
      )
  ) {
    throw fail('identity_mismatch', 'The approved Feishu identity or target no longer matches.')
  }
  const identityDigest = canonicalDigest({
    connectorId: proposal.identity.connectorId,
    accountId: proposal.identity.accountId,
    identityType: proposal.identity.identityType,
    displayName: proposal.identity.displayName,
  })
  const targetDigest = canonicalDigest({
    connectorId: proposal.target.connectorId,
    accountId: proposal.target.accountId,
    objectType: proposal.target.objectType,
    externalId: proposal.target.externalId,
    sourceTimestamp: proposal.target.sourceTimestamp,
  })
  const contentDigest = canonicalDigest({
    mediaType: proposal.content.mediaType,
    text: proposal.content.text,
  })
  if (
    approval.identityDigest !== identityDigest ||
    approval.targetDigest !== targetDigest ||
    approval.contentDigest !== contentDigest ||
    proposal.contentDigest !== contentDigest
  ) {
    throw fail('binding_mismatch', 'The approved Feishu action bindings no longer match.')
  }
  return Object.freeze({
    proposal: proposal as ParsedAction['proposal'],
    approval: approval as ParsedAction['approval'],
    executionAttemptId: expectedAttempt,
  })
}

function parseReconciliation(
  value: unknown,
  request: FeishuReplyExecutionRequest,
  proposalCreatedAt: IsoTimestamp,
  observedAt: IsoTimestamp,
): ReconciliationResult {
  const record = dataRecord(value, 'The Feishu reply reconciliation response is invalid.')
  if (record.status !== 'absent' && record.status !== 'found') {
    throw fail('invalid_response', 'The Feishu reply reconciliation response is invalid.')
  }
  exactKeys(
    record,
    record.status === 'found'
      ? [
          'status',
          'accountId',
          'identityType',
          'idempotencyKey',
          'targetMessageId',
          'messageId',
          'sentAt',
        ]
      : ['status', 'accountId', 'identityType', 'idempotencyKey', 'targetMessageId'],
  )
  if (
    record.accountId !== request.accountId ||
    record.identityType !== request.identityType ||
    record.idempotencyKey !== request.idempotencyKey ||
    record.targetMessageId !== request.targetMessageId
  ) {
    throw fail('identity_mismatch', 'The Feishu reply reconciliation identity does not match.')
  }
  const identity = {
    accountId: request.accountId,
    identityType: request.identityType,
    idempotencyKey: request.idempotencyKey,
    targetMessageId: request.targetMessageId,
  }
  if (record.status === 'absent') return Object.freeze({ ...identity, status: 'absent' })
  let sentAt: IsoTimestamp
  try {
    sentAt = parseIsoTimestamp(record.sentAt)
  } catch {
    throw fail('invalid_response', 'The Feishu reply reconciliation response is invalid.')
  }
  if (
    Date.parse(sentAt) < Date.parse(proposalCreatedAt) ||
    Date.parse(sentAt) > Date.parse(observedAt) + MAX_REMOTE_CLOCK_SKEW_MS
  ) {
    throw fail('invalid_response', 'The Feishu reply reconciliation chronology is invalid.')
  }
  return Object.freeze({
    ...identity,
    status: 'found',
    messageId: boundedString(record.messageId),
    sentAt,
  })
}

function successReceipt(
  action: ParsedAction,
  result: Extract<ReconciliationResult, { readonly status: 'found' }>,
  attemptedAt: IsoTimestamp,
): ActionReceipt {
  return Object.freeze({
    proposalId: action.proposal.id,
    connectorId: 'feishu',
    accountId: action.proposal.identity.accountId,
    idempotencyKey: action.proposal.idempotencyKey,
    outcome: 'succeeded',
    attemptedAt,
    externalReference: Object.freeze({
      connectorId: 'feishu',
      accountId: action.proposal.identity.accountId,
      objectType: 'message',
      externalId: result.messageId,
      sourceTimestamp: result.sentAt,
    }),
  })
}

function issueReceipt(
  action: ParsedAction,
  attemptedAt: IsoTimestamp,
  outcome: 'failed' | 'uncertain',
  code: string,
  message: string,
  retryable: boolean,
  retryDisposition: 'do_not_retry' | 'retry_same_key' | 'reconcile_first',
): ActionReceipt {
  const base = {
    proposalId: action.proposal.id,
    connectorId: 'feishu',
    accountId: action.proposal.identity.accountId,
    idempotencyKey: action.proposal.idempotencyKey,
    attemptedAt,
    error: Object.freeze({ code, message, retryable }),
  }
  return outcome === 'uncertain'
    ? Object.freeze({ ...base, outcome, retryDisposition: 'reconcile_first' })
    : (Object.freeze({ ...base, outcome, retryDisposition }) as ActionReceipt)
}

function clientIssue(
  action: ParsedAction,
  attemptedAt: IsoTimestamp,
  error: unknown,
  phase: 'reconcile' | 'send',
): ActionReceipt {
  const code = error instanceof FeishuReplyExecutionClientError ? error.code : 'unknown'
  if (phase === 'reconcile') {
    return issueReceipt(
      action,
      attemptedAt,
      'uncertain',
      `feishu_reconciliation_${code}`,
      'The prior Feishu reply result could not be determined.',
      true,
      'reconcile_first',
    )
  }
  if (code === 'rate_limited') {
    return issueReceipt(
      action,
      attemptedAt,
      'failed',
      'feishu_rate_limited',
      'Feishu did not accept the reply before its rate-limit window.',
      true,
      'retry_same_key',
    )
  }
  if (code === 'network' || code === 'unknown') {
    return issueReceipt(
      action,
      attemptedAt,
      'uncertain',
      `feishu_send_${code}`,
      'The Feishu reply result could not be determined.',
      true,
      'reconcile_first',
    )
  }
  return issueReceipt(
    action,
    attemptedAt,
    'failed',
    `feishu_send_${code}`,
    'Feishu rejected the reply before a successful result was confirmed.',
    false,
    'do_not_retry',
  )
}

export class FeishuReplyExecutor {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #client: FeishuReplyExecutionClient
  readonly #now: () => number

  constructor(
    configuration: unknown,
    client: FeishuReplyExecutionClient,
    options: FeishuReplyExecutorOptions = {},
  ) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    this.#client = client
    this.#now = options.now ?? Date.now
  }

  async execute(actionValue: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt> {
    signal.throwIfAborted()
    const action = parseAction(actionValue, this.#configuration)
    const attemptedAt = this.#observedAt()
    if (
      Date.parse(attemptedAt) < Date.parse(action.approval.decidedAt as IsoTimestamp) ||
      Date.parse(attemptedAt) > Date.parse(action.approval.expiresAt)
    ) {
      throw fail('approval_expired', 'The Feishu reply approval is outside its valid lifetime.')
    }
    const request = this.#request(action)
    let reconciliation: ReconciliationResult
    try {
      reconciliation = parseReconciliation(
        await this.#client.reconcile(request, signal),
        request,
        action.proposal.createdAt,
        attemptedAt,
      )
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'reconcile')
    }
    signal.throwIfAborted()
    if (reconciliation.status === 'found') {
      return successReceipt(action, reconciliation, attemptedAt)
    }
    try {
      const sent = parseReconciliation(
        await this.#client.send(request, signal),
        request,
        action.proposal.createdAt,
        attemptedAt,
      )
      if (sent.status !== 'found') {
        throw fail('invalid_response', 'The Feishu reply send response is invalid.')
      }
      return successReceipt(action, sent, attemptedAt)
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'send')
    }
  }

  async reconcile(actionValue: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt> {
    signal.throwIfAborted()
    const action = parseAction(actionValue, this.#configuration)
    const attemptedAt = this.#observedAt()
    const request = this.#request(action)
    try {
      const result = parseReconciliation(
        await this.#client.reconcile(request, signal),
        request,
        action.proposal.createdAt,
        attemptedAt,
      )
      signal.throwIfAborted()
      return result.status === 'found'
        ? successReceipt(action, result, attemptedAt)
        : issueReceipt(
            action,
            attemptedAt,
            'uncertain',
            'feishu_reconciliation_absent',
            'No Feishu reply exists for the execution key.',
            false,
            'reconcile_first',
          )
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'reconcile')
    }
  }

  #observedAt(): IsoTimestamp {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw fail('invalid_action', 'The Feishu reply execution clock is invalid.')
    }
    return parseIsoTimestamp(new Date(now).toISOString())
  }

  #request(action: ParsedAction): FeishuReplyExecutionRequest {
    const identity = this.#configuration[action.proposal.identity.identityType]
    if (identity === undefined) {
      throw fail('identity_mismatch', 'The approved Feishu identity is no longer configured.')
    }
    return Object.freeze({
      kind: 'feishu_reply_execution_request',
      schemaVersion: FEISHU_REPLY_EXECUTION_VERSION,
      accountId: this.#configuration.accountId,
      appId: this.#configuration.appId,
      identityType: identity.identityType,
      principalId: identity.principalId,
      credentialReference: identity.credentialReference,
      targetMessageId: action.proposal.target.externalId,
      content: action.proposal.content.text,
      idempotencyKey: action.proposal.idempotencyKey,
    })
  }
}
