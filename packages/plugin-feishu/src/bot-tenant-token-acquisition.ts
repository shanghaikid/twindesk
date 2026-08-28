import { parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'

export const FEISHU_BOT_TENANT_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' as const
export const FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES = 16 * 1024
export const FEISHU_BOT_TENANT_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60
export const FEISHU_BOT_TENANT_TOKEN_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_BOT_TENANT_TOKEN_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

export type FeishuBotTenantTokenAcquisitionErrorCode =
  | 'invalid_client'
  | 'invalid_request'
  | 'invalid_response'
  | 'configuration_invalid'
  | 'retry_later'
  | 'invalid_clock'

export type FeishuBotTenantTokenRetryDisposition =
  'do_not_retry' | 'repair_configuration' | 'retry_later'

export class FeishuBotTenantTokenAcquisitionError extends Error {
  readonly code: FeishuBotTenantTokenAcquisitionErrorCode
  readonly retryDisposition: FeishuBotTenantTokenRetryDisposition

  constructor(
    code: FeishuBotTenantTokenAcquisitionErrorCode,
    retryDisposition: FeishuBotTenantTokenRetryDisposition,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuBotTenantTokenAcquisitionError'
    this.code = code
    this.retryDisposition = retryDisposition
  }
}

export interface FeishuBotTenantTokenAcquisitionInput {
  readonly appId: string
  readonly appSecret: Uint8Array
}

export interface FeishuBotTenantToken {
  readonly tokenType: 'Bearer'
  readonly accessToken: Uint8Array
  readonly obtainedAt: IsoTimestamp
  readonly expiresAt: IsoTimestamp
}

export interface FeishuBotTenantTokenAcquirerOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMilliseconds?: number
  /** Trusted local clock sampled only after a successful response is received. */
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get
const responseHeadersGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'headers')?.get
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body')?.get
const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

function fail(
  code: FeishuBotTenantTokenAcquisitionErrorCode,
  retryDisposition: FeishuBotTenantTokenRetryDisposition,
  message: string,
): FeishuBotTenantTokenAcquisitionError {
  return new FeishuBotTenantTokenAcquisitionError(code, retryDisposition, message)
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

function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function readOptions(value: unknown): Readonly<{
  fetch: typeof fetch
  timeoutMilliseconds: number
  now: () => number
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    const expected = ['fetch', 'timeoutMilliseconds', 'now'].filter((key) =>
      Object.hasOwn(options, key),
    )
    exactKeys(options, expected)
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_BOT_TENANT_TOKEN_HTTP_TIMEOUT_MILLISECONDS
    const now = Object.hasOwn(options, 'now') ? options.now : Date.now
    if (
      typeof fetchImplementation !== 'function' ||
      typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_BOT_TENANT_TOKEN_HTTP_MAX_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      fetch: fetchImplementation as typeof fetch,
      timeoutMilliseconds: timeoutMilliseconds as number,
      now: now as () => number,
    })
  } catch {
    throw fail('invalid_client', 'do_not_retry', 'The Feishu Bot tenant-token client is invalid.')
  }
}

function readInput(value: unknown): Readonly<{
  appId: string
  appSecret: Uint8Array<ArrayBuffer>
}> {
  try {
    const input = dataRecord(value)
    exactKeys(input, ['appId', 'appSecret'])
    const appId = boundedString(input.appId, 128)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(appId) ||
      !(input.appSecret instanceof Uint8Array) ||
      !(input.appSecret.buffer instanceof ArrayBuffer) ||
      input.appSecret.byteLength === 0 ||
      input.appSecret.byteLength > 512
    ) {
      throw new TypeError()
    }
    for (let index = 0; index < input.appSecret.byteLength; index += 1) {
      const byte = input.appSecret[index] as number
      if (byte < 0x21 || byte > 0x7e) throw new TypeError()
    }
    return Object.freeze({
      appId,
      appSecret: input.appSecret as Uint8Array<ArrayBuffer>,
    })
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu Bot tenant-token request is invalid.')
  }
}

