import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import {
  FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
  FeishuUserMessageSearchClientError,
  type FeishuUserMessageSearchRequest,
} from './user-message-discovery.ts'

export const FEISHU_USER_MESSAGE_SEARCH_URL =
  'https://open.feishu.cn/open-apis/im/v1/messages/search' as const
export const FEISHU_USER_MESSAGE_SEARCH_HTTP_RESPONSE_MAX_BYTES = 1024 * 1024
export const FEISHU_USER_MESSAGE_SEARCH_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_USER_MESSAGE_SEARCH_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

const MESSAGE_URL_PREFIX = 'https://open.feishu.cn/open-apis/im/v1/messages/' as const
const CHAT_URL_PREFIX = 'https://open.feishu.cn/open-apis/im/v1/chats/' as const
const MAX_PAGE_SIZE = 50
const MAX_IDENTIFIER_CHARACTERS = 4096
const MAX_CONTENT_CHARACTERS = 512 * 1024
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const AUTHORIZATION_CODES = new Set([
  10014, 99991543, 99991661, 99991662, 99991663, 99991671, 99991673,
])
const SCOPE_CODES = new Set([99991672, 99991676, 99991679])

type UnknownRecord = Readonly<Record<string, unknown>>

export interface FeishuUserMessageSearchHttpRequest extends FeishuUserMessageSearchRequest {
  /** Borrowed caller-owned bytes. The client never mutates this buffer. */
  readonly accessToken: Uint8Array
}

export interface FeishuUserMessageSearchHttpClientOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMilliseconds?: number
}

const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get
const responseHeadersGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'headers')?.get
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body')?.get
const fillBytes = Uint8Array.prototype.fill

class MessageDetailUnavailable extends Error {}

function clientError(
  code: ConstructorParameters<typeof FeishuUserMessageSearchClientError>[0],
): FeishuUserMessageSearchClientError {
  return new FeishuUserMessageSearchClientError(code)
}

function dataRecord(value: unknown): UnknownRecord {
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
}

function exactOptionalKeys(
  record: UnknownRecord,
  required: readonly string[],
  allowed: readonly string[],
): void {
  const keys = Object.keys(record)
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new TypeError()
  }
}

function dataArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    throw new TypeError()
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
    result.push(descriptor.value)
  }
  return result
}

function boundedString(value: unknown, maximum = MAX_IDENTIFIER_CHARACTERS): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes('\u0000')
  ) {
    throw new TypeError()
  }
  return value
}

function identifier(value: unknown): string {
  const result = boundedString(value, 512)
  if (!IDENTIFIER_PATTERN.test(result)) throw new TypeError()
  return result
}

function canonicalInstant(value: unknown): Readonly<{ iso: string; milliseconds: number }> {
  const text = boundedString(value, 64)
  const milliseconds = Date.parse(text)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new TypeError()
  }
  return Object.freeze({ iso: text, milliseconds })
}

function epochMilliseconds(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new TypeError()
  }
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TypeError()
  return new Date(milliseconds).toISOString()
}

