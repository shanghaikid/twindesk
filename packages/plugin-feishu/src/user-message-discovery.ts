import { createHash } from 'node:crypto'

import { parseConnectorCursor, type ConnectorCursor, type JsonValue } from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_USER_MESSAGE_DISCOVERY_VERSION = 1 as const
export const FEISHU_USER_MESSAGE_STREAM = 'user_visible_messages' as const

const CURSOR_POSITION_PREFIX = 'feishu-user-message-search:v1:'
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const DEFAULT_OVERLAP_MS = 5 * 60 * 1000
const DEFAULT_INDEXING_DELAY_MS = 30 * 1000
const MAX_PAGE_SIZE = 50
const MAX_CURSOR_POSITION_BYTES = 16 * 1024

type UnknownRecord = Readonly<Record<string, unknown>>

export type FeishuUserDiscoveryErrorCode =
  | 'invalid_request'
  | 'identity_mismatch'
  | 'invalid_cursor'
  | 'invalid_response'
  | 'not_authorized'
  | 'scope_missing'
  | 'rate_limited'
  | 'network'
  | 'client_failure'

export class FeishuUserDiscoveryError extends Error {
  readonly code: FeishuUserDiscoveryErrorCode
  readonly retryable: boolean

  constructor(code: FeishuUserDiscoveryErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'FeishuUserDiscoveryError'
    this.code = code
    this.retryable = retryable
  }
}

export type FeishuUserMessageSearchClientErrorCode =
  | 'invalid_page_token'
  | 'not_authorized'
  | 'scope_missing'
  | 'rate_limited'
  | 'network'
  | 'invalid_response'
  | 'unknown'

/** Payload-free failure contract for a concrete Feishu User search adapter. */
export class FeishuUserMessageSearchClientError extends Error {
  readonly code: FeishuUserMessageSearchClientErrorCode
  readonly retryable: boolean

  constructor(code: FeishuUserMessageSearchClientErrorCode) {
    const supported = [
      'invalid_page_token',
      'not_authorized',
      'scope_missing',
      'rate_limited',
      'network',
      'invalid_response',
      'unknown',
    ] as const
    const normalized =
      typeof code === 'string' && supported.includes(code as (typeof supported)[number])
        ? (code as FeishuUserMessageSearchClientErrorCode)
        : 'unknown'
    const retryable = ['invalid_page_token', 'rate_limited', 'network', 'unknown'].includes(
      normalized,
    )
    super('The Feishu User message search adapter failed.')
    this.name = 'FeishuUserMessageSearchClientError'
    this.code = normalized
    this.retryable = retryable
  }
}

export interface FeishuUserMessageMention {
  readonly key: string
  readonly principalId: string
}

export interface FeishuDiscoveredUserMessage {
  readonly kind: 'feishu_discovered_user_message'
  readonly schemaVersion: typeof FEISHU_USER_MESSAGE_DISCOVERY_VERSION
  readonly accountId: string
  readonly appId: string
  readonly tenantKey: string
  readonly userPrincipalId: string
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly messageType: string
  readonly createTime: string
  readonly updatedTime?: string
  readonly senderPrincipalId?: string
  readonly senderName?: string
  readonly chatName?: string
  readonly threadId?: string
  readonly deleted: boolean
  readonly updated: boolean
  readonly content: JsonValue
  readonly mentions: readonly FeishuUserMessageMention[]
}

export interface FeishuUserMessageSearchRequest {
  readonly identityType: 'user'
  readonly accountId: string
  readonly appId: string
  readonly tenantKey: string
  readonly userPrincipalId: string
  readonly startTime: string
  readonly endTime: string
  readonly pageSize: number
  readonly pageToken?: string
}

export interface FeishuUserMessageSearchClient {
  search(request: FeishuUserMessageSearchRequest, signal: AbortSignal): Promise<unknown>
}

