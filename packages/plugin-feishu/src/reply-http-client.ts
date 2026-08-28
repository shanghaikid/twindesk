import { parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import {
  FeishuReplyExecutionClientError,
  type FeishuReplyExecutionClientErrorCode,
} from './reply-execution.ts'
import { FEISHU_REPLY_IDEMPOTENCY_KEY_MAX_CHARACTERS } from './reply-proposal.ts'

export const FEISHU_REPLY_HTTP_RESULT_VERSION = 1 as const
export const FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES = 256 * 1024
export const FEISHU_REPLY_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_REPLY_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

const FEISHU_REPLY_URL_PREFIX = 'https://open.feishu.cn/open-apis/im/v1/messages/' as const
const FEISHU_REPLY_URL_SUFFIX = '/reply' as const
const MAX_REPLY_TEXT_CHARACTERS = 20_000
const MAX_REPLY_TEXT_BYTES = 64 * 1024
const MAX_REQUEST_BODY_BYTES = 512 * 1024
const IDEMPOTENCY_KEY_PATTERN = /^tdfr1:[a-f0-9]{40}$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

const AUTHORIZATION_CODES = new Set([
  10014, 99991543, 99991661, 99991662, 99991663, 99991671, 99991673,
])
const SCOPE_CODES = new Set([99991672, 99991676, 99991679])
const REJECTED_CODES = new Set([230001])
const APPLICATION_ERROR_HTTP_STATUSES = new Set([400, 403, 404, 409, 422])

export interface FeishuReplyHttpRequest {
  readonly targetMessageId: string
  readonly content: string
  readonly idempotencyKey: string
  /** Borrowed caller-owned bytes. The client never mutates this buffer. */
  readonly accessToken: Uint8Array
}

export interface FeishuReplyHttpResult {
  readonly kind: 'feishu_reply_http_result'
  readonly schemaVersion: typeof FEISHU_REPLY_HTTP_RESULT_VERSION
  readonly messageId: string
  readonly sentAt: IsoTimestamp
}

export interface FeishuReplyHttpClientOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMilliseconds?: number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get
const responseHeadersGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'headers')?.get
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body')?.get
const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

function clientError(code: FeishuReplyExecutionClientErrorCode): FeishuReplyExecutionClientError {
  return new FeishuReplyExecutionClientError(code)
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

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(record)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new TypeError()
  }
}

function boundedIdentifier(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function readOptions(value: unknown): Readonly<{
  fetch: typeof fetch
  timeoutMilliseconds: number
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    const expected = ['fetch', 'timeoutMilliseconds'].filter((key) => Object.hasOwn(options, key))
    exactKeys(options, expected)
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_REPLY_HTTP_TIMEOUT_MILLISECONDS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_REPLY_HTTP_MAX_TIMEOUT_MILLISECONDS
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
  targetMessageId: string
  content: string
  idempotencyKey: string
  accessToken: Uint8Array<ArrayBuffer>
}> {
  let contentBytes: Uint8Array | undefined
  try {
    const request = dataRecord(value)
    exactKeys(request, ['targetMessageId', 'content', 'idempotencyKey', 'accessToken'])
    const targetMessageId = boundedIdentifier(request.targetMessageId)
    if (
      typeof request.content !== 'string' ||
      request.content.trim().length === 0 ||
      request.content.length > MAX_REPLY_TEXT_CHARACTERS ||
      request.content.includes('\u0000')
    ) {
      throw new TypeError()
    }
    contentBytes = new TextEncoder().encode(request.content)
    if (contentBytes.byteLength > MAX_REPLY_TEXT_BYTES) throw new TypeError()
    if (
      typeof request.idempotencyKey !== 'string' ||
      request.idempotencyKey.length > FEISHU_REPLY_IDEMPOTENCY_KEY_MAX_CHARACTERS ||
      !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey) ||
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
    return Object.freeze({
      targetMessageId,
      content: request.content,
      idempotencyKey: request.idempotencyKey,
      accessToken: request.accessToken as Uint8Array<ArrayBuffer>,
    })
  } catch {
    throw clientError('invalid_response')
  } finally {
    if (contentBytes !== undefined) zeroBytes(contentBytes)
  }
}

function replyUrl(messageId: string): string {
  return `${FEISHU_REPLY_URL_PREFIX}${encodeURIComponent(messageId)}${FEISHU_REPLY_URL_SUFFIX}`
}

function requestBody(
  request: Readonly<{ content: string; idempotencyKey: string }>,
): Uint8Array<ArrayBuffer> {
  let encoded: Uint8Array | undefined
  try {
    encoded = new TextEncoder().encode(
      JSON.stringify({
        content: JSON.stringify({ text: request.content }),
        msg_type: 'text',
        uuid: request.idempotencyKey,
      }),
    )
    if (encoded.byteLength === 0 || encoded.byteLength > MAX_REQUEST_BODY_BYTES)
      throw new TypeError()
    const bytes = new Uint8Array(encoded.byteLength)
    bytes.set(encoded)
    return bytes
  } catch {
    throw clientError('invalid_response')
  } finally {
    if (encoded !== undefined) zeroBytes(encoded)
  }
}

function contentLength(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-length')
  } catch {
    throw clientError('unknown')
  }
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) throw clientError('unknown')
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES) {
    throw clientError('unknown')
  }
}