function readOptions(value: unknown): Readonly<{
  fetch: typeof fetch
  timeoutMilliseconds: number
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    exactOptionalKeys(options, [], ['fetch', 'timeoutMilliseconds'])
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_USER_MESSAGE_SEARCH_HTTP_TIMEOUT_MILLISECONDS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_USER_MESSAGE_SEARCH_HTTP_MAX_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      fetch: fetchImplementation as typeof fetch,
      timeoutMilliseconds: timeoutMilliseconds as number,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function readRequest(value: unknown): Readonly<{
  identityType: 'user'
  accountId: string
  appId: string
  tenantKey: string
  userPrincipalId: string
  startTime: string
  endTime: string
  startMilliseconds: number
  endMilliseconds: number
  pageSize: number
  pageToken?: string
  accessToken: Uint8Array<ArrayBuffer>
}> {
  try {
    const request = dataRecord(value)
    exactOptionalKeys(
      request,
      [
        'identityType',
        'accountId',
        'appId',
        'tenantKey',
        'userPrincipalId',
        'startTime',
        'endTime',
        'pageSize',
        'accessToken',
      ],
      [
        'identityType',
        'accountId',
        'appId',
        'tenantKey',
        'userPrincipalId',
        'startTime',
        'endTime',
        'pageSize',
        'pageToken',
        'accessToken',
      ],
    )
    if (request.identityType !== 'user') throw new TypeError()
    const start = canonicalInstant(request.startTime)
    const end = canonicalInstant(request.endTime)
    if (
      start.milliseconds >= end.milliseconds ||
      !Number.isSafeInteger(request.pageSize) ||
      (request.pageSize as number) < 1 ||
      (request.pageSize as number) > MAX_PAGE_SIZE ||
      !(request.accessToken instanceof Uint8Array) ||
      !(request.accessToken.buffer instanceof ArrayBuffer) ||
      request.accessToken.byteLength === 0 ||
      request.accessToken.byteLength > FEISHU_OAUTH_TOKEN_MAX_LENGTH
    ) {
      throw new TypeError()
    }
    for (let index = 0; index < request.accessToken.byteLength; index += 1) {
      const byte = request.accessToken[index] as number
      if (byte < 0x21 || byte > 0x7e) throw new TypeError()
    }
    const pageToken = Object.hasOwn(request, 'pageToken')
      ? boundedString(request.pageToken)
      : undefined
    return Object.freeze({
      identityType: 'user',
      accountId: identifier(request.accountId),
      appId: identifier(request.appId),
      tenantKey: identifier(request.tenantKey),
      userPrincipalId: identifier(request.userPrincipalId),
      startTime: start.iso,
      endTime: end.iso,
      startMilliseconds: start.milliseconds,
      endMilliseconds: end.milliseconds,
      pageSize: request.pageSize as number,
      ...(pageToken === undefined ? {} : { pageToken }),
      accessToken: request.accessToken as Uint8Array<ArrayBuffer>,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

function contentLength(headers: Headers): void {
  const value = headers.get('content-length')
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) throw clientError('invalid_response')
  const length = Number(value)
  if (
    !Number.isSafeInteger(length) ||
    length > FEISHU_USER_MESSAGE_SEARCH_HTTP_RESPONSE_MAX_BYTES
  ) {
    throw clientError('invalid_response')
  }
}

function contentType(headers: Headers): void {
  const value = headers.get('content-type')
  if (value === null || !/^application\/json(?:\s*;|$)/iu.test(value)) {
    throw clientError('invalid_response')
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return
  try {
    await body.cancel()
  } catch {
    // The original response failure remains authoritative.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {
    // The original response failure remains authoritative.
  })
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) return
      settled = true
      cancelReader(reader)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void reader.read().then(
      (result) => {
        if (settled) {
          if (!result.done && result.value instanceof Uint8Array) zeroBytes(result.value)
          return
        }
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (body === null) throw clientError('invalid_response')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await readChunk(reader, signal)
      signal.throwIfAborted()
      if (result.done) break
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw clientError('invalid_response')
      }
      if (result.value.byteLength > FEISHU_USER_MESSAGE_SEARCH_HTTP_RESPONSE_MAX_BYTES - total) {
        cancelReader(reader)
        throw clientError('invalid_response')
      }
      chunks.push(result.value)
      total += result.value.byteLength
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } catch (error) {
    cancelReader(reader)
    throw error
  } finally {
    for (const chunk of chunks) zeroBytes(chunk)
    try {
      reader.releaseLock()
    } catch {
      // Cancellation can leave the stream locked until the pending read settles.
    }
  }
}

function hasDuplicateObjectKey(text: string): boolean {
  const keys: Array<Set<string>> = []
  let index = 0
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        if (!escaped && text[index] === '"') break
        if (!escaped && text[index] === '\\') escaped = true
        else escaped = false
        index += 1
      }
      if (index >= text.length) return false
      let next = index + 1
      while (/\s/u.test(text[next] ?? '')) next += 1
      const current = keys.at(-1)
      if (current !== undefined && text[next] === ':') {
        let key: unknown
        try {
          key = JSON.parse(text.slice(start, index + 1)) as unknown
        } catch {
          return false
        }
        if (typeof key !== 'string') return false
        if (current.has(key)) return true
        current.add(key)
      }
    } else if (text[index] === '{') keys.push(new Set())
    else if (text[index] === '}') keys.pop()
    index += 1
  }
  return false
}