export interface FeishuUserMessageDiscoveryRequest {
  readonly accountId: string
  readonly stream: typeof FEISHU_USER_MESSAGE_STREAM
  readonly limit: number
  readonly cursor?: ConnectorCursor
}

export interface FeishuUserDiscoveryIssue {
  readonly code: 'message_details_unavailable'
  readonly message: string
  readonly retryable: true
  readonly affectedCount: number
}

export interface FeishuUserDiscoveryCoverage {
  readonly status: 'partial'
  readonly basis: 'authorized_user_message_search'
  readonly windowStart: string
  readonly windowEnd: string
  readonly limitations: readonly (
    | 'api_visibility'
    | 'bounded_time_window'
    | 'indexing_delay'
    | 'pagination_in_progress'
    | 'message_details_unavailable'
  )[]
}

export interface FeishuUserMessageDiscoveryBatch {
  readonly messages: readonly FeishuDiscoveredUserMessage[]
  readonly unavailableMessageIds: readonly string[]
  readonly candidateCursor?: ConnectorCursor
  readonly hasMore: boolean
  readonly observedAt: string
  readonly coverage: FeishuUserDiscoveryCoverage
  readonly issues: readonly FeishuUserDiscoveryIssue[]
}

interface DiscoveryCursorState {
  readonly schemaVersion: typeof FEISHU_USER_MESSAGE_DISCOVERY_VERSION
  readonly watermark?: string
  readonly activeWindow?: Readonly<{
    startTime: string
    endTime: string
    nextPageToken: string
  }>
}

interface ParsedSearchPage {
  readonly messages: readonly FeishuDiscoveredUserMessage[]
  readonly unavailableMessageIds: readonly string[]
  readonly hasMore: boolean
  readonly nextPageToken: string | undefined
}

function fail(
  code: FeishuUserDiscoveryErrorCode,
  message: string,
  retryable = false,
): FeishuUserDiscoveryError {
  return new FeishuUserDiscoveryError(code, message, retryable)
}

function clientFailure(error: unknown): FeishuUserDiscoveryError {
  if (!(error instanceof FeishuUserMessageSearchClientError)) {
    return fail('client_failure', 'The Feishu User message search request failed.', true)
  }
  switch (error.code) {
    case 'not_authorized':
      return fail('not_authorized', 'The Feishu User identity is not authorized for search.')
    case 'scope_missing':
      return fail('scope_missing', 'The Feishu User identity is missing a message search scope.')
    case 'rate_limited':
      return fail('rate_limited', 'The Feishu User message search is rate limited.', true)
    case 'network':
      return fail('network', 'The Feishu User message search network request failed.', true)
    case 'invalid_response':
      return fail('invalid_response', 'The Feishu User message search response is invalid.')
    case 'invalid_page_token':
    case 'unknown':
      return fail('client_failure', 'The Feishu User message search request failed.', true)
    default:
      return fail('client_failure', 'The Feishu User message search request failed.', true)
  }
}

function dataRecord(value: unknown, code: FeishuUserDiscoveryErrorCode): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail(code, 'The Feishu User discovery data is invalid.')
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail(code, 'The Feishu User discovery data must be plain data.')
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw fail(code, 'The Feishu User discovery data has unsupported fields.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
      throw fail(code, 'The Feishu User discovery data must contain data values.')
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof FeishuUserDiscoveryError) throw error
    throw fail(code, 'The Feishu User discovery data is invalid.')
  }
}

function exactKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  code: FeishuUserDiscoveryErrorCode,
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw fail(code, 'The Feishu User discovery data has unsupported fields.')
  }
}

function dataArray(
  value: unknown,
  maximum: number,
  code: FeishuUserDiscoveryErrorCode,
  message: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw fail(code, message)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >
    const lengthDescriptor = descriptors.length
    const length = lengthDescriptor?.value
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > maximum ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    ) {
      throw fail(code, message)
    }
    const result: unknown[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw fail(code, message)
      }
      result.push(descriptor.value)
    }
    if (Object.keys(descriptors).length !== result.length + 1) {
      throw fail(code, message)
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof FeishuUserDiscoveryError) throw error
    throw fail(code, message)
  }
}

