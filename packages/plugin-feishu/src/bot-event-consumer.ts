import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import type { JsonValue } from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_BOT_MESSAGE_EVENT_VERSION = 1 as const
export const FEISHU_BOT_RECEIPT_VERSION = 1 as const

const FEISHU_MESSAGE_EVENT_TYPE = 'im.message.receive_v1'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_RECEIPT_STORE_BYTES = 32 * 1024 * 1024
const DEFAULT_SIGNATURE_AGE_MS = 5 * 60 * 1000
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

type UnknownRecord = Readonly<Record<string, unknown>>

export type FeishuBotEventErrorCode =
  | 'invalid_request'
  | 'invalid_signature'
  | 'stale_request'
  | 'invalid_event'
  | 'identity_mismatch'
  | 'receipt_conflict'
  | 'invalid_store_path'
  | 'unsafe_file'
  | 'receipt_store_too_large'
  | 'downstream_failure'
  | 'io_error'

export class FeishuBotEventError extends Error {
  readonly code: FeishuBotEventErrorCode

  constructor(code: FeishuBotEventErrorCode, message: string) {
    super(message)
    this.name = 'FeishuBotEventError'
    this.code = code
  }
}

export interface FeishuBotMention {
  readonly key: string
  readonly principalId: string
}

/** A verified, in-memory Bot message. Raw callback bodies are never persisted here. */
export interface FeishuBotMessageEvent {
  readonly kind: 'feishu_bot_message_event'
  readonly schemaVersion: typeof FEISHU_BOT_MESSAGE_EVENT_VERSION
  readonly accountId: string
  readonly appId: string
  readonly tenantKey: string
  readonly botPrincipalId: string
  readonly deliveryEventId: string
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly visibility: 'direct_message' | 'bot_mention'
  readonly senderPrincipalId: string
  readonly messageType: string
  readonly sourceCreateTime: string
  readonly content: JsonValue
  readonly mentions: readonly FeishuBotMention[]
  readonly rootMessageId?: string
  readonly parentMessageId?: string
  readonly threadId?: string
}

export type FeishuBotEventResult =
  | Readonly<{ status: 'accepted'; event: FeishuBotMessageEvent }>
  | Readonly<{ status: 'duplicate' }>
  | Readonly<{ status: 'ignored'; reason: 'group_message_without_bot_mention' }>

type ParsedFeishuBotEventResult = Exclude<FeishuBotEventResult, Readonly<{ status: 'duplicate' }>>

interface ReceiptRecord {
  readonly kind: 'feishu_bot_message_receipt'
  readonly schemaVersion: typeof FEISHU_BOT_RECEIPT_VERSION
  readonly messageKeyDigest: string
  readonly eventDigest: string
  readonly receivedAt: string
}

interface ReceiptStoreState {
  receipts: Map<string, string>
  loaded: boolean
  queue: Promise<void>
}

const RECEIPT_STORE_STATES = new Map<string, ReceiptStoreState>()

function fail(code: FeishuBotEventErrorCode, message: string): FeishuBotEventError {
  return new FeishuBotEventError(code, message)
}

function dataRecord(
  value: unknown,
  code: FeishuBotEventErrorCode = 'invalid_event',
): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail(code, 'The Feishu event data is invalid.')
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail(code, 'The Feishu event data must be plain data.')
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw fail(code, 'The Feishu event data has unsupported fields.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
      throw fail(code, 'The Feishu event data must contain data values.')
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof FeishuBotEventError) throw error
    throw fail(code, 'The Feishu event data is invalid.')
  }
}

function boundedString(
  value: unknown,
  message: string,
  maximum = 512,
  pattern: RegExp = /^[^\u0000-\u001f\u007f]+$/u,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw fail('invalid_event', message)
  }
  return value
}

function optionalIdentifier(value: unknown, message: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, message)
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw fail('invalid_event', message)
  }
}