function parseJsonBytes(body: Uint8Array): UnknownRecord {
  if (body.byteLength === 0) throw clientError('invalid_response')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    if (hasDuplicateObjectKey(text)) throw new TypeError()
    return dataRecord(JSON.parse(text) as unknown)
  } catch {
    throw clientError('invalid_response')
  }
}

function applicationError(code: number): FeishuUserMessageSearchClientError {
  if (code === 99991400) return clientError('rate_limited')
  if (AUTHORIZATION_CODES.has(code)) return clientError('not_authorized')
  if (SCOPE_CODES.has(code)) return clientError('scope_missing')
  return clientError('unknown')
}

function statusError(status: number): FeishuUserMessageSearchClientError {
  if (status === 401 || status === 403) return clientError('not_authorized')
  if (status === 429) return clientError('rate_limited')
  return clientError('unknown')
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  context: 'search' | 'detail' | 'chat',
  hasPageToken = false,
): Promise<UnknownRecord> {
  let response: Response
  try {
    response = await fetchImplementation(url, init)
  } catch {
    if (signal.aborted) signal.throwIfAborted()
    throw clientError('network')
  }
  let status: number
  let headers: Headers
  let stream: ReadableStream<Uint8Array> | null
  try {
    if (
      !(response instanceof Response) ||
      responseStatusGetter === undefined ||
      responseHeadersGetter === undefined ||
      responseBodyGetter === undefined
    ) {
      throw new TypeError()
    }
    status = responseStatusGetter.call(response) as number
    headers = responseHeadersGetter.call(response) as Headers
    stream = responseBodyGetter.call(response) as ReadableStream<Uint8Array> | null
    if (!(headers instanceof Headers) || (stream !== null && !(stream instanceof ReadableStream))) {
      throw new TypeError()
    }
  } catch {
    throw clientError('invalid_response')
  }
  let body: Uint8Array | undefined
  try {
    if (status < 200 || status > 299) {
      if ((context === 'detail' || context === 'chat') && status === 404) {
        await cancelBody(stream)
        throw new MessageDetailUnavailable()
      }
      if ([400, 401, 403, 404, 409, 422, 429].includes(status) && stream !== null) {
        try {
          contentLength(headers)
          contentType(headers)
          body = await boundedBody(stream, signal)
          const record = parseJsonBytes(body)
          if (Number.isSafeInteger(record.code) && record.code !== 0) {
            const mapped = applicationError(record.code as number)
            if (mapped.code !== 'unknown') throw mapped
          }
        } catch (error) {
          if (
            error instanceof FeishuUserMessageSearchClientError &&
            error.code !== 'invalid_response' &&
            error.code !== 'unknown'
          ) {
            throw error
          }
        }
      } else {
        await cancelBody(stream)
      }
      if (
        (context === 'detail' || context === 'chat') &&
        status >= 400 &&
        status < 500 &&
        status !== 401 &&
        status !== 403
      ) {
        throw new MessageDetailUnavailable()
      }
      if (context === 'search' && status === 400 && hasPageToken) {
        throw clientError('invalid_page_token')
      }
      throw statusError(status)
    }
    contentLength(headers)
    contentType(headers)
    body = await boundedBody(stream, signal)
    const record = parseJsonBytes(body)
    exactOptionalKeys(record, ['code'], ['code', 'msg', 'data'])
    if (!Number.isSafeInteger(record.code)) throw clientError('invalid_response')
    if (record.code !== 0) {
      const error = applicationError(record.code as number)
      if (context === 'search' && hasPageToken && error.code === 'unknown') {
        throw clientError('invalid_page_token')
      }
      if ((context === 'detail' || context === 'chat') && error.code === 'unknown') {
        throw new MessageDetailUnavailable()
      }
      throw error
    }
    if (!Object.hasOwn(record, 'data')) throw clientError('invalid_response')
    return dataRecord(record.data)
  } finally {
    if (body !== undefined) zeroBytes(body)
  }
}

