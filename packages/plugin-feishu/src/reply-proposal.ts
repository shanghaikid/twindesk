import { createHash, randomUUID } from 'node:crypto'

import {
  parseActionProposal,
  parseContentDigest,
  parseIsoTimestamp,
  type ActionIdentity,
  type ActionProposal,
  type ConnectorActionRequest,
  type DraftContent,
  type ExternalReference,
} from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  toFeishuActionIdentity,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_REPLY_PROPOSAL_VERSION = 1 as const
export const FEISHU_REPLY_ACTION_TYPE = 'feishu.reply' as const

const MAX_REPLY_TEXT_CHARACTERS = 20_000
const MAX_REPLY_TEXT_BYTES = 64 * 1024

type UnknownRecord = Readonly<Record<string, unknown>>

export type FeishuReplyProposalErrorCode =
  'invalid_request' | 'identity_mismatch' | 'identity_not_configured' | 'unsupported_action'

export class FeishuReplyProposalError extends Error {
  readonly code: FeishuReplyProposalErrorCode

  constructor(code: FeishuReplyProposalErrorCode, message: string) {
    super(message)
    this.name = 'FeishuReplyProposalError'
    this.code = code
  }
}

export interface FeishuReplyProposerOptions {
  readonly now?: () => number
  readonly createNonce?: () => string
}

function fail(code: FeishuReplyProposalErrorCode, message: string): FeishuReplyProposalError {
  return new FeishuReplyProposalError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail('invalid_request', 'The Feishu reply proposal request must be an object.')
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail('invalid_request', 'The Feishu reply proposal request must be plain data.')
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw fail('invalid_request', 'The Feishu reply proposal request has unsupported fields.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
      throw fail('invalid_request', 'The Feishu reply proposal request must contain data values.')
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof FeishuReplyProposalError) throw error
    throw fail('invalid_request', 'The Feishu reply proposal request is invalid.')
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
    throw fail(
      'invalid_request',
      'The Feishu reply proposal request has missing or unsupported fields.',
    )
  }
}

function boundedIdentifier(value: unknown, message: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_request', message)
  }
  return value
}

function parseIdentity(value: unknown, configuration: FeishuIdentityConfiguration): ActionIdentity {
  const record = dataRecord(value)
  exactKeys(record, ['connectorId', 'accountId', 'identityType', 'displayName'])
  if (record.identityType !== 'bot' && record.identityType !== 'user') {
    throw fail('invalid_request', 'The Feishu reply identity type is invalid.')
  }
  if (configuration[record.identityType] === undefined) {
    throw fail('identity_not_configured', 'The requested Feishu reply identity is not configured.')
  }
  const configured = toFeishuActionIdentity(configuration, record.identityType)
  if (
    record.connectorId !== configured.connectorId ||
    record.accountId !== configured.accountId ||
    record.displayName !== configured.displayName
  ) {
    throw fail('identity_mismatch', 'The Feishu reply identity does not match the connection.')
  }
  return configured
}

function parseTarget(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
): ExternalReference {
  const record = dataRecord(value)
  exactKeys(record, ['connectorId', 'accountId', 'objectType', 'externalId', 'sourceTimestamp'])
  if (
    record.connectorId !== 'feishu' ||
    record.accountId !== configuration.accountId ||
    record.objectType !== 'message'
  ) {
    throw fail('identity_mismatch', 'The Feishu reply target does not match the connection.')
  }
  let sourceTimestamp: ReturnType<typeof parseIsoTimestamp>
  try {
    sourceTimestamp = parseIsoTimestamp(record.sourceTimestamp)
  } catch {
    throw fail('invalid_request', 'The Feishu reply target timestamp is invalid.')
  }
  return Object.freeze({
    connectorId: 'feishu',
    accountId: configuration.accountId,
    objectType: 'message',
    externalId: boundedIdentifier(
      record.externalId,
      'The Feishu reply target identity is invalid.',
    ),
    sourceTimestamp,
  })
}

function parseContent(value: unknown): DraftContent {
  const record = dataRecord(value)
  exactKeys(record, ['mediaType', 'text'])
  if (record.mediaType !== 'text/plain') {
    throw fail('unsupported_action', 'The Feishu reply preview supports plain text only.')
  }
  if (
    typeof record.text !== 'string' ||
    record.text.trim().length === 0 ||
    record.text.length > MAX_REPLY_TEXT_CHARACTERS ||
    Buffer.byteLength(record.text, 'utf8') > MAX_REPLY_TEXT_BYTES ||
    record.text.includes('\u0000')
  ) {
    throw fail('invalid_request', 'The Feishu reply content is invalid.')
  }
  return Object.freeze({ mediaType: 'text/plain', text: record.text })
}