function parseJsonValue(raw: string, message: string): JsonValue {
  const parsed = parseJson(raw, message)
  let nodes = 0
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1
    if (depth > 64 || nodes > 100_000) throw fail('invalid_event', message)
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw fail('invalid_event', message)
      return value
    }
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => visit(entry, depth + 1)))
    }
    const record = dataRecord(value)
    return Object.freeze(
      Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [key, visit(entry, depth + 1)]),
      ),
    ) as Readonly<Record<string, JsonValue>>
  }
  return visit(parsed, 0)
}

function decryptEnvelope(encrypted: string, encryptionKey: string): unknown {
  try {
    const payload = Buffer.from(encrypted, 'base64')
    if (payload.length <= 16 || (payload.length - 16) % 16 !== 0) {
      throw new Error('invalid encrypted event')
    }
    const key = createHash('sha256').update(encryptionKey).digest()
    const decipher = createDecipheriv('aes-256-cbc', key, payload.subarray(0, 16))
    const plaintext = Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()])
    return parseJson(UTF8_DECODER.decode(plaintext), 'The encrypted Feishu event is invalid.')
  } catch (error) {
    if (error instanceof FeishuBotEventError) throw error
    throw fail('invalid_event', 'The encrypted Feishu event is invalid.')
  }
}

function parseBody(rawBody: Buffer, encryptionKey: string): UnknownRecord {
  let decoded: string
  try {
    decoded = UTF8_DECODER.decode(rawBody)
  } catch {
    throw fail('invalid_event', 'The Feishu event body is not valid UTF-8.')
  }
  const envelope = dataRecord(parseJson(decoded, 'The Feishu event body is invalid JSON.'))
  if (Object.hasOwn(envelope, 'encrypt')) {
    const encrypted = boundedString(
      envelope.encrypt,
      'The encrypted Feishu event is invalid.',
      MAX_BODY_BYTES,
      /^[A-Za-z0-9+/]+={0,2}$/u,
    )
    return dataRecord(decryptEnvelope(encrypted, encryptionKey))
  }
  return envelope
}

function parseHeaders(value: unknown): Readonly<{
  timestamp: string
  nonce: string
  signature: string
}> {
  const record = dataRecord(value, 'invalid_request')
  const selected = new Map<string, string>()
  for (const [key, headerValue] of Object.entries(record)) {
    const normalized = key.toLowerCase()
    if (
      !['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature'].includes(normalized)
    ) {
      continue
    }
    if (selected.has(normalized) || typeof headerValue !== 'string') {
      throw fail('invalid_request', 'The Feishu signature headers are invalid.')
    }
    selected.set(normalized, headerValue)
  }
  const timestamp = selected.get('x-lark-request-timestamp')
  const nonce = selected.get('x-lark-request-nonce')
  const signature = selected.get('x-lark-signature')
  if (
    timestamp === undefined ||
    !/^[0-9]{9,12}$/u.test(timestamp) ||
    nonce === undefined ||
    nonce.length === 0 ||
    nonce.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(nonce) ||
    signature === undefined ||
    !/^[a-fA-F0-9]{64}$/u.test(signature)
  ) {
    throw fail('invalid_request', 'The Feishu signature headers are invalid.')
  }
  return Object.freeze({ timestamp, nonce, signature: signature.toLowerCase() })
}

function rawRequest(value: unknown): Readonly<{ headers: unknown; rawBody: Buffer }> {
  const record = dataRecord(value, 'invalid_request')
  if (Object.keys(record).some((key) => !['headers', 'rawBody'].includes(key))) {
    throw fail('invalid_request', 'The Feishu event request has unsupported fields.')
  }
  let rawBody: Buffer
  try {
    if (typeof record.rawBody === 'string') {
      rawBody = Buffer.from(record.rawBody, 'utf8')
    } else if (record.rawBody instanceof Uint8Array) {
      rawBody = Buffer.from(record.rawBody)
    } else {
      throw fail('invalid_request', 'The Feishu event request body is invalid.')
    }
  } catch (error) {
    if (error instanceof FeishuBotEventError) throw error
    throw fail('invalid_request', 'The Feishu event request body is invalid.')
  }
  if (rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) {
    throw fail('invalid_request', 'The Feishu event request body has an invalid size.')
  }
  return Object.freeze({ headers: record.headers, rawBody })
}