function boundedString(
  value: unknown,
  code: FeishuUserDiscoveryErrorCode,
  message: string,
  maximum = 512,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail(code, message)
  }
  return value
}

function optionalString(
  value: unknown,
  code: FeishuUserDiscoveryErrorCode,
  message: string,
  maximum = 512,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, code, message, maximum)
}

function canonicalInstant(value: unknown, code: FeishuUserDiscoveryErrorCode): string {
  if (typeof value !== 'string') throw fail(code, 'A Feishu discovery timestamp is invalid.')
  try {
    if (new Date(value).toISOString() !== value) {
      throw fail(code, 'A Feishu discovery timestamp is invalid.')
    }
  } catch (error) {
    if (error instanceof FeishuUserDiscoveryError) throw error
    throw fail(code, 'A Feishu discovery timestamp is invalid.')
  }
  return value
}

function epochMilliseconds(
  value: unknown,
  code: FeishuUserDiscoveryErrorCode,
  message: string,
): string {
  const result = boundedString(value, code, message, 32)
  if (!/^[0-9]+$/u.test(result)) throw fail(code, message)
  const milliseconds = Number(result)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw fail(code, message)
  try {
    new Date(milliseconds).toISOString()
  } catch {
    throw fail(code, message)
  }
  return result
}

function jsonValue(value: unknown, depth = 0, counter = { nodes: 0 }): JsonValue {
  counter.nodes += 1
  if (depth > 64 || counter.nodes > 100_000) {
    throw fail('invalid_response', 'A Feishu message content value is too complex.')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw fail('invalid_response', 'A Feishu message content value is invalid.')
    }
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      dataArray(
        value,
        100_000,
        'invalid_response',
        'A Feishu message content array is invalid.',
      ).map((entry) => jsonValue(entry, depth + 1, counter)),
    )
  }
  const record = dataRecord(value, 'invalid_response')
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, jsonValue(entry, depth + 1, counter)]),
    ),
  ) as Readonly<Record<string, JsonValue>>
}

function stringArray(value: unknown, maximum: number): readonly string[] {
  const result = dataArray(
    value,
    maximum,
    'invalid_response',
    'The Feishu unavailable-message list is invalid.',
  ).map((entry) =>
    boundedString(entry, 'invalid_response', 'A Feishu unavailable message identity is invalid.'),
  )
  if (new Set(result).size !== result.length) {
    throw fail('invalid_response', 'The Feishu unavailable-message list has duplicates.')
  }
  return Object.freeze(result)
}

function parseMentions(value: unknown): readonly FeishuUserMessageMention[] {
  if (value === undefined) return Object.freeze([])
  return Object.freeze(
    dataArray(value, 100, 'invalid_response', 'The Feishu message mention list is invalid.').map(
      (entry) => {
        const record = dataRecord(entry, 'invalid_response')
        exactKeys(record, ['key', 'principalId'], 'invalid_response')
        return Object.freeze({
          key: boundedString(
            record.key,
            'invalid_response',
            'A Feishu message mention key is invalid.',
            128,
          ),
          principalId: boundedString(
            record.principalId,
            'invalid_response',
            'A Feishu message mention principal is invalid.',
          ),
        })
      },
    ),
  )
}

