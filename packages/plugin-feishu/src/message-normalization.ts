import { createHash } from 'node:crypto'

import {
  parseExternalEvent,
  parseExternalThread,
  parseIsoTimestamp,
  parseWorkItem,
  type ConnectorCursor,
  type ExternalEvent,
  type ExternalReference,
  type ExternalThread,
  type IsoTimestamp,
  type JsonValue,
  type WorkItem,
} from '@twindesk/domain'

import type { FeishuBotMessageEvent } from './bot-event-consumer.ts'
import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import type {
  FeishuDiscoveredUserMessage,
  FeishuUserDiscoveryIssue,
  FeishuUserMessageDiscoveryBatch,
} from './user-message-discovery.ts'

export const FEISHU_MESSAGE_NORMALIZATION_VERSION = 1 as const
export const FEISHU_BOT_MESSAGE_STREAM = 'bot_message_events' as const

const PARTIAL_CONTEXT = Object.freeze({
  status: 'partial' as const,
  missing: Object.freeze([
    'conversation context not retrieved',
    'document context not retrieved',
    'attachment context not retrieved',
  ]),
})

export type FeishuMessageNormalizationErrorCode =
  'invalid_request' | 'identity_mismatch' | 'projection_conflict'

export class FeishuMessageNormalizationError extends Error {
  readonly code: FeishuMessageNormalizationErrorCode

  constructor(code: FeishuMessageNormalizationErrorCode, message: string) {
    super(message)
    this.name = 'FeishuMessageNormalizationError'
    this.code = code
  }
}

export interface FeishuProjectionReader {
  getThread(id: string): ExternalThread | undefined
  getWorkItem(id: WorkItem['id']): WorkItem | undefined
}

export interface FeishuWorkItemProjection {
  readonly thread: ExternalThread
  readonly workItem: WorkItem
}

export interface FeishuNormalizedMessageBatch {
  readonly connectorId: 'feishu'
  readonly accountId: string
  readonly stream: typeof FEISHU_BOT_MESSAGE_STREAM | 'user_visible_messages'
  readonly events: readonly ExternalEvent[]
  readonly projections: readonly FeishuWorkItemProjection[]
  readonly candidateCursor?: ConnectorCursor
  readonly hasMore: boolean
  readonly observedAt: string
  readonly issues: readonly FeishuUserDiscoveryIssue[]
}

interface MessageInput {
  readonly accountId: string
  readonly appId: string
  readonly tenantKey: string
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly messageType: string
  readonly effectiveTime: string
  readonly receivedAt: string
  readonly eventType: 'message.received' | 'message.updated' | 'message.deleted'
  readonly content: JsonValue
  readonly mentions: readonly Readonly<{ key: string; principalId: string }>[]
  readonly threadId?: string
}

interface NormalizedMessage {
  readonly event: ExternalEvent
  readonly conversationReference: ExternalReference
  readonly localThreadId: string
  readonly localWorkItemId: string
  readonly requiresReply: boolean
  readonly deleted: boolean
  readonly summary: string
}

function fail(
  code: FeishuMessageNormalizationErrorCode,
  message: string,
): FeishuMessageNormalizationError {
  return new FeishuMessageNormalizationError(code, message)
}

function stableDigest(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\u0000')
  return hash.digest('hex').slice(0, 32)
}

function epochInstant(value: string): IsoTimestamp {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    throw fail('invalid_request', 'A Feishu message source timestamp is invalid.')
  }
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw fail('invalid_request', 'A Feishu message source timestamp is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(milliseconds).toISOString())
  } catch {
    throw fail('invalid_request', 'A Feishu message source timestamp is invalid.')
  }
}

function observedInstant(value: unknown): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_request', 'The Feishu normalization observation time is invalid.')
  }
}

function messageSummary(content: JsonValue, messageType: string): string {
  let text: string | undefined
  if (typeof content === 'string') text = content
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const record = content as Readonly<Record<string, JsonValue>>
    if (typeof record.text === 'string') text = record.text
  }
  const compact = text?.replace(/\s+/gu, ' ').trim()
  if (compact === undefined || compact.length === 0) return `Feishu ${messageType} message.`
  return compact.length <= 280 ? compact : `${compact.slice(0, 277)}...`
}