function verifySignature(
  request: Readonly<{ headers: unknown; rawBody: Buffer }>,
  encryptionKey: string,
  now: number,
  maximumSignatureAgeMs: number,
): void {
  const headers = parseHeaders(request.headers)
  const timestampSeconds = Number(headers.timestamp)
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(now - timestampSeconds * 1000) > maximumSignatureAgeMs
  ) {
    throw fail(
      'stale_request',
      'The Feishu event signature timestamp is outside the allowed window.',
    )
  }
  const expected = createHash('sha256')
    .update(headers.timestamp)
    .update(headers.nonce)
    .update(encryptionKey)
    .update(request.rawBody)
    .digest()
  const received = Buffer.from(headers.signature, 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw fail('invalid_signature', 'The Feishu event signature is invalid.')
  }
}

function parseMentions(value: unknown): readonly FeishuBotMention[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 100) {
    throw fail('invalid_event', 'The Feishu message mentions are invalid.')
  }
  return Object.freeze(
    value.map((entry) => {
      const mention = dataRecord(entry)
      const identifier = dataRecord(mention.id)
      return Object.freeze({
        key: boundedString(mention.key, 'A Feishu message mention key is invalid.', 128),
        principalId: boundedString(
          identifier.open_id,
          'A Feishu message mention principal is invalid.',
        ),
      })
    }),
  )
}

function parseMessageEvent(
  body: UnknownRecord,
  configuration: FeishuIdentityConfiguration,
  expectedTenantKey: string,
): ParsedFeishuBotEventResult {
  if (body.schema !== '2.0') {
    throw fail('invalid_event', 'Only Feishu version 2 events are supported.')
  }
  const header = dataRecord(body.header)
  if (header.event_type !== FEISHU_MESSAGE_EVENT_TYPE) {
    throw fail('invalid_event', 'The Feishu event type is not supported by this consumer.')
  }
  if (header.app_id !== configuration.appId) {
    throw fail('identity_mismatch', 'The Feishu event application does not match the Bot identity.')
  }
  if (header.tenant_key !== expectedTenantKey) {
    throw fail('identity_mismatch', 'The Feishu event tenant does not match the Bot identity.')
  }
  const bot = configuration.bot
  if (bot === undefined) {
    throw fail('identity_mismatch', 'A Feishu Bot identity is required for Bot events.')
  }
  const event = dataRecord(body.event)
  const sender = dataRecord(event.sender)
  const senderId = dataRecord(sender.sender_id)
  const message = dataRecord(event.message)
  const chatType = boundedString(message.chat_type, 'The Feishu message chat type is invalid.', 16)
  if (chatType !== 'p2p' && chatType !== 'group') {
    throw fail('invalid_event', 'The Feishu message chat type is not supported.')
  }
  const mentions = parseMentions(message.mentions)
  const isBotMention = mentions.some((mention) => mention.principalId === bot.principalId)
  if (chatType === 'group' && !isBotMention) {
    return Object.freeze({ status: 'ignored', reason: 'group_message_without_bot_mention' })
  }
  const contentText = boundedString(
    message.content,
    'The Feishu message content is invalid.',
    MAX_BODY_BYTES,
    /^[\s\S]+$/u,
  )
  const content = parseJsonValue(contentText, 'The Feishu message content is invalid JSON.')
  const rootMessageId = optionalIdentifier(
    message.root_id,
    'The Feishu root message identity is invalid.',
  )
  const parentMessageId = optionalIdentifier(
    message.parent_id,
    'The Feishu parent message identity is invalid.',
  )
  const threadId = optionalIdentifier(message.thread_id, 'The Feishu thread identity is invalid.')
  const normalized: FeishuBotMessageEvent = {
    kind: 'feishu_bot_message_event',
    schemaVersion: FEISHU_BOT_MESSAGE_EVENT_VERSION,
    accountId: configuration.accountId,
    appId: configuration.appId,
    tenantKey: expectedTenantKey,
    botPrincipalId: bot.principalId,
    deliveryEventId: boundedString(
      header.event_id,
      'The Feishu delivery event identity is invalid.',
    ),
    messageId: boundedString(message.message_id, 'The Feishu message identity is invalid.'),
    chatId: boundedString(message.chat_id, 'The Feishu chat identity is invalid.'),
    chatType,
    visibility: chatType === 'p2p' ? 'direct_message' : 'bot_mention',
    senderPrincipalId: boundedString(senderId.open_id, 'The Feishu sender principal is invalid.'),
    messageType: boundedString(message.message_type, 'The Feishu message type is invalid.', 128),
    sourceCreateTime: boundedString(
      message.create_time,
      'The Feishu message creation time is invalid.',
      32,
      /^[0-9]+$/u,
    ),
    content,
    mentions,
    ...(rootMessageId === undefined ? {} : { rootMessageId }),
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(threadId === undefined ? {} : { threadId }),
  }
  return Object.freeze({ status: 'accepted', event: Object.freeze(normalized) })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`)
    .join(',')}}`
}