function escapedJsonSecretLength(value: Uint8Array): number {
  let length = value.byteLength
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value[index]
    if (byte === 0x22 || byte === 0x5c) length += 1
  }
  return length
}

function requestBody(
  input: Readonly<{ appId: string; appSecret: Uint8Array }>,
): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`{"app_id":${JSON.stringify(input.appId)},"app_secret":"`)
  const suffix = new TextEncoder().encode('"}')
  const body = new Uint8Array(
    prefix.byteLength + escapedJsonSecretLength(input.appSecret) + suffix.byteLength,
  )
  body.set(prefix)
  let offset = prefix.byteLength
  for (let index = 0; index < input.appSecret.byteLength; index += 1) {
    const byte = input.appSecret[index] as number
    if (byte === 0x22 || byte === 0x5c) body[offset++] = 0x5c
    body[offset++] = byte
  }
  body.set(suffix, offset)
  zeroBytes(prefix)
  zeroBytes(suffix)
  return body
}

function contentLength(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-length')
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is too large.')
  }
}

function contentType(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-type')
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
  if (value === null || !/^application\/json(?:\s*;|$)/iu.test(value)) {
    throw fail(
      'invalid_response',
      'do_not_retry',
      'The Feishu tenant-token response type is invalid.',
    )
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
  if (body === null) return new Uint8Array()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token stream is invalid.')
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
        throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token stream is invalid.')
      }
      if (result.value.byteLength > FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES - total) {
        cancelReader(reader)
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu tenant-token response is too large.',
        )
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

function readClock(now: () => number): number {
  let value: number
  try {
    value = now()
  } catch {
    throw fail('invalid_clock', 'do_not_retry', 'The Feishu tenant-token clock is invalid.')
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw fail('invalid_clock', 'do_not_retry', 'The Feishu tenant-token clock is invalid.')
  }
  return value
}

function expiresAt(observedAt: number, seconds: unknown): IsoTimestamp {
  if (
    !Number.isSafeInteger(seconds) ||
    (seconds as number) <= 0 ||
    (seconds as number) > FEISHU_BOT_TENANT_TOKEN_MAX_LIFETIME_SECONDS
  ) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token lifetime is invalid.')
  }
  const value = observedAt + (seconds as number) * 1000
  if (!Number.isSafeInteger(value) || value > 8_640_000_000_000_000) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token lifetime is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(value).toISOString())
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token lifetime is invalid.')
  }
}

function errorForCode(code: number): FeishuBotTenantTokenAcquisitionError {
  if (code === 99991400) {
    return fail(
      'retry_later',
      'retry_later',
      'The Feishu tenant-token service is temporarily rate limited.',
    )
  }
  if ([10014, 99991543, 99991662, 99991673].includes(code)) {
    return fail(
      'configuration_invalid',
      'repair_configuration',
      'The Feishu Bot application credentials were rejected.',
    )
  }
  return fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token request was rejected.')
}

function parseResponse(body: Uint8Array, observedAt: number): FeishuBotTenantToken {
  if (body.byteLength === 0 || body.byteLength > FEISHU_BOT_TENANT_TOKEN_RESPONSE_MAX_BYTES) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw fail(
      'invalid_response',
      'do_not_retry',
      'The Feishu tenant-token response encoding is invalid.',
    )
  }
  if (hasDuplicateObjectKey(text)) {
    throw fail(
      'invalid_response',
      'do_not_retry',
      'The Feishu tenant-token response has duplicate fields.',
    )
  }
  let record: UnknownRecord
  try {
    record = dataRecord(JSON.parse(text) as unknown)
    if (!Number.isSafeInteger(record.code)) throw new TypeError()
    boundedString(record.msg, 2048)
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
  if (record.code !== 0) {
    const keys = Object.keys(record)
    if (!(
      (keys.length === 2 && keys.includes('code') && keys.includes('msg')) ||
      (keys.length === 3 && keys.includes('code') && keys.includes('msg') && keys.includes('error'))
    )) {
      throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
    }
    throw errorForCode(record.code as number)
  }
  try {
    exactKeys(record, ['code', 'msg', 'tenant_access_token', 'expire'])
    const tokenText = boundedString(record.tenant_access_token, FEISHU_OAUTH_TOKEN_MAX_LENGTH)
    for (let index = 0; index < tokenText.length; index += 1) {
      const code = tokenText.charCodeAt(index)
      if (code < 0x21 || code > 0x7e) throw new TypeError()
    }
    return Object.freeze({
      tokenType: 'Bearer',
      accessToken: new TextEncoder().encode(tokenText),
      obtainedAt: parseIsoTimestamp(new Date(observedAt).toISOString()),
      expiresAt: expiresAt(observedAt, record.expire),
    })
  } catch (error) {
    if (error instanceof FeishuBotTenantTokenAcquisitionError) throw error
    throw fail('invalid_response', 'do_not_retry', 'The Feishu tenant-token response is invalid.')
  }
}