function parseRequest(
  value: ConnectorActionRequest,
  configuration: FeishuIdentityConfiguration,
): Readonly<{
  workItemId: ConnectorActionRequest['workItemId']
  draftId: NonNullable<ConnectorActionRequest['draftId']>
  identity: ActionIdentity
  target: ExternalReference
  content: DraftContent
}> {
  const record = dataRecord(value)
  exactKeys(record, ['workItemId', 'draftId', 'actionType', 'identity', 'target', 'content'])
  if (record.actionType !== FEISHU_REPLY_ACTION_TYPE) {
    throw fail('unsupported_action', 'The Feishu reply action type is not supported.')
  }
  const workItemId = boundedIdentifier(
    record.workItemId,
    'The Feishu reply Work Item identity is invalid.',
  ) as ConnectorActionRequest['workItemId']
  const draftId = boundedIdentifier(
    record.draftId,
    'The Feishu reply Draft identity is invalid.',
  ) as NonNullable<ConnectorActionRequest['draftId']>
  return Object.freeze({
    workItemId,
    draftId,
    identity: parseIdentity(record.identity, configuration),
    target: parseTarget(record.target, configuration),
    content: parseContent(record.content),
  })
}

function contentDigest(content: DraftContent): ActionProposal['contentDigest'] {
  const canonical = JSON.stringify({ mediaType: content.mediaType, text: content.text })
  return parseContentDigest(
    `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  )
}

function proposalNonce(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw fail('invalid_request', 'The Feishu reply proposal identity is invalid.')
  }
  return value
}

export function computeFeishuReplyIdentityFingerprint(
  configuration: FeishuIdentityConfiguration,
  identityType: 'bot' | 'user',
  proposalDigest: string,
): string {
  const identity = configuration[identityType]
  if (identity === undefined || !/^[a-f0-9]{64}$/u.test(proposalDigest)) {
    throw fail('identity_mismatch', 'The Feishu reply identity binding is invalid.')
  }
  return createHash('sha256')
    .update(proposalDigest)
    .update('\u0000')
    .update(
      JSON.stringify({
        connectorId: configuration.connectorId,
        accountId: configuration.accountId,
        appId: configuration.appId,
        identityType: identity.identityType,
        principalId: identity.principalId,
        credentialReference: identity.credentialReference,
      }),
      'utf8',
    )
    .digest('hex')
}

export class FeishuReplyProposer {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #now: () => number
  readonly #createNonce: () => string

  constructor(configuration: unknown, options: FeishuReplyProposerOptions = {}) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    this.#now = options.now ?? Date.now
    this.#createNonce = options.createNonce ?? randomUUID
  }

  async propose(
    requestValue: ConnectorActionRequest,
    signal: AbortSignal,
  ): Promise<ActionProposal> {
    signal.throwIfAborted()
    const request = parseRequest(requestValue, this.#configuration)
    const clock = this.#now()
    if (!Number.isSafeInteger(clock) || clock < 0) {
      throw fail('invalid_request', 'The Feishu reply proposal clock is invalid.')
    }
    const createdAt = parseIsoTimestamp(new Date(clock).toISOString())
    const nonce = proposalNonce(this.#createNonce())
    const digest = createHash('sha256')
      .update(this.#configuration.accountId)
      .update('\u0000')
      .update(nonce)
      .digest('hex')
    const identityFingerprint = computeFeishuReplyIdentityFingerprint(
      this.#configuration,
      request.identity.identityType,
      digest,
    )
    return parseActionProposal({
      kind: 'action_proposal',
      schemaVersion: FEISHU_REPLY_PROPOSAL_VERSION,
      id: `proposal-feishu-reply-${digest.slice(0, 32)}`,
      workItemId: request.workItemId,
      draftId: request.draftId,
      actionType: FEISHU_REPLY_ACTION_TYPE,
      risk: 'write',
      identity: request.identity,
      target: request.target,
      content: request.content,
      contentDigest: contentDigest(request.content),
      idempotencyKey: `feishu:reply:${digest}:identity:${identityFingerprint}:v1`,
      state: 'proposed',
      createdAt,
      updatedAt: createdAt,
    })
  }
}
