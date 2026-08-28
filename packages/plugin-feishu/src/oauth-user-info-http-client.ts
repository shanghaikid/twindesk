import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import {
  FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_USER_INFO_URL,
  FeishuOAuthUserPrincipalVerificationError,
  type FeishuOAuthUserInfoClient,
  type FeishuOAuthUserInfoRequest,
  type FeishuOAuthUserInfoResponse,
  type FeishuOAuthUserPrincipalVerificationErrorCode,
} from './oauth-user-principal-verifier.ts'

export const FEISHU_OAUTH_USER_INFO_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_OAUTH_USER_INFO_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

export interface FeishuOAuthUserInfoHttpClientOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMilliseconds?: number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get
const responseHeadersGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'headers')?.get
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body')?.get

function fail(
  code: FeishuOAuthUserPrincipalVerificationErrorCode,
  message: string,
): FeishuOAuthUserPrincipalVerificationError {
  return new FeishuOAuthUserPrincipalVerificationError(code, message)
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

function readOptions(value: unknown): Readonly<{
  fetch: typeof fetch
  timeoutMilliseconds: number
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    const expected = Object.hasOwn(options, 'fetch')
      ? Object.hasOwn(options, 'timeoutMilliseconds')
        ? ['fetch', 'timeoutMilliseconds']
        : ['fetch']
      : Object.hasOwn(options, 'timeoutMilliseconds')
        ? ['timeoutMilliseconds']
        : []
    exactKeys(options, expected)
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_OAUTH_USER_INFO_HTTP_TIMEOUT_MILLISECONDS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_OAUTH_USER_INFO_HTTP_MAX_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      fetch: fetchImplementation as typeof fetch,
      timeoutMilliseconds: timeoutMilliseconds as number,
    })
  } catch {
    throw fail('invalid_client', 'The Feishu OAuth user-info HTTP client is invalid.')
  }
}

function readRequest(value: unknown): Readonly<{
  accessToken: Uint8Array<ArrayBuffer>
  maximumResponseBytes: number
}> {
  try {
    const request = dataRecord(value)
    exactKeys(request, ['method', 'url', 'accessToken', 'maximumResponseBytes'])
    if (
      request.method !== 'GET' ||
      request.url !== FEISHU_OAUTH_USER_INFO_URL ||
      !(request.accessToken instanceof Uint8Array) ||
      !(request.accessToken.buffer instanceof ArrayBuffer) ||
      request.accessToken.byteLength === 0 ||
      request.accessToken.byteLength > FEISHU_OAUTH_TOKEN_MAX_LENGTH ||
      request.maximumResponseBytes !== FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES
    ) {
      throw new TypeError()
    }
    for (let index = 0; index < request.accessToken.byteLength; index += 1) {
      const byte = request.accessToken[index] as number
      if (byte < 0x21 || byte > 0x7e) throw new TypeError()
    }
    return Object.freeze({
      accessToken: request.accessToken as Uint8Array<ArrayBuffer>,
      maximumResponseBytes: request.maximumResponseBytes,
    })
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth user-info HTTP request is invalid.')
  }
}

function contentLength(headers: Headers, maximumResponseBytes: number): void {
  let value: string | null
  try {
    value = headers.get('content-length')
  } catch {
    throw fail('invalid_response', 'The Feishu OAuth user-info HTTP response is invalid.')
  }
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw fail('invalid_response', 'The Feishu OAuth user-info HTTP response is invalid.')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response is too large.')
  }
}

function contentType(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-type')
  } catch {
    throw fail('invalid_response', 'The Feishu OAuth user-info HTTP response is invalid.')
  }
  if (value === null || !/^application\/json(?:\s*;|$)/iu.test(value)) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response type is invalid.')
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
          if (!result.done && result.value instanceof Uint8Array) result.value.fill(0)
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
  maximumResponseBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw fail('invalid_response', 'The Feishu OAuth user-info stream is invalid.')
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
        throw fail('invalid_response', 'The Feishu OAuth user-info stream is invalid.')
      }
      if (result.value.byteLength > maximumResponseBytes - total) {
        cancelReader(reader)
        throw fail('invalid_response', 'The Feishu OAuth user-info response is too large.')
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
    pendingChunk?.fill(0)
    for (const chunk of chunks) chunk.fill(0)
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

function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response is invalid.')
  }
  return value
}

function errorForCode(code: number): FeishuOAuthUserPrincipalVerificationError {
  if (code === 20005) {
    return fail(
      'reauthorization_required',
      'The Feishu User authorization must be renewed before identity verification.',
    )
  }
  if (code === 20050) {
    return fail('retry_later', 'The Feishu OAuth user-info service is temporarily unavailable.')
  }
  if ([20008, 20021, 20022, 20023].includes(code)) {
    return fail('unavailable', 'The Feishu User identity is not available for authorization.')
  }
  return fail('invalid_response', 'The Feishu OAuth user-info request was rejected.')
}