interface SearchIndexItem {
  readonly messageId: string
  readonly createTime: string
  readonly chatId: string
  readonly chatType?: 'p2p' | 'group'
  readonly messageType?: string
  readonly threadId?: string
}

function parseSearchPage(
  data: UnknownRecord,
  request: ReturnType<typeof readRequest>,
): Readonly<{ items: readonly SearchIndexItem[]; hasMore: boolean; nextPageToken?: string }> {
  try {
    exactOptionalKeys(
      data,
      ['items', 'has_more'],
      ['items', 'total', 'has_more', 'page_token', 'notice'],
    )
    if (typeof data.has_more !== 'boolean') throw new TypeError()
    const rawItems = dataArray(data.items, request.pageSize)
    const items = rawItems.map((value): SearchIndexItem => {
      const item = dataRecord(value)
      exactOptionalKeys(item, ['id', 'meta_data'], ['id', 'display_info', 'meta_data'])
      identifier(item.id)
      const meta = dataRecord(item.meta_data)
      exactOptionalKeys(
        meta,
        ['message_id', 'create_time', 'chat_id'],
        [
          'message_id',
          'type',
          'create_time',
          'update_time',
          'position',
          'chat_id',
          'from_id',
          'thread_id',
          'thread_position',
          'is_p2p_chat',
        ],
      )
      const createTime = epochMilliseconds(meta.create_time)
      if (meta.is_p2p_chat !== undefined && typeof meta.is_p2p_chat !== 'boolean') {
        throw new TypeError()
      }
      const chatType =
        meta.is_p2p_chat === undefined ? undefined : meta.is_p2p_chat ? 'p2p' : 'group'
      return Object.freeze({
        messageId: identifier(meta.message_id),
        createTime,
        chatId: identifier(meta.chat_id),
        ...(chatType === undefined ? {} : { chatType }),
        ...(meta.type === undefined ? {} : { messageType: boundedString(meta.type, 128) }),
        ...(meta.thread_id === undefined ? {} : { threadId: identifier(meta.thread_id) }),
      })
    })
    if (new Set(items.map((item) => item.messageId)).size !== items.length) throw new TypeError()
    const nextPageToken = data.page_token === undefined ? undefined : boundedString(data.page_token)
    if (
      (data.has_more && nextPageToken === undefined) ||
      (!data.has_more && nextPageToken !== undefined)
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      items: Object.freeze(items),
      hasMore: data.has_more,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    })
  } catch (error) {
    if (error instanceof FeishuUserMessageSearchClientError) throw error
    throw clientError('invalid_response')
  }
}

function parseContent(value: unknown): unknown {
  const text = boundedString(value, MAX_CONTENT_CHARACTERS)
  if (hasDuplicateObjectKey(text)) throw new TypeError()
  return JSON.parse(text) as unknown
}

function parseChat(
  data: UnknownRecord,
): Readonly<{ chatType: 'p2p' | 'group'; chatName?: string }> {
  exactOptionalKeys(
    data,
    ['chat_mode'],
    [
      'avatar',
      'name',
      'description',
      'i18n_names',
      'add_member_permission',
      'share_card_permission',
      'at_all_permission',
      'edit_permission',
      'owner_id_type',
      'owner_id',
      'user_manager_id_list',
      'bot_manager_id_list',
      'group_message_type',
      'chat_mode',
      'chat_type',
      'chat_tag',
      'join_message_visibility',
      'leave_message_visibility',
      'membership_approval',
      'moderation_permission',
      'external',
      'tenant_key',
      'user_count',
      'bot_count',
      'labels',
      'toolkit_ids',
      'restricted_mode_setting',
      'urgent_setting',
      'video_conference_setting',
      'pin_manage_setting',
      'hide_member_count_setting',
      'chat_status',
    ],
  )
  if (data.chat_mode !== 'p2p' && data.chat_mode !== 'group' && data.chat_mode !== 'topic') {
    throw new TypeError()
  }
  const chatName = data.name === undefined ? undefined : boundedString(data.name, 1024)
  return Object.freeze({
    chatType: data.chat_mode === 'p2p' ? 'p2p' : 'group',
    ...(chatName === undefined ? {} : { chatName }),
  })
}