function parseMessage(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  tenantKey: string,
): FeishuDiscoveredUserMessage {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(
    record,
    [
      'messageId',
      'chatId',
      'chatType',
      'messageType',
      'createTime',
      'updatedTime',
      'senderPrincipalId',
      'senderName',
      'chatName',
      'threadId',
      'deleted',
      'updated',
      'content',
      'mentions',
    ],
    'invalid_response',
  )
  if (record.chatType !== 'p2p' && record.chatType !== 'group') {
    throw fail('invalid_response', 'A Feishu message chat type is invalid.')
  }
  if (typeof record.deleted !== 'boolean' || typeof record.updated !== 'boolean') {
    throw fail('invalid_response', 'A Feishu message state is invalid.')
  }
  const user = configuration.user
  if (user === undefined) {
    throw fail('identity_mismatch', 'A Feishu User identity is required for User discovery.')
  }
  const updatedTime =
    record.updatedTime === undefined
      ? undefined
      : epochMilliseconds(
          record.updatedTime,
          'invalid_response',
          'A Feishu message update time is invalid.',
        )
  const createTime = epochMilliseconds(
    record.createTime,
    'invalid_response',
    'A Feishu message creation time is invalid.',
  )
  if (
    record.updated !== (updatedTime !== undefined) ||
    (updatedTime !== undefined && Number(updatedTime) < Number(createTime))
  ) {
    throw fail('invalid_response', 'A Feishu message update state is inconsistent.')
  }
  const senderPrincipalId = optionalString(
    record.senderPrincipalId,
    'invalid_response',
    'A Feishu sender principal is invalid.',
  )
  const senderName = optionalString(
    record.senderName,
    'invalid_response',
    'A Feishu sender name is invalid.',
  )
  const chatName = optionalString(
    record.chatName,
    'invalid_response',
    'A Feishu chat name is invalid.',
  )
  const threadId = optionalString(
    record.threadId,
    'invalid_response',
    'A Feishu thread identity is invalid.',
  )
  return Object.freeze({
    kind: 'feishu_discovered_user_message',
    schemaVersion: FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
    accountId: configuration.accountId,
    appId: configuration.appId,
    tenantKey,
    userPrincipalId: user.principalId,
    messageId: boundedString(
      record.messageId,
      'invalid_response',
      'A Feishu message identity is invalid.',
    ),
    chatId: boundedString(record.chatId, 'invalid_response', 'A Feishu chat identity is invalid.'),
    chatType: record.chatType,
    messageType: boundedString(
      record.messageType,
      'invalid_response',
      'A Feishu message type is invalid.',
      128,
    ),
    createTime,
    ...(updatedTime === undefined ? {} : { updatedTime }),
    ...(senderPrincipalId === undefined ? {} : { senderPrincipalId }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(chatName === undefined ? {} : { chatName }),
    ...(threadId === undefined ? {} : { threadId }),
    deleted: record.deleted,
    updated: record.updated,
    content: jsonValue(record.content),
    mentions: parseMentions(record.mentions),
  })
}

function parseSearchPage(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  tenantKey: string,
  pageSize: number,
): ParsedSearchPage {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(
    record,
    [
      'kind',
      'schemaVersion',
      'identityType',
      'accountId',
      'appId',
      'tenantKey',
      'userPrincipalId',
      'messages',
      'unavailableMessageIds',
      'hasMore',
      'nextPageToken',
    ],
    'invalid_response',
  )
  const user = configuration.user
  if (
    user === undefined ||
    record.kind !== 'feishu_user_message_search_page' ||
    record.schemaVersion !== FEISHU_USER_MESSAGE_DISCOVERY_VERSION ||
    record.identityType !== 'user' ||
    record.accountId !== configuration.accountId ||
    record.appId !== configuration.appId ||
    record.tenantKey !== tenantKey ||
    record.userPrincipalId !== user.principalId
  ) {
    throw fail('identity_mismatch', 'The Feishu search response identity does not match the User.')
  }
  const rawMessages = dataArray(
    record.messages,
    pageSize,
    'invalid_response',
    'The Feishu message search page is invalid.',
  )
  const messages = Object.freeze(
    rawMessages.map((message) => parseMessage(message, configuration, tenantKey)),
  )
  if (new Set(messages.map((message) => message.messageId)).size !== messages.length) {
    throw fail('invalid_response', 'The Feishu message search page has duplicate messages.')
  }
  const unavailableMessageIds = stringArray(record.unavailableMessageIds, MAX_PAGE_SIZE)
  if (messages.length + unavailableMessageIds.length > pageSize) {
    throw fail('invalid_response', 'The Feishu message search page exceeds its requested limit.')
  }
  if (
    unavailableMessageIds.some((messageId) =>
      messages.some((message) => message.messageId === messageId),
    )
  ) {
    throw fail('invalid_response', 'A Feishu message cannot be both available and unavailable.')
  }
  if (typeof record.hasMore !== 'boolean') {
    throw fail('invalid_response', 'The Feishu message search pagination state is invalid.')
  }
  const nextPageToken = optionalString(
    record.nextPageToken,
    'invalid_response',
    'The Feishu message search page token is invalid.',
    4096,
  )
  if (
    (record.hasMore && nextPageToken === undefined) ||
    (!record.hasMore && nextPageToken !== undefined)
  ) {
    throw fail('invalid_response', 'The Feishu message search pagination state is invalid.')
  }
  return Object.freeze({ messages, unavailableMessageIds, hasMore: record.hasMore, nextPageToken })
}

function encodeCursorPosition(state: DiscoveryCursorState): string {
  return `${CURSOR_POSITION_PREFIX}${Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')}`
}

function decodeCursorPosition(value: string): DiscoveryCursorState {
  if (
    !value.startsWith(CURSOR_POSITION_PREFIX) ||
    Buffer.byteLength(value) > MAX_CURSOR_POSITION_BYTES
  ) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor position is invalid.')
  }
  const encoded = value.slice(CURSOR_POSITION_PREFIX.length)
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor position is invalid.')
  }
  let parsed: unknown
  try {
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) {
      throw new Error('non-canonical cursor')
    }
    parsed = JSON.parse(decoded.toString('utf8')) as unknown
  } catch {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor position is invalid.')
  }
  const record = dataRecord(parsed, 'invalid_cursor')
  exactKeys(record, ['schemaVersion', 'watermark', 'activeWindow'], 'invalid_cursor')
  if (record.schemaVersion !== FEISHU_USER_MESSAGE_DISCOVERY_VERSION) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor version is invalid.')
  }
  const watermark =
    record.watermark === undefined
      ? undefined
      : canonicalInstant(record.watermark, 'invalid_cursor')
  let activeWindow: DiscoveryCursorState['activeWindow']
  if (record.activeWindow !== undefined) {
    const active = dataRecord(record.activeWindow, 'invalid_cursor')
    exactKeys(active, ['startTime', 'endTime', 'nextPageToken'], 'invalid_cursor')
    const startTime = canonicalInstant(active.startTime, 'invalid_cursor')
    const endTime = canonicalInstant(active.endTime, 'invalid_cursor')
    if (Date.parse(startTime) >= Date.parse(endTime)) {
      throw fail('invalid_cursor', 'The Feishu User discovery cursor window is invalid.')
    }
    activeWindow = Object.freeze({
      startTime,
      endTime,
      nextPageToken: boundedString(
        active.nextPageToken,
        'invalid_cursor',
        'The Feishu User discovery cursor page token is invalid.',
        4096,
      ),
    })
  }
  if (watermark === undefined && activeWindow === undefined) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor has no progress state.')
  }
  if (
    watermark !== undefined &&
    activeWindow !== undefined &&
    Date.parse(watermark) > Date.parse(activeWindow.endTime)
  ) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor chronology is invalid.')
  }
  return Object.freeze({
    schemaVersion: FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
    ...(watermark === undefined ? {} : { watermark }),
    ...(activeWindow === undefined ? {} : { activeWindow }),
  })
}