function contentType(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-type')
  } catch {
    throw clientError('unknown')
  }
  if (value === null || !/^application\/json(?:\s*;|$)/iu.test(value)) {
    throw clientError('unknown')
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
  if (body === null) throw clientError('unknown')
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw clientError('unknown')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  let pendingChunk: Uint8Array | undefined
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await readChunk(reader, signal)
      pendingChunk = !result.done && result.value instanceof Uint8Array ? result.value : undefined
      signal.throwIfAborted()
      if (result.done) break
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw clientError('unknown')
      }
      if (result.value.byteLength > FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES - total) {
        cancelReader(reader)
        throw clientError('unknown')
      }
      chunks.push(result.value)
      total += result.value.byteLength
      pendingChunk = undefined
    }
    const response = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      response.set(chunk, offset)
      offset += chunk.byteLength
    }
    return response
  } catch (error) {
    cancelReader(reader)
    throw error
  } finally {
    if (pendingChunk !== undefined) zeroBytes(pendingChunk)
    for (const chunk of chunks) zeroBytes(chunk)
    try {
      reader.releaseLock()
    } catch {
      // Cancellation may still be settling a pending read.
    }
  }
}

function hasDuplicateObjectKey(text: string): boolean {
  const objectKeys: Array<Set<string>> = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const current = text[index]
        if (!escaped && current === '"') break
        if (!escaped && current === '\\') escaped = true
        else escaped = false
        index += 1
      }
      if (index >= text.length) return false
      let next = index + 1
      while (/\s/u.test(text[next] ?? '')) next += 1
      const keys = objectKeys.at(-1)
      if (keys !== undefined && text[next] === ':') {
        let key: unknown
        try {
          key = JSON.parse(text.slice(start, index + 1)) as unknown
        } catch {
          return false
        }
        if (typeof key !== 'string') return false
        if (keys.has(key)) return true
        keys.add(key)
      }
    } else if (character === '{') {
      objectKeys.push(new Set())
    } else if (character === '}') {
      objectKeys.pop()
    }
    index += 1
  }
  return false
}

function parseJson(body: Uint8Array): UnknownRecord {
  if (body.byteLength === 0 || body.byteLength > FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES) {
    throw clientError('unknown')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw clientError('unknown')
  }
  if (hasDuplicateObjectKey(text)) throw clientError('unknown')
  try {
    const record = dataRecord(JSON.parse(text) as unknown)
    if (!Number.isSafeInteger(record.code)) throw new TypeError()
    if (typeof record.msg !== 'string' || record.msg.length > 4096) throw new TypeError()
    return record
  } catch (error) {
    if (error instanceof FeishuReplyExecutionClientError) throw error
    throw clientError('unknown')
  }
}

function applicationCodeError(code: number): FeishuReplyExecutionClientError {
  if (code === 99991400) return clientError('rate_limited')
  if (AUTHORIZATION_CODES.has(code)) return clientError('not_authorized')
  if (SCOPE_CODES.has(code)) return clientError('scope_missing')
  if (REJECTED_CODES.has(code)) return clientError('rejected')
  return clientError('unknown')
}

function epochInstant(value: unknown): IsoTimestamp {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) throw clientError('unknown')
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw clientError('unknown')
  try {
    return parseIsoTimestamp(new Date(milliseconds).toISOString())
  } catch {
    throw clientError('unknown')
  }
}