function parseDetail(
  data: UnknownRecord,
  index: SearchIndexItem,
  chat: Readonly<{ chatType: 'p2p' | 'group'; chatName?: string }>,
): UnknownRecord {
  exactOptionalKeys(data, ['items'], ['items'])
  const items = dataArray(data.items, 1)
  if (items.length === 0) throw new MessageDetailUnavailable()
  const item = dataRecord(items[0])
  exactOptionalKeys(
    item,
    ['message_id', 'msg_type', 'create_time', 'deleted', 'updated', 'chat_id'],
    [
      'message_id',
      'root_id',
      'parent_id',
      'thread_id',
      'msg_type',
      'create_time',
      'update_time',
      'deleted',
      'updated',
      'chat_id',
      'sender',
      'body',
      'mentions',
      'upper_message_id',
      'message_app_link',
      'message_position',
      'thread_message_position',
    ],
  )
  if (
    identifier(item.message_id) !== index.messageId ||
    typeof item.deleted !== 'boolean' ||
    typeof item.updated !== 'boolean'
  ) {
    throw new TypeError()
  }
  const createTime = epochMilliseconds(item.create_time)
  const chatId = identifier(item.chat_id)
  if (
    createTime !== index.createTime ||
    chatId !== index.chatId ||
    (index.threadId !== undefined && item.thread_id !== index.threadId)
  ) {
    throw new TypeError()
  }
  const updatedTime = item.updated ? epochMilliseconds(item.update_time) : undefined
  if (updatedTime !== undefined && Date.parse(updatedTime) < Date.parse(createTime)) {
    throw new TypeError()
  }
  let senderPrincipalId: string | undefined
  let senderName: string | undefined
  if (item.sender !== undefined) {
    const sender = dataRecord(item.sender)
    exactOptionalKeys(
      sender,
      ['id', 'id_type', 'sender_type'],
      [
        'id',
        'id_type',
        'sender_type',
        'tenant_key',
        'sender_name',
        'open_bot_id',
        'sender_i18n_names',
      ],
    )
    if (sender.id_type !== 'open_id') throw new TypeError()
    senderPrincipalId = identifier(sender.id)
    senderName =
      sender.sender_name === undefined ? undefined : boundedString(sender.sender_name, 1024)
  }
  const mentions =
    item.mentions === undefined
      ? []
      : dataArray(item.mentions, 100).map((value) => {
          const mention = dataRecord(value)
          exactOptionalKeys(
            mention,
            ['key', 'id', 'id_type', 'name'],
            ['key', 'id', 'id_type', 'name', 'tenant_key'],
          )
          if (mention.id_type !== 'open_id') throw new TypeError()
          return Object.freeze({
            key: boundedString(mention.key, 128),
            principalId: identifier(mention.id),
          })
        })
  let content: unknown = null
  if (!item.deleted) {
    const body = dataRecord(item.body)
    exactOptionalKeys(body, ['content'], ['content'])
    content = parseContent(body.content)
  }
  return Object.freeze({
    messageId: index.messageId,
    chatId,
    chatType: chat.chatType,
    messageType: boundedString(item.msg_type, 128),
    createTime: String(Date.parse(createTime)),
    ...(updatedTime === undefined ? {} : { updatedTime: String(Date.parse(updatedTime)) }),
    ...(senderPrincipalId === undefined ? {} : { senderPrincipalId }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(chat.chatName === undefined ? {} : { chatName: chat.chatName }),
    ...(item.thread_id === undefined ? {} : { threadId: identifier(item.thread_id) }),
    deleted: item.deleted,
    updated: item.updated,
    content,
    mentions: Object.freeze(mentions),
  })
}

function searchUrl(request: ReturnType<typeof readRequest>): string {
  const url = new URL(FEISHU_USER_MESSAGE_SEARCH_URL)
  url.searchParams.set('page_size', String(request.pageSize))
  url.searchParams.set('user_id_type', 'open_id')
  if (request.pageToken !== undefined) url.searchParams.set('page_token', request.pageToken)
  return url.toString()
}

function detailUrl(messageId: string): string {
  const url = new URL(`${MESSAGE_URL_PREFIX}${encodeURIComponent(messageId)}`)
  url.searchParams.set('user_id_type', 'open_id')
  url.searchParams.set('with_sender_name', 'true')
  return url.toString()
}

function chatUrl(chatId: string): string {
  const url = new URL(`${CHAT_URL_PREFIX}${encodeURIComponent(chatId)}`)
  url.searchParams.set('user_id_type', 'open_id')
  return url.toString()
}

function searchBody(request: ReturnType<typeof readRequest>): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      filter: {
        time_range: {
          start_time: String(Math.floor(request.startMilliseconds / 1000)),
          end_time: String(Math.ceil(request.endMilliseconds / 1000)),
        },
      },
    }),
  )
  const body = new Uint8Array(encoded.byteLength)
  body.set(encoded)
  zeroBytes(encoded)
  return body
}