function sortedMentions(
  mentions: readonly Readonly<{ key: string; principalId: string }>[],
): readonly Readonly<{ key: string; principalId: string }>[] {
  return Object.freeze(
    mentions
      .map((mention) => Object.freeze({ key: mention.key, principalId: mention.principalId }))
      .toSorted((left, right) => {
        const leftKey = `${left.key}\u0000${left.principalId}`
        const rightKey = `${right.key}\u0000${right.principalId}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      }),
  )
}

function normalizeMessage(
  input: MessageInput,
  configuration: FeishuIdentityConfiguration,
): NormalizedMessage {
  if (
    input.accountId !== configuration.accountId ||
    input.appId !== configuration.appId ||
    input.tenantKey.length === 0
  ) {
    throw fail('identity_mismatch', 'The Feishu message identity does not match the connection.')
  }
  const occurredAt = epochInstant(input.effectiveTime)
  const receivedAt = observedInstant(input.receivedAt)
  if (Date.parse(receivedAt) < Date.parse(occurredAt)) {
    throw fail('invalid_request', 'A Feishu message was observed before its source timestamp.')
  }
  const mentions = sortedMentions(input.mentions)
  const configuredPrincipals = new Set(
    [configuration.bot?.principalId, configuration.user?.principalId].filter(
      (principal): principal is string => principal !== undefined,
    ),
  )
  const requiresReply =
    input.chatType === 'p2p' ||
    mentions.some((mention) => configuredPrincipals.has(mention.principalId))
  const stateKey = `${input.eventType}:${occurredAt}`
  const eventDigest = stableDigest(input.accountId, input.messageId, stateKey)
  const event = parseExternalEvent({
    kind: 'external_event',
    schemaVersion: FEISHU_MESSAGE_NORMALIZATION_VERSION,
    id: `event-feishu-message-${eventDigest}`,
    idempotencyKey: `feishu:message:${eventDigest}`,
    source: {
      connectorId: 'feishu',
      accountId: input.accountId,
      objectType: 'message',
      externalId: input.messageId,
      sourceTimestamp: occurredAt,
    },
    eventType: input.eventType,
    occurredAt,
    receivedAt,
    context: PARTIAL_CONTEXT,
    normalized: {
      schemaVersion: FEISHU_MESSAGE_NORMALIZATION_VERSION,
      resource: 'feishu_message',
      chatId: input.chatId,
      chatType: input.chatType,
      messageType: input.messageType,
      content: input.content,
      mentions,
      requiresReply,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    },
  })
  const conversationExternalId = input.threadId ?? input.chatId
  const conversationObjectType = input.threadId === undefined ? 'chat' : 'thread'
  const projectionDigest = stableDigest(
    input.accountId,
    conversationObjectType,
    conversationExternalId,
  )
  return Object.freeze({
    event,
    conversationReference: Object.freeze({
      connectorId: 'feishu',
      accountId: input.accountId,
      objectType: conversationObjectType,
      externalId: conversationExternalId,
      sourceTimestamp: occurredAt,
    }),
    localThreadId: `thread-feishu-${projectionDigest}`,
    localWorkItemId: `work-item-feishu-${projectionDigest}`,
    requiresReply,
    deleted: input.eventType === 'message.deleted',
    summary: messageSummary(input.content, input.messageType),
  })
}

function referenceIdentity(reference: ExternalReference): string {
  return `${reference.connectorId}\u0000${reference.accountId}\u0000${reference.objectType}\u0000${reference.externalId}`
}

function mergeReferences(
  existing: readonly ExternalReference[],
  additions: readonly ExternalReference[],
): readonly ExternalReference[] {
  const result = existing.map((reference) => ({ ...reference }))
  const indexes = new Map(result.map((reference, index) => [referenceIdentity(reference), index]))
  for (const addition of additions) {
    const key = referenceIdentity(addition)
    const index = indexes.get(key)
    if (index === undefined) {
      indexes.set(key, result.length)
      result.push({ ...addition })
      continue
    }
    const current = result[index] as ExternalReference
    if (
      addition.sourceTimestamp !== undefined &&
      (current.sourceTimestamp === undefined ||
        Date.parse(addition.sourceTimestamp) > Date.parse(current.sourceTimestamp))
    ) {
      result[index] = { ...current, sourceTimestamp: addition.sourceTimestamp }
    }
  }
  return Object.freeze(result.map((reference) => Object.freeze(reference)))
}

function projectionGroups(
  messages: readonly NormalizedMessage[],
  reader: FeishuProjectionReader,
): readonly FeishuWorkItemProjection[] {
  const groups = new Map<string, NormalizedMessage[]>()
  for (const message of messages) {
    const group = groups.get(message.localWorkItemId)
    if (group === undefined) groups.set(message.localWorkItemId, [message])
    else group.push(message)
  }
  const projections: FeishuWorkItemProjection[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (first === undefined) continue
    const existingThread = reader.getThread(first.localThreadId)
    const existingWorkItem = reader.getWorkItem(first.localWorkItemId as WorkItem['id'])
    if (
      (existingThread === undefined) !== (existingWorkItem === undefined) ||
      (existingWorkItem !== undefined && existingWorkItem.threadId !== first.localThreadId)
    ) {
      throw fail('projection_conflict', 'The durable Feishu projection is inconsistent.')
    }
    const existingEventIds = new Set(existingThread?.sourceEventIds ?? [])
    const additions = group
      .filter((message) => !existingEventIds.has(message.event.id))
      .toSorted((left, right) => {
        const chronology = Date.parse(left.event.occurredAt) - Date.parse(right.event.occurredAt)
        return chronology === 0 ? left.event.id.localeCompare(right.event.id) : chronology
      })
    if (additions.length === 0) continue
    const latest = additions.toSorted((left, right) => {
      const chronology = Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt)
      return chronology === 0 ? left.event.id.localeCompare(right.event.id) : chronology
    })[0] as NormalizedMessage
    const sourceEventIds = Object.freeze([
      ...(existingThread?.sourceEventIds ?? []),
      ...additions.map((message) => message.event.id),
    ])
    const references = mergeReferences(
      existingThread?.externalReferences ?? [],
      additions.flatMap((message) => [message.conversationReference, message.event.source]),
    )
    const createdAt =
      existingThread?.createdAt ??
      additions.reduce(
        (earliest, message) =>
          Date.parse(message.event.occurredAt) < Date.parse(earliest)
            ? message.event.occurredAt
            : earliest,
        first.event.occurredAt,
      )
    const updatedAt = additions.reduce(
      (latestTime, message) =>
        Date.parse(message.event.receivedAt) > Date.parse(latestTime)
          ? message.event.receivedAt
          : latestTime,
      existingThread?.updatedAt ?? createdAt,
    )
    const latestDurableSourceTime = (existingThread?.externalReferences ?? []).reduce(
      (latestTime, reference) =>
        reference.objectType === 'message' &&
        reference.sourceTimestamp !== undefined &&
        (latestTime === undefined || Date.parse(reference.sourceTimestamp) > Date.parse(latestTime))
          ? reference.sourceTimestamp
          : latestTime,
      undefined as string | undefined,
    )
    const advancesPresentation =
      existingWorkItem === undefined ||
      latestDurableSourceTime === undefined ||
      Date.parse(latest.event.occurredAt) >= Date.parse(latestDurableSourceTime)
    const inboxState = advancesPresentation
      ? latest.deleted
        ? 'done'
        : latest.requiresReply
          ? 'needs_reply'
          : 'needs_review'
      : existingWorkItem.inboxState
    const title = advancesPresentation
      ? latest.deleted
        ? 'Feishu message deleted'
        : latest.requiresReply
          ? 'Reply to a Feishu message'
          : 'Review a Feishu group message'
      : existingWorkItem.title
    const summary = advancesPresentation ? latest.summary : existingWorkItem.summary
    const attentionReason = advancesPresentation
      ? latest.deleted
        ? 'The source message was deleted.'
        : latest.requiresReply
          ? 'A direct message or explicit mention is waiting for attention.'
          : 'A newly discovered group message may require review.'
      : existingWorkItem.attentionReason
    const thread = parseExternalThread({
      kind: 'external_thread',
      schemaVersion: FEISHU_MESSAGE_NORMALIZATION_VERSION,
      id: first.localThreadId,
      subject:
        existingThread?.subject ??
        (first.event.normalized.chatType === 'p2p'
          ? 'Feishu direct conversation'
          : 'Feishu group conversation'),
      externalReferences: references,
      sourceEventIds,
      createdAt,
      updatedAt,
    })
    const workItem = parseWorkItem({
      kind: 'work_item',
      schemaVersion: FEISHU_MESSAGE_NORMALIZATION_VERSION,
      id: first.localWorkItemId,
      threadId: thread.id,
      sourceEventIds,
      inboxState,
      title,
      summary,
      attentionReason,
      ...(existingWorkItem?.selectedPersonaId === undefined
        ? {}
        : { selectedPersonaId: existingWorkItem.selectedPersonaId }),
      createdAt: existingWorkItem?.createdAt ?? createdAt,
      updatedAt,
    })
    projections.push(Object.freeze({ thread, workItem }))
  }
  return Object.freeze(projections)
}

function emptyIssues(): readonly FeishuUserDiscoveryIssue[] {
  return Object.freeze([])
}

export class FeishuMessageNormalizer {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #tenantKey: string

  constructor(configuration: unknown, tenantKey: string) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    if (
      typeof tenantKey !== 'string' ||
      tenantKey.length === 0 ||
      tenantKey.trim() !== tenantKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(tenantKey)
    ) {
      throw fail('invalid_request', 'The Feishu normalization tenant identity is invalid.')
    }
    this.#tenantKey = tenantKey
  }

  normalizeBotMessage(
    event: FeishuBotMessageEvent,
    observedAtValue: unknown,
    reader: FeishuProjectionReader,
  ): FeishuNormalizedMessageBatch {
    const bot = this.#configuration.bot
    if (
      bot === undefined ||
      event.kind !== 'feishu_bot_message_event' ||
      event.schemaVersion !== 1 ||
      event.accountId !== this.#configuration.accountId ||
      event.appId !== this.#configuration.appId ||
      event.tenantKey !== this.#tenantKey ||
      event.botPrincipalId !== bot.principalId
    ) {
      throw fail('identity_mismatch', 'The Feishu Bot message identity does not match.')
    }
    const observedAt = observedInstant(observedAtValue)
    const normalized = normalizeMessage(
      {
        accountId: event.accountId,
        appId: event.appId,
        tenantKey: event.tenantKey,
        messageId: event.messageId,
        chatId: event.chatId,
        chatType: event.chatType,
        messageType: event.messageType,
        effectiveTime: event.sourceCreateTime,
        receivedAt: observedAt,
        eventType: 'message.received',
        content: event.content,
        mentions: event.mentions,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      },
      this.#configuration,
    )
    return Object.freeze({
      connectorId: 'feishu',
      accountId: this.#configuration.accountId,
      stream: FEISHU_BOT_MESSAGE_STREAM,
      events: Object.freeze([normalized.event]),
      projections: projectionGroups([normalized], reader),
      hasMore: false,
      observedAt,
      issues: emptyIssues(),
    })
  }

  normalizeUserBatch(
    batch: FeishuUserMessageDiscoveryBatch,
    reader: FeishuProjectionReader,
  ): FeishuNormalizedMessageBatch {
    const user = this.#configuration.user
    if (user === undefined) {
      throw fail('identity_mismatch', 'A Feishu User identity is required for normalization.')
    }
    const observedAt = observedInstant(batch.observedAt)
    const normalized = batch.messages.map((message: FeishuDiscoveredUserMessage) => {
      if (
        message.kind !== 'feishu_discovered_user_message' ||
        message.schemaVersion !== 1 ||
        message.accountId !== this.#configuration.accountId ||
        message.appId !== this.#configuration.appId ||
        message.tenantKey !== this.#tenantKey ||
        message.userPrincipalId !== user.principalId
      ) {
        throw fail('identity_mismatch', 'A Feishu User message identity does not match.')
      }
      return normalizeMessage(
        {
          accountId: message.accountId,
          appId: message.appId,
          tenantKey: message.tenantKey,
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          messageType: message.messageType,
          effectiveTime: message.updatedTime ?? message.createTime,
          receivedAt: observedAt,
          eventType: message.deleted
            ? 'message.deleted'
            : message.updated
              ? 'message.updated'
              : 'message.received',
          content: message.content,
          mentions: message.mentions,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        },
        this.#configuration,
      )
    })
    return Object.freeze({
      connectorId: 'feishu',
      accountId: this.#configuration.accountId,
      stream: 'user_visible_messages',
      events: Object.freeze(normalized.map((message) => message.event)),
      projections: projectionGroups(normalized, reader),
      ...(batch.candidateCursor === undefined ? {} : { candidateCursor: batch.candidateCursor }),
      hasMore: batch.hasMore,
      observedAt,
      issues: batch.issues,
    })
  }
}