function zeroToken(token: FeishuBotTenantToken | undefined): void {
  if (token !== undefined) zeroBytes(token.accessToken)
}

/**
 * Production Fetch boundary for Feishu's fixed internal tenant-token endpoint.
 * The request body, response bytes, and returned token are callback-scoped.
 * The caller retains ownership of the borrowed application-secret buffer and
 * must bound and clear it. Acquiring a token is identity authentication only;
 * it does not prove that any Bot operation scope is currently granted.
 */
export class FeishuBotTenantTokenAcquirer {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number
  readonly #now: () => number

  constructor(options?: FeishuBotTenantTokenAcquirerOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
    this.#now = validated.now
  }

  async acquire<TResult>(
    inputValue: FeishuBotTenantTokenAcquisitionInput,
    signal: AbortSignal,
    use: (token: FeishuBotTenantToken) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    if (!(signal instanceof AbortSignal)) {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu tenant-token signal is invalid.')
    }
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu tenant-token consumer is invalid.')
    }
    const input = readInput(inputValue)
    const body = requestBody(input)
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMilliseconds)
    let responseBody: Uint8Array | undefined
    let token: FeishuBotTenantToken | undefined
    let consuming = false
    try {
      let response: Response
      try {
        response = await this.#fetch(FEISHU_BOT_TENANT_TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
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
        if (timedOut) {
          throw fail('retry_later', 'retry_later', 'The Feishu tenant-token request timed out.')
        }
        throw fail('retry_later', 'retry_later', 'The Feishu tenant-token request failed.')
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
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu tenant-token response is invalid.',
        )
      }
      if (signal.aborted) {
        await cancelBody(stream)
        signal.throwIfAborted()
      }
      if (status >= 300 && status <= 399) {
        await cancelBody(stream)
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu tenant-token redirect was rejected.',
        )
      }
      if (status === 429 || status >= 500) {
        await cancelBody(stream)
        throw fail(
          'retry_later',
          'retry_later',
          'The Feishu tenant-token service is temporarily unavailable.',
        )
      }
      if (status !== 200) {
        await cancelBody(stream)
        if (status === 400 || status === 401 || status === 403) {
          throw fail(
            'configuration_invalid',
            'repair_configuration',
            'The Feishu Bot application credentials were rejected.',
          )
        }
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu tenant-token HTTP response is invalid.',
        )
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
      if (timedOut) {
        throw fail('retry_later', 'retry_later', 'The Feishu tenant-token request timed out.')
      }
      token = parseResponse(responseBody, readClock(this.#now))
      signal.throwIfAborted()
      clearTimeout(timeout)
      consuming = true
      // Once the consumer reports success, its result is authoritative. A
      // post-callback cancellation must not turn completed work into an
      // apparent acquisition failure that invites an unsafe retry.
      return await use(token)
    } catch (error) {
      if (consuming) throw error
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof FeishuBotTenantTokenAcquisitionError) throw error
      if (timedOut) {
        throw fail('retry_later', 'retry_later', 'The Feishu tenant-token request timed out.')
      }
      throw fail('retry_later', 'retry_later', 'The Feishu tenant-token request failed.')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      zeroBytes(body)
      if (responseBody !== undefined) zeroBytes(responseBody)
      zeroToken(token)
    }
  }
}