/** Fixed-endpoint, read-only Feishu User message search and detail primitive. */
export class FeishuUserMessageSearchHttpClient {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number

  constructor(options?: FeishuUserMessageSearchHttpClientOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
  }

  async search(
    requestValue: FeishuUserMessageSearchHttpRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
    signal.throwIfAborted()
    const request = readRequest(requestValue)
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMilliseconds)
    const body = searchBody(request)
    const authorization = `Bearer ${new TextDecoder().decode(request.accessToken)}`
    try {
      const common = {
        accept: 'application/json',
        authorization,
      }
      const searchData = await requestJson(
        this.#fetch,
        searchUrl(request),
        {
          method: 'POST',
          headers: { ...common, 'content-type': 'application/json; charset=utf-8' },
          body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        },
        controller.signal,
        'search',
        request.pageToken !== undefined,
      )
      const page = parseSearchPage(searchData, request)
      const messages: UnknownRecord[] = []
      const unavailableMessageIds: string[] = []
      for (const index of page.items) {
        signal.throwIfAborted()
        const created = Date.parse(index.createTime)
        const apiStart = Math.floor(request.startMilliseconds / 1000) * 1000
        const apiEnd = Math.ceil(request.endMilliseconds / 1000) * 1000
        if (created < apiStart || created > apiEnd) throw clientError('invalid_response')
        if (created < request.startMilliseconds || created > request.endMilliseconds) continue
        try {
          const detailData = await requestJson(
            this.#fetch,
            detailUrl(index.messageId),
            {
              method: 'GET',
              headers: common,
              cache: 'no-store',
              credentials: 'omit',
              redirect: 'error',
              referrerPolicy: 'no-referrer',
              signal: controller.signal,
            },
            controller.signal,
            'detail',
          )
          let chat: Readonly<{ chatType: 'p2p' | 'group'; chatName?: string }>
          if (index.chatType === undefined) {
            const chatData = await requestJson(
              this.#fetch,
              chatUrl(index.chatId),
              {
                method: 'GET',
                headers: common,
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                signal: controller.signal,
              },
              controller.signal,
              'chat',
            )
            chat = parseChat(chatData)
          } else {
            chat = Object.freeze({ chatType: index.chatType })
          }
          messages.push(parseDetail(detailData, index, chat))
        } catch (error) {
          if (error instanceof MessageDetailUnavailable) {
            unavailableMessageIds.push(index.messageId)
            continue
          }
          throw error
        }
      }
      signal.throwIfAborted()
      return Object.freeze({
        kind: 'feishu_user_message_search_page',
        schemaVersion: FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
        identityType: 'user',
        accountId: request.accountId,
        appId: request.appId,
        tenantKey: request.tenantKey,
        userPrincipalId: request.userPrincipalId,
        messages: Object.freeze(messages),
        unavailableMessageIds: Object.freeze(unavailableMessageIds),
        hasMore: page.hasMore,
        ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
      })
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (timedOut) throw clientError('network')
      if (error instanceof FeishuUserMessageSearchClientError) throw error
      throw clientError('invalid_response')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      zeroBytes(body)
    }
  }
}