function receiptDigests(event: FeishuBotMessageEvent): Readonly<{
  messageKeyDigest: string
  eventDigest: string
}> {
  const messageKeyDigest = digest(
    JSON.stringify([event.accountId, event.appId, event.tenantKey, event.messageId]),
  )
  const eventDigest = digest(
    JSON.stringify([
      event.accountId,
      event.appId,
      event.tenantKey,
      event.botPrincipalId,
      event.messageId,
      event.chatId,
      event.chatType,
      event.visibility,
      event.senderPrincipalId,
      event.messageType,
      event.sourceCreateTime,
      canonicalJson(event.content),
      [...event.mentions]
        .map((mention) => [mention.key, mention.principalId] as const)
        .sort(([leftKey, leftPrincipal], [rightKey, rightPrincipal]) => {
          const left = `${leftKey}\u0000${leftPrincipal}`
          const right = `${rightKey}\u0000${rightPrincipal}`
          return left < right ? -1 : left > right ? 1 : 0
        }),
      event.rootMessageId ?? null,
      event.parentMessageId ?? null,
      event.threadId ?? null,
    ]),
  )
  return Object.freeze({ messageKeyDigest, eventDigest })
}

function parseReceipt(value: unknown): ReceiptRecord {
  const record = dataRecord(value, 'unsafe_file')
  if (
    record.kind !== 'feishu_bot_message_receipt' ||
    record.schemaVersion !== FEISHU_BOT_RECEIPT_VERSION ||
    Object.keys(record).some(
      (key) =>
        !['kind', 'schemaVersion', 'messageKeyDigest', 'eventDigest', 'receivedAt'].includes(key),
    ) ||
    typeof record.messageKeyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.messageKeyDigest) ||
    typeof record.eventDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.eventDigest) ||
    !isCanonicalInstant(record.receivedAt)
  ) {
    throw fail('unsafe_file', 'The Feishu Bot receipt store contains invalid data.')
  }
  return Object.freeze({
    kind: 'feishu_bot_message_receipt',
    schemaVersion: FEISHU_BOT_RECEIPT_VERSION,
    messageKeyDigest: record.messageKeyDigest,
    eventDigest: record.eventDigest,
    receivedAt: record.receivedAt,
  })
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function receiptStorePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw fail('invalid_store_path', 'The Feishu Bot receipt store path is invalid.')
  }
  return resolve(value)
}

function receiptStoreState(filePath: string): ReceiptStoreState {
  const existing = RECEIPT_STORE_STATES.get(filePath)
  if (existing !== undefined) return existing
  const created: ReceiptStoreState = {
    receipts: new Map(),
    loaded: false,
    queue: Promise.resolve(),
  }
  RECEIPT_STORE_STATES.set(filePath, created)
  return created
}

/**
 * Append-only, restart-durable message receipts. Only hashes and receive times are stored.
 * Instances sharing one resolved path serialize duplicate delivery in this Node.js process.
 */
export class FeishuBotEventReceiptStore {
  readonly #filePath: string
  readonly #state: ReceiptStoreState

  constructor(filePath: string) {
    this.#filePath = receiptStorePath(filePath)
    this.#state = receiptStoreState(this.#filePath)
  }