function parseCursor(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  expectedId: string,
): Readonly<{ cursor: ConnectorCursor; state: DiscoveryCursorState }> {
  let cursor: ConnectorCursor
  try {
    cursor = parseConnectorCursor(value)
  } catch {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor is invalid.')
  }
  if (
    cursor.id !== expectedId ||
    cursor.connectorId !== 'feishu' ||
    cursor.accountId !== configuration.accountId ||
    cursor.stream !== FEISHU_USER_MESSAGE_STREAM
  ) {
    throw fail('identity_mismatch', 'The Feishu User discovery cursor identity does not match.')
  }
  const state = decodeCursorPosition(cursor.position)
  if (cursor.committedThrough !== state.watermark) {
    throw fail('invalid_cursor', 'The Feishu User discovery cursor watermark is inconsistent.')
  }
  return Object.freeze({ cursor, state })
}

function cursorId(configuration: FeishuIdentityConfiguration): string {
  const user = configuration.user
  if (user === undefined) {
    throw fail('identity_mismatch', 'A Feishu User identity is required for User discovery.')
  }
  const suffix = createHash('sha256')
    .update(configuration.accountId)
    .update('\u0000')
    .update(user.principalId)
    .digest('hex')
    .slice(0, 24)
  return `cursor-feishu-user-messages-${suffix}`
}

