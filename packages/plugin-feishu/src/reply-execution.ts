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
const COMPACT_IDEMPOTENCY_KEY_PATTERN = /^tdfr1:([a-f0-9]{40})$/u
const COMPACT_PROPOSAL_ID_PATTERN = /^proposal-feishu-reply-([a-f0-9]{32})$/u

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
  | 'preflight_unavailable'
  | 'credential_reauthorization_required'
  | 'credential_rotation_uncertain'
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
      'preflight_unavailable',
      'credential_reauthorization_required',
      'credential_rotation_uncertain',
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
  /** Complete credential maintenance that must precede durable reply dispatch. */
  prepare?(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<void>
  /** Look up the exact idempotency key when the remote system exposes it. */
  reconcile?(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown>
  /** Resolve the credential reference, recheck scopes, and send with the exact key. */
  send(request: FeishuReplyExecutionRequest, signal: AbortSignal): Promise<unknown>
}

type FeishuReplyReconciliationMethod = NonNullable<FeishuReplyExecutionClient['reconcile']>
type FeishuReplyPreparationMethod = NonNullable<FeishuReplyExecutionClient['prepare']>

export interface FeishuReplyExecutorOptions {
  readonly now?: () => number
  /** Must durably reserve this exact attempt before a client may send it. */
  readonly reserveDispatch?: (
    action: ApprovedAction,
    reservedAt: IsoTimestamp,
    signal: AbortSignal,
  ) => Promise<'reserved' | 'blocked'>
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

function hasValidIdentityBoundIdempotencyKey(
  proposal: ActionProposal,
  configuration: FeishuIdentityConfiguration,
): boolean {
  const compactKey = COMPACT_IDEMPOTENCY_KEY_PATTERN.exec(proposal.idempotencyKey)
  const compactProposal = COMPACT_PROPOSAL_ID_PATTERN.exec(proposal.id)
  return (
    compactKey !== null &&
    compactProposal !== null &&
    compactKey[1] ===
      computeFeishuReplyIdentityFingerprint(
        configuration,
        proposal.identity.identityType,
        compactProposal[1] as string,
      ).slice(0, 40)
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
  if (
    proposal.identity.connectorId !== configuredIdentity.connectorId ||
    proposal.identity.accountId !== configuredIdentity.accountId ||
    proposal.identity.displayName !== configuredIdentity.displayName ||
    proposal.target.connectorId !== 'feishu' ||
    proposal.target.accountId !== configuration.accountId ||
    proposal.target.objectType !== 'message' ||
    proposal.target.sourceTimestamp === undefined ||
    proposal.content.mediaType !== 'text/plain' ||
    !hasValidIdentityBoundIdempotencyKey(proposal, configuration)
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
  exactReconciliationAvailable = true,
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
  if (code === 'preflight_unavailable') {
    return issueReceipt(
      action,
      attemptedAt,
      'failed',
      'feishu_preflight_unavailable',
      'The Feishu reply was not attempted because its preflight checks did not complete.',
      true,
      'retry_same_key',
    )
  }
  if (code === 'credential_reauthorization_required') {
    return issueReceipt(
      action,
      attemptedAt,
      'failed',
      'feishu_credential_reauthorization_required',
      'The Feishu reply was not attempted because the User authorization must be renewed.',
      false,
      'do_not_retry',
    )
  }
  if (code === 'credential_rotation_uncertain') {
    return issueReceipt(
      action,
      attemptedAt,
      'failed',
      'feishu_credential_rotation_uncertain',
      'The Feishu reply was not attempted because credential rotation requires reconciliation.',
      false,
      'do_not_retry',
    )
  }
  if (code === 'network' || code === 'unknown') {
    return issueReceipt(
      action,
      attemptedAt,
      'uncertain',
      `feishu_send_${code}`,
      'The Feishu reply result could not be determined.',
      exactReconciliationAvailable,
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

function optionalClientMethod<Method extends (...args: never[]) => unknown>(
  client: FeishuReplyExecutionClient,
  name: 'prepare' | 'reconcile',
): Method | undefined {
  try {
    let owner: object | null = client
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return descriptor.value as Method
      }
      owner = Object.getPrototypeOf(owner)
    }
    return undefined
  } catch {
    throw new FeishuReplyExecutionClientError('invalid_response')
  }
}

function reconciliationMethod(
  client: FeishuReplyExecutionClient,
): FeishuReplyReconciliationMethod | undefined {
  return optionalClientMethod<FeishuReplyReconciliationMethod>(client, 'reconcile')
}

function preparationMethod(
  client: FeishuReplyExecutionClient,
): FeishuReplyPreparationMethod | undefined {
  return optionalClientMethod<FeishuReplyPreparationMethod>(client, 'prepare')
}

export class FeishuReplyExecutor {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #client: FeishuReplyExecutionClient
  readonly #now: () => number
  readonly #reserveDispatch: FeishuReplyExecutorOptions['reserveDispatch']

  constructor(
    configuration: unknown,
    client: FeishuReplyExecutionClient,
    options: FeishuReplyExecutorOptions = {},
  ) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    this.#client = client
    this.#now = options.now ?? Date.now
    this.#reserveDispatch = options.reserveDispatch
  }

  async execute(actionValue: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt> {
    signal.throwIfAborted()
    const action = parseAction(actionValue, this.#configuration)
    const normalizedAction = Object.freeze({
      proposal: action.proposal,
      approval: action.approval,
      executionAttemptId: action.executionAttemptId,
    }) as ApprovedAction
    const attemptedAt = this.#observedAt()
    if (
      Date.parse(attemptedAt) < Date.parse(action.approval.decidedAt as IsoTimestamp) ||
      Date.parse(attemptedAt) > Date.parse(action.approval.expiresAt)
    ) {
      throw fail('approval_expired', 'The Feishu reply approval is outside its valid lifetime.')
    }
    const request = this.#request(action)
    let reconcile: FeishuReplyReconciliationMethod | undefined
    try {
      reconcile = reconciliationMethod(this.#client)
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'reconcile')
    }
    signal.throwIfAborted()
    const exactReconciliationAvailable = reconcile !== undefined
    if (reconcile !== undefined) {
      let reconciliation: ReconciliationResult
      try {
        reconciliation = parseReconciliation(
          await reconcile.call(this.#client, request, signal),
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
    }
    let prepare: FeishuReplyPreparationMethod | undefined
    try {
      prepare = preparationMethod(this.#client)
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'send', exactReconciliationAvailable)
    }
    if (prepare !== undefined) {
      try {
        await prepare.call(this.#client, request, signal)
      } catch (error) {
        signal.throwIfAborted()
        return clientIssue(action, attemptedAt, error, 'send', exactReconciliationAvailable)
      }
      signal.throwIfAborted()
    }
    try {
      if (this.#reserveDispatch === undefined) {
        return issueReceipt(
          action,
          attemptedAt,
          'uncertain',
          'feishu_dispatch_unavailable',
          'A durable dispatch reservation is required before sending.',
          true,
          'reconcile_first',
        )
      }
      const disposition: unknown = await this.#reserveDispatch(
        normalizedAction,
        attemptedAt,
        signal,
      )
      signal.throwIfAborted()
      if (disposition === 'blocked') {
        return issueReceipt(
          action,
          attemptedAt,
          'uncertain',
          'feishu_dispatch_already_reserved',
          'A prior Feishu reply dispatch may already have occurred.',
          exactReconciliationAvailable,
          'reconcile_first',
        )
      }
      if (disposition !== 'reserved') {
        return issueReceipt(
          action,
          attemptedAt,
          'uncertain',
          'feishu_dispatch_unavailable',
          'The durable dispatch reservation response is invalid.',
          true,
          'reconcile_first',
        )
      }
    } catch {
      signal.throwIfAborted()
      return issueReceipt(
        action,
        attemptedAt,
        'uncertain',
        'feishu_dispatch_unavailable',
        'The durable dispatch reservation could not be confirmed.',
        true,
        'reconcile_first',
      )
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
      return clientIssue(action, attemptedAt, error, 'send', exactReconciliationAvailable)
    }
  }

  async reconcile(actionValue: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt> {
    signal.throwIfAborted()
    const action = parseAction(actionValue, this.#configuration)
    const attemptedAt = this.#observedAt()
    const request = this.#request(action)
    let reconcile: FeishuReplyReconciliationMethod | undefined
    try {
      reconcile = reconciliationMethod(this.#client)
    } catch (error) {
      signal.throwIfAborted()
      return clientIssue(action, attemptedAt, error, 'reconcile')
    }
    signal.throwIfAborted()
    if (reconcile === undefined) {
      return issueReceipt(
        action,
        attemptedAt,
        'uncertain',
        'feishu_reconciliation_unsupported',
        'Feishu cannot determine the prior reply from the exact execution key.',
        false,
        'reconcile_first',
      )
    }
    try {
      const result = parseReconciliation(
        await reconcile.call(this.#client, request, signal),
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