  #serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#state.queue.then(operation, operation)
    this.#state.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #load(): Promise<void> {
    if (this.#state.loaded) return
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      try {
        handle = await open(this.#filePath, constants.O_RDWR | constants.O_NOFOLLOW)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          this.#state.receipts = new Map()
          this.#state.loaded = true
          return
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ELOOP'
        ) {
          throw fail('unsafe_file', 'The Feishu Bot receipt store is not a regular file.')
        }
        throw error
      }
      const stats = await handle.stat()
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw fail('unsafe_file', 'The Feishu Bot receipt store is not a private regular file.')
      }
      if (stats.size > MAX_RECEIPT_STORE_BYTES) {
        throw fail('receipt_store_too_large', 'The Feishu Bot receipt store is too large.')
      }
      let document = await handle.readFile()
      if (document.length > 0 && document.at(-1) !== 0x0a) {
        const lastLineEnd = document.lastIndexOf(0x0a)
        const repairedLength = lastLineEnd < 0 ? 0 : lastLineEnd + 1
        await handle.truncate(repairedLength)
        await handle.sync()
        document = document.subarray(0, repairedLength)
      }
      const lines = document.toString('utf8').split('\n')
      lines.pop()
      const loadedReceipts = new Map<string, string>()
      for (const line of lines) {
        if (line.length === 0) {
          throw fail('unsafe_file', 'The Feishu Bot receipt store contains invalid data.')
        }
        let receipt: ReceiptRecord
        try {
          receipt = parseReceipt(JSON.parse(line) as unknown)
        } catch (error) {
          if (error instanceof FeishuBotEventError) throw error
          throw fail('unsafe_file', 'The Feishu Bot receipt store contains invalid data.')
        }
        const existing = loadedReceipts.get(receipt.messageKeyDigest)
        if (existing !== undefined && existing !== receipt.eventDigest) {
          throw fail('unsafe_file', 'The Feishu Bot receipt store contains conflicting data.')
        }
        loadedReceipts.set(receipt.messageKeyDigest, receipt.eventDigest)
      }
      this.#state.receipts = loadedReceipts
      this.#state.loaded = true
    } catch (error) {
      if (error instanceof FeishuBotEventError) throw error
      throw fail('io_error', 'The Feishu Bot receipt store could not be read.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #append(receipt: ReceiptRecord): Promise<void> {
    const document = `${JSON.stringify(receipt)}\n`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 })
      try {
        handle = await open(
          this.#filePath,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ELOOP'
        ) {
          throw fail('unsafe_file', 'The Feishu Bot receipt store is not a regular file.')
        }
        throw error
      }
      const stats = await handle.stat()
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw fail('unsafe_file', 'The Feishu Bot receipt store is not a private regular file.')
      }
      if (stats.size + Buffer.byteLength(document) > MAX_RECEIPT_STORE_BYTES) {
        throw fail('receipt_store_too_large', 'The Feishu Bot receipt store is too large.')
      }
      await handle.writeFile(document, 'utf8')
      await handle.sync()
    } catch (error) {
      if (error instanceof FeishuBotEventError) throw error
      throw fail('io_error', 'The Feishu Bot receipt could not be committed.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async consumeOnce(
    messageKeyDigest: string,
    eventDigest: string,
    receivedAt: string,
    handler: () => Promise<void>,
  ): Promise<'accepted' | 'duplicate'> {
    if (
      typeof messageKeyDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(messageKeyDigest) ||
      typeof eventDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(eventDigest) ||
      !isCanonicalInstant(receivedAt) ||
      typeof handler !== 'function'
    ) {
      throw fail('invalid_request', 'The Feishu Bot receipt operation is invalid.')
    }
    return this.#serialize(async () => {
      await this.#load()
      const existing = this.#state.receipts.get(messageKeyDigest)
      if (existing !== undefined) {
        if (existing !== eventDigest) {
          throw fail('receipt_conflict', 'A Feishu message identity was reused with new content.')
        }
        return 'duplicate'
      }
      try {
        await handler()
      } catch {
        throw fail('downstream_failure', 'The verified Feishu event was not durably consumed.')
      }
      const receipt: ReceiptRecord = Object.freeze({
        kind: 'feishu_bot_message_receipt',
        schemaVersion: FEISHU_BOT_RECEIPT_VERSION,
        messageKeyDigest,
        eventDigest,
        receivedAt,
      })
      await this.#append(receipt)
      this.#state.receipts.set(messageKeyDigest, eventDigest)
      return 'accepted'
    })
  }
}