function candidateCursor(
  configuration: FeishuIdentityConfiguration,
  expectedId: string,
  state: DiscoveryCursorState,
  observedAt: string,
): ConnectorCursor {
  try {
    return parseConnectorCursor({
      kind: 'connector_cursor',
      schemaVersion: 1,
      id: expectedId,
      connectorId: 'feishu',
      accountId: configuration.accountId,
      stream: FEISHU_USER_MESSAGE_STREAM,
      position: encodeCursorPosition(state),
      ...(state.watermark === undefined ? {} : { committedThrough: state.watermark }),
      updatedAt: observedAt,
    })
  } catch {
    throw fail('invalid_cursor', 'The Feishu User discovery candidate cursor is invalid.')
  }
}

function parseRequest(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
): Readonly<{ limit: number; cursor: ConnectorCursor | undefined }> {
  const record = dataRecord(value, 'invalid_request')
  exactKeys(record, ['accountId', 'stream', 'limit', 'cursor'], 'invalid_request')
  if (
    record.accountId !== configuration.accountId ||
    record.stream !== FEISHU_USER_MESSAGE_STREAM
  ) {
    throw fail('identity_mismatch', 'The Feishu User discovery request identity does not match.')
  }
  if (
    !Number.isSafeInteger(record.limit) ||
    (record.limit as number) < 1 ||
    (record.limit as number) > MAX_PAGE_SIZE
  ) {
    throw fail('invalid_request', 'The Feishu User discovery page limit is invalid.')
  }
  return Object.freeze({
    limit: record.limit as number,
    cursor: record.cursor === undefined ? undefined : (record.cursor as ConnectorCursor),
  })
}

function clockInstant(now: () => number): Readonly<{ milliseconds: number; instant: string }> {
  let milliseconds: number
  try {
    milliseconds = now()
  } catch {
    throw fail('invalid_request', 'The Feishu User discovery clock is invalid.')
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw fail('invalid_request', 'The Feishu User discovery clock is invalid.')
  }
  try {
    return Object.freeze({ milliseconds, instant: new Date(milliseconds).toISOString() })
  } catch {
    throw fail('invalid_request', 'The Feishu User discovery clock is invalid.')
  }
}

function coverage(
  startTime: string,
  endTime: string,
  hasMore: boolean,
  missingDetails: boolean,
): FeishuUserDiscoveryCoverage {
  const limitations: Array<FeishuUserDiscoveryCoverage['limitations'][number]> = [
    'api_visibility',
    'bounded_time_window',
    'indexing_delay',
    ...(hasMore ? (['pagination_in_progress'] as const) : []),
    ...(missingDetails ? (['message_details_unavailable'] as const) : []),
  ]
  return Object.freeze({
    status: 'partial',
    basis: 'authorized_user_message_search',
    windowStart: startTime,
    windowEnd: endTime,
    limitations: Object.freeze(limitations),
  })
}