function parseResult(body: Uint8Array): FeishuReplyHttpResult {
  const record = parseJson(body)
  if (record.code !== 0) throw applicationCodeError(record.code as number)
  try {
    exactKeys(record, ['code', 'msg', 'data'])
    const data = dataRecord(record.data)
    return Object.freeze({
      kind: 'feishu_reply_http_result',
      schemaVersion: FEISHU_REPLY_HTTP_RESULT_VERSION,
      messageId: boundedIdentifier(data.message_id),
      sentAt: epochInstant(data.create_time),
    })
  } catch (error) {
    if (error instanceof FeishuReplyExecutionClientError) throw error
    throw clientError('unknown')
  }
}

function httpStatusError(status: number): FeishuReplyExecutionClientError {
  if (status === 401 || status === 403) return clientError('not_authorized')
  if (status === 429) return clientError('rate_limited')
  if ([400, 404, 409, 413, 415, 422].includes(status)) return clientError('rejected')
  return clientError('unknown')
}

/**
 * Production fixed-endpoint primitive for one Feishu plain-text reply.
 *
 * This deliberately does not implement remote reconciliation: Feishu reply
 * history does not expose the request UUID. Callers must compose this primitive
 * under the existing approval, scope, lease, dispatch, and uncertain-result
 * boundaries.
 */
export class FeishuReplyHttpClient {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number

  constructor(options?: FeishuReplyHttpClientOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
  }

  async send(
    requestValue: FeishuReplyHttpRequest,
    signal: AbortSignal,
  ): Promise<FeishuReplyHttpResult> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
    signal.throwIfAborted()
    const request = readRequest(requestValue)
    const body = requestBody(request)
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMilliseconds)
    let responseBody: Uint8Array | undefined
    try {
      let response: Response
      try {
        response = await this.#fetch(replyUrl(request.targetMessageId), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${new TextDecoder().decode(request.accessToken)}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
      } catch {
        if (signal.aborted) signal.throwIfAborted()
        throw clientError('network')
      }
      let status: number
      let headers: Headers
      let stream: ReadableStream<Uint8Array> | null = null
      try {
        if (
          !(response instanceof Response) ||
          responseStatusGetter === undefined ||
          responseHeadersGetter === undefined ||
          responseBodyGetter === undefined
        ) {
          throw new TypeError()
        }
        status = responseStatusGetter.call(response) as unknown as number
        headers = responseHeadersGetter.call(response) as unknown as Headers
        stream = responseBodyGetter.call(response) as unknown as ReadableStream<Uint8Array> | null
        if (
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599 ||
          !(headers instanceof Headers) ||
          (stream !== null && !(stream instanceof ReadableStream))
        ) {
          throw new TypeError()
        }
      } catch {
        await cancelBody(stream)
        throw clientError('unknown')
      }
      if (signal.aborted) {
        await cancelBody(stream)
        signal.throwIfAborted()
      }
      if (status !== 200) {
        const statusError = httpStatusError(status)
        if (APPLICATION_ERROR_HTTP_STATUSES.has(status) && stream !== null) {
          try {
            contentLength(headers)
            contentType(headers)
            responseBody = await boundedBody(stream, controller.signal)
            signal.throwIfAborted()
            if (timedOut) throw clientError('network')
            const record = parseJson(responseBody)
            if (record.code !== 0) {
              const applicationError = applicationCodeError(record.code as number)
              if (applicationError.code !== 'unknown') throw applicationError
            }
          } catch (error) {
            if (signal.aborted) signal.throwIfAborted()
            if (timedOut) throw clientError('network')
            if (responseBody === undefined) await cancelBody(stream)
            if (error instanceof FeishuReplyExecutionClientError && error.code !== 'unknown') {
              throw error
            }
          }
        } else {
          await cancelBody(stream)
        }
        throw statusError
      }
      try {
        contentLength(headers)
        contentType(headers)
      } catch (error) {
        await cancelBody(stream)
        throw error
      }
      responseBody = await boundedBody(stream, controller.signal)
      signal.throwIfAborted()
      if (timedOut) throw clientError('network')
      return parseResult(responseBody)
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (timedOut) throw clientError('network')
      if (error instanceof FeishuReplyExecutionClientError) throw error
      throw clientError('unknown')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      zeroBytes(body)
      if (responseBody !== undefined) zeroBytes(responseBody)
    }
  }
}