export class FeishuBotEventConsumer {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #encryptionKey: string
  readonly #receiptStore: FeishuBotEventReceiptStore
  readonly #tenantKey: string
  readonly #now: () => number
  readonly #maximumSignatureAgeMs: number

  constructor(
    configuration: unknown,
    encryptionKey: string,
    receiptStore: FeishuBotEventReceiptStore,
    options: Readonly<{
      tenantKey: string
      now?: () => number
      maximumSignatureAgeMs?: number
    }>,
  ) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    if (this.#configuration.bot === undefined) {
      throw fail('identity_mismatch', 'A Feishu Bot identity is required for Bot events.')
    }
    if (
      typeof encryptionKey !== 'string' ||
      encryptionKey.length === 0 ||
      encryptionKey.length > 4096
    ) {
      throw fail('invalid_request', 'The Feishu event encryption key is invalid.')
    }
    if (!(receiptStore instanceof FeishuBotEventReceiptStore)) {
      throw fail('invalid_request', 'The Feishu Bot receipt store is invalid.')
    }
    const optionRecord = dataRecord(options, 'invalid_request')
    if (
      Object.keys(optionRecord).some(
        (key) => !['tenantKey', 'now', 'maximumSignatureAgeMs'].includes(key),
      ) ||
      typeof optionRecord.tenantKey !== 'string' ||
      optionRecord.tenantKey.length === 0 ||
      optionRecord.tenantKey.length > 512 ||
      optionRecord.tenantKey.trim() !== optionRecord.tenantKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(optionRecord.tenantKey)
    ) {
      throw fail('invalid_request', 'The Feishu Bot consumer options are invalid.')
    }
    const now = optionRecord.now === undefined ? Date.now : optionRecord.now
    const maximumSignatureAgeMs =
      optionRecord.maximumSignatureAgeMs === undefined
        ? DEFAULT_SIGNATURE_AGE_MS
        : optionRecord.maximumSignatureAgeMs
    if (
      typeof now !== 'function' ||
      typeof maximumSignatureAgeMs !== 'number' ||
      !Number.isSafeInteger(maximumSignatureAgeMs) ||
      maximumSignatureAgeMs <= 0 ||
      maximumSignatureAgeMs > 60 * 60 * 1000
    ) {
      throw fail('invalid_request', 'The Feishu Bot consumer options are invalid.')
    }
    this.#encryptionKey = encryptionKey
    this.#receiptStore = receiptStore
    this.#tenantKey = optionRecord.tenantKey
    this.#now = now as () => number
    this.#maximumSignatureAgeMs = maximumSignatureAgeMs
  }

  async consume(
    value: unknown,
    handler: (event: FeishuBotMessageEvent) => Promise<void>,
  ): Promise<FeishuBotEventResult> {
    if (typeof handler !== 'function') {
      throw fail('invalid_request', 'A Feishu Bot event handler is required.')
    }
    const request = rawRequest(value)
    let now: number
    try {
      now = this.#now()
    } catch {
      throw fail('invalid_request', 'The Feishu Bot consumer clock is invalid.')
    }
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
      throw fail('invalid_request', 'The Feishu Bot consumer clock is invalid.')
    }
    verifySignature(request, this.#encryptionKey, now, this.#maximumSignatureAgeMs)
    const parsed = parseMessageEvent(
      parseBody(request.rawBody, this.#encryptionKey),
      this.#configuration,
      this.#tenantKey,
    )
    if (parsed.status === 'ignored') return parsed
    const hashes = receiptDigests(parsed.event)
    const disposition = await this.#receiptStore.consumeOnce(
      hashes.messageKeyDigest,
      hashes.eventDigest,
      new Date(now).toISOString(),
      () => handler(parsed.event),
    )
    return disposition === 'duplicate' ? Object.freeze({ status: 'duplicate' }) : parsed
  }
}