export class FeishuUserMessageDiscoverer {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #client: FeishuUserMessageSearchClient
  readonly #tenantKey: string
  readonly #now: () => number
  readonly #initialLookbackMs: number
  readonly #overlapMs: number
  readonly #indexingDelayMs: number
  readonly #cursorId: string

  constructor(
    configuration: unknown,
    client: FeishuUserMessageSearchClient,
    options: Readonly<{
      tenantKey: string
      now?: () => number
      initialLookbackMs?: number
      overlapMs?: number
      indexingDelayMs?: number
    }>,
  ) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    if (this.#configuration.user === undefined) {
      throw fail('identity_mismatch', 'A Feishu User identity is required for User discovery.')
    }
    const clientRecord = dataRecord(client, 'invalid_request')
    exactKeys(clientRecord, ['search'], 'invalid_request')
    if (typeof clientRecord.search !== 'function') {
      throw fail('invalid_request', 'The Feishu User message search client is invalid.')
    }
    const optionRecord = dataRecord(options, 'invalid_request')
    exactKeys(
      optionRecord,
      ['tenantKey', 'now', 'initialLookbackMs', 'overlapMs', 'indexingDelayMs'],
      'invalid_request',
    )
    const tenantKey = boundedString(
      optionRecord.tenantKey,
      'invalid_request',
      'The Feishu User discovery tenant identity is invalid.',
    )
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(tenantKey)) {
      throw fail('invalid_request', 'The Feishu User discovery tenant identity is invalid.')
    }
    const now = optionRecord.now === undefined ? Date.now : optionRecord.now
    const initialLookbackMs = optionRecord.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS
    const overlapMs = optionRecord.overlapMs ?? DEFAULT_OVERLAP_MS
    const indexingDelayMs = optionRecord.indexingDelayMs ?? DEFAULT_INDEXING_DELAY_MS
    if (
      typeof now !== 'function' ||
      !Number.isSafeInteger(initialLookbackMs) ||
      (initialLookbackMs as number) < 60_000 ||
      (initialLookbackMs as number) > 30 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(overlapMs) ||
      (overlapMs as number) < 0 ||
      (overlapMs as number) > 24 * 60 * 60 * 1000 ||
      (overlapMs as number) >= (initialLookbackMs as number) ||
      !Number.isSafeInteger(indexingDelayMs) ||
      (indexingDelayMs as number) < 0 ||
      (indexingDelayMs as number) > 60 * 60 * 1000
    ) {
      throw fail('invalid_request', 'The Feishu User discovery options are invalid.')
    }
    this.#client = Object.freeze({
      search: clientRecord.search as FeishuUserMessageSearchClient['search'],
    })
    this.#tenantKey = tenantKey
    this.#now = now as () => number
    this.#initialLookbackMs = initialLookbackMs as number
    this.#overlapMs = overlapMs as number
    this.#indexingDelayMs = indexingDelayMs as number
    this.#cursorId = cursorId(this.#configuration)
  }

  async discover(value: unknown, signal: AbortSignal): Promise<FeishuUserMessageDiscoveryBatch> {
    signal.throwIfAborted()
    const request = parseRequest(value, this.#configuration)
    const existing =
      request.cursor === undefined
        ? undefined
        : parseCursor(request.cursor, this.#configuration, this.#cursorId)
    const clock = clockInstant(this.#now)
    if (existing !== undefined && Date.parse(existing.cursor.updatedAt) > clock.milliseconds) {
      throw fail('invalid_cursor', 'The Feishu User discovery cursor is newer than the clock.')
    }
    const searchableEndMs = Math.max(0, clock.milliseconds - this.#indexingDelayMs)
    const state = existing?.state
    let startTime: string
    let endTime: string
    let pageToken: string | undefined
    if (state?.activeWindow !== undefined) {
      startTime = state.activeWindow.startTime
      endTime = state.activeWindow.endTime
      pageToken = state.activeWindow.nextPageToken
    } else {
      const watermarkMs = state?.watermark === undefined ? undefined : Date.parse(state.watermark)
      if (watermarkMs !== undefined && searchableEndMs <= watermarkMs) {
        const instant = new Date(searchableEndMs).toISOString()
        return Object.freeze({
          messages: Object.freeze([]),
          unavailableMessageIds: Object.freeze([]),
          hasMore: false,
          observedAt: clock.instant,
          coverage: coverage(instant, instant, false, false),
          issues: Object.freeze([]),
        })
      }
      const startMs =
        watermarkMs === undefined
          ? Math.max(0, searchableEndMs - this.#initialLookbackMs)
          : Math.max(0, watermarkMs - this.#overlapMs)
      startTime = new Date(startMs).toISOString()
      endTime = new Date(searchableEndMs).toISOString()
    }
    const user = this.#configuration.user
    if (user === undefined) {
      throw fail('identity_mismatch', 'A Feishu User identity is required for User discovery.')
    }
    const search = (token: string | undefined) =>
      this.#client.search(
        Object.freeze({
          identityType: 'user',
          accountId: this.#configuration.accountId,
          appId: this.#configuration.appId,
          tenantKey: this.#tenantKey,
          userPrincipalId: user.principalId,
          startTime,
          endTime,
          pageSize: request.limit,
          ...(token === undefined ? {} : { pageToken: token }),
        }),
        signal,
      )
    let rawPage: unknown
    try {
      rawPage = await search(pageToken)
    } catch (error) {
      signal.throwIfAborted()
      if (
        pageToken !== undefined &&
        error instanceof FeishuUserMessageSearchClientError &&
        error.code === 'invalid_page_token'
      ) {
        try {
          rawPage = await search(undefined)
          pageToken = undefined
        } catch (retryError) {
          signal.throwIfAborted()
          throw clientFailure(retryError)
        }
      } else {
        throw clientFailure(error)
      }
    }
    signal.throwIfAborted()
    let page: ParsedSearchPage
    try {
      page = parseSearchPage(rawPage, this.#configuration, this.#tenantKey, request.limit)
    } catch (error) {
      if (error instanceof FeishuUserDiscoveryError) throw error
      throw fail('invalid_response', 'The Feishu User message search response is invalid.')
    }
    const nextState: DiscoveryCursorState = page.hasMore
      ? Object.freeze({
          schemaVersion: FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
          ...(state?.watermark === undefined ? {} : { watermark: state.watermark }),
          activeWindow: Object.freeze({
            startTime,
            endTime,
            nextPageToken: page.nextPageToken as string,
          }),
        })
      : Object.freeze({
          schemaVersion: FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
          watermark: endTime,
        })
    const missingDetails = page.unavailableMessageIds.length > 0
    const effectiveHasMore = page.hasMore || missingDetails
    const candidate = missingDetails
      ? undefined
      : candidateCursor(this.#configuration, this.#cursorId, nextState, clock.instant)
    return Object.freeze({
      messages: page.messages,
      unavailableMessageIds: page.unavailableMessageIds,
      ...(candidate === undefined ? {} : { candidateCursor: candidate }),
      hasMore: effectiveHasMore,
      observedAt: clock.instant,
      coverage: coverage(startTime, endTime, effectiveHasMore, missingDetails),
      issues: missingDetails
        ? Object.freeze([
            Object.freeze({
              code: 'message_details_unavailable',
              message: 'Some Feishu search results could not be retrieved as messages.',
              retryable: true,
              affectedCount: page.unavailableMessageIds.length,
            }),
          ])
        : Object.freeze([]),
    })
  }
}