function parseResponse(body: Uint8Array): FeishuOAuthUserInfoResponse {
  if (body.byteLength === 0 || body.byteLength > FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response size is invalid.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw fail('invalid_response', 'The Feishu OAuth user-info response encoding is invalid.')
  }
  if (hasDuplicateObjectKey(text)) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response has duplicate fields.')
  }
  let record: UnknownRecord
  try {
    record = dataRecord(JSON.parse(text) as unknown)
  } catch {
    throw fail('invalid_response', 'The Feishu OAuth user-info response is not valid JSON.')
  }
  if (!Number.isSafeInteger(record.code)) {
    throw fail('invalid_response', 'The Feishu OAuth user-info response code is invalid.')
  }
  boundedString(record.msg, 2048)
  if (record.code !== 0) {
    const keys = Object.keys(record)
    if (!(
      (keys.length === 2 && keys.includes('code') && keys.includes('msg')) ||
      (keys.length === 3 && keys.includes('code') && keys.includes('msg') && keys.includes('data'))
    )) {
      throw fail('invalid_response', 'The Feishu OAuth user-info response is invalid.')
    }
    throw errorForCode(record.code as number)
  }
  try {
    exactKeys(record, ['code', 'msg', 'data'])
    const data = dataRecord(record.data)
    if (!Object.hasOwn(data, 'open_id')) throw new TypeError()
    const openId = boundedString(data.open_id, 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(openId)) throw new TypeError()
    return Object.freeze({ openId })
  } catch (error) {
    if (error instanceof FeishuOAuthUserPrincipalVerificationError) throw error
    throw fail('invalid_response', 'The Feishu OAuth user-info response is invalid.')
  }
}

/** Production Fetch client for Feishu's fixed User information endpoint. */
export class FeishuOAuthUserInfoHttpClient implements FeishuOAuthUserInfoClient {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number

  constructor(options?: FeishuOAuthUserInfoHttpClientOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
  }

  async get(
    requestValue: FeishuOAuthUserInfoRequest,
    signal: AbortSignal,
  ): Promise<FeishuOAuthUserInfoResponse> {
    signal.throwIfAborted()
    const request = readRequest(requestValue)
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMilliseconds)
    let response: Response
    try {
      try {
        const token = new TextDecoder().decode(request.accessToken)
        response = await this.#fetch(FEISHU_OAUTH_USER_INFO_URL, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
      } catch {
        if (signal.aborted) signal.throwIfAborted()
        if (timedOut) {
          throw fail('retry_later', 'The Feishu OAuth user-info HTTP request timed out.')
        }
        throw fail('retry_later', 'The Feishu OAuth user-info HTTP request failed.')
      }
      let status: number
      let headers: Headers
      let responseBody: ReadableStream<Uint8Array> | null = null
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
        responseBody = responseBodyGetter.call(
          response,
        ) as unknown as ReadableStream<Uint8Array> | null
        if (
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599 ||
          !(headers instanceof Headers) ||
          (responseBody !== null && !(responseBody instanceof ReadableStream))
        ) {
          throw new TypeError()
        }
      } catch {
        await cancelBody(responseBody)
        throw fail('invalid_response', 'The Feishu OAuth user-info HTTP response is invalid.')
      }
      if (signal.aborted) {
        await cancelBody(responseBody)
        signal.throwIfAborted()
      }
      if (status >= 300 && status <= 399) {
        await cancelBody(responseBody)
        throw fail('invalid_response', 'The Feishu OAuth user-info redirect was rejected.')
      }
      if (status === 401 || status === 403) {
        await cancelBody(responseBody)
        throw fail(
          'reauthorization_required',
          'The Feishu User authorization must be renewed before identity verification.',
        )
      }
      if (status === 429 || status >= 500) {
        await cancelBody(responseBody)
        throw fail('retry_later', 'The Feishu OAuth user-info service is temporarily unavailable.')
      }
      if (status !== 200) {
        await cancelBody(responseBody)
        throw fail('invalid_response', 'The Feishu OAuth user-info HTTP response is invalid.')
      }
      try {
        contentLength(headers, request.maximumResponseBytes)
        contentType(headers)
      } catch (error) {
        await cancelBody(responseBody)
        throw error
      }
      const body = await boundedBody(responseBody, request.maximumResponseBytes, controller.signal)
      try {
        signal.throwIfAborted()
        if (timedOut) {
          throw fail('retry_later', 'The Feishu OAuth user-info HTTP request timed out.')
        }
        return parseResponse(body)
      } finally {
        body.fill(0)
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof FeishuOAuthUserPrincipalVerificationError) throw error
      if (timedOut) {
        throw fail('retry_later', 'The Feishu OAuth user-info HTTP request timed out.')
      }
      throw fail('retry_later', 'The Feishu OAuth user-info HTTP request failed.')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}
