import {
  FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_V3_TOKEN_URL,
  FeishuOAuthV3RefreshError,
  type FeishuOAuthV3Transport,
  type FeishuOAuthV3TransportRequest,
  type FeishuOAuthV3TransportResponse,
} from './oauth-v3-token-refresh.ts'

export const FEISHU_OAUTH_V3_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_OAUTH_V3_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

export interface FeishuOAuthV3HttpTransportOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMilliseconds?: number
}

type ValidatedRequest = Readonly<{
  body: Uint8Array<ArrayBuffer>
  maximumResponseBytes: number
}>

function fail(
  code: 'invalid_transport' | 'invalid_response' | 'retry_later',
  retryDisposition: 'do_not_retry' | 'retry_later',
  message: string,
): FeishuOAuthV3RefreshError {
  return new FeishuOAuthV3RefreshError(code, retryDisposition, message)
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError()
  }
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

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const keys = Object.keys(record)
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(record, key))) {
    throw new TypeError()
  }
}

function readRequest(value: unknown): ValidatedRequest {
  try {
    const request = dataRecord(value)
    exactKeys(request, ['method', 'url', 'headers', 'body', 'maximumResponseBytes'])
    const headers = dataRecord(request.headers)
    exactKeys(headers, ['accept', 'content-type'])
    if (
      request.method !== 'POST' ||
      request.url !== FEISHU_OAUTH_V3_TOKEN_URL ||
      headers.accept !== 'application/json' ||
      headers['content-type'] !== 'application/x-www-form-urlencoded' ||
      !(request.body instanceof Uint8Array) ||
      !(request.body.buffer instanceof ArrayBuffer) ||
      request.body.byteLength === 0 ||
      request.body.byteLength > FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES ||
      request.maximumResponseBytes !== FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      body: request.body as Uint8Array<ArrayBuffer>,
      maximumResponseBytes: request.maximumResponseBytes,
    })
  } catch {
    throw fail('invalid_transport', 'do_not_retry', 'The Feishu OAuth HTTP request is invalid.')
  }
}

function readOptions(value: unknown): Readonly<{
  fetch: typeof fetch
  timeoutMilliseconds: number
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    exactKeys(
      options,
      Object.hasOwn(options, 'fetch')
        ? Object.hasOwn(options, 'timeoutMilliseconds')
          ? ['fetch', 'timeoutMilliseconds']
          : ['fetch']
        : Object.hasOwn(options, 'timeoutMilliseconds')
          ? ['timeoutMilliseconds']
          : [],
    )
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_OAUTH_V3_HTTP_TIMEOUT_MILLISECONDS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_OAUTH_V3_HTTP_MAX_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      fetch: fetchImplementation as typeof fetch,
      timeoutMilliseconds: timeoutMilliseconds as number,
    })
  } catch {
    throw fail('invalid_transport', 'do_not_retry', 'The Feishu OAuth HTTP transport is invalid.')
  }
}

function contentLength(headers: Headers, maximumResponseBytes: number): void {
  let value: string | null
  try {
    value = headers.get('content-length')
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth HTTP response is invalid.')
  }
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth HTTP response is invalid.')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is too large.')
  }
}

function contentType(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-type')
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth HTTP response is invalid.')
  }
  if (value === null || !/^application\/json(?:\s*;|$)/iu.test(value)) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response type is invalid.')
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
  const reader = body.getReader()
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
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu OAuth response stream is invalid.',
        )
      }
      if (result.value.byteLength > maximumResponseBytes - total) {
        cancelReader(reader)
        throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is too large.')
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

/**
 * Production HTTP boundary for the fixed Feishu OAuth v3 token endpoint.
 * It rejects redirects, bounds response bytes while streaming, and never logs
 * request, response, or thrown upstream values.
 */
export class FeishuOAuthV3HttpTransport implements FeishuOAuthV3Transport {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number

  constructor(options?: FeishuOAuthV3HttpTransportOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
  }

  async send(
    requestValue: FeishuOAuthV3TransportRequest,
    signal: AbortSignal,
  ): Promise<FeishuOAuthV3TransportResponse> {
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
        response = await this.#fetch(FEISHU_OAUTH_V3_TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: request.body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
      } catch {
        if (signal.aborted) signal.throwIfAborted()
        if (timedOut) {
          throw fail('retry_later', 'retry_later', 'The Feishu OAuth HTTP request timed out.')
        }
        throw fail('retry_later', 'retry_later', 'The Feishu OAuth HTTP request failed.')
      }
      let status: number
      let headers: Headers
      let responseBody: ReadableStream<Uint8Array> | null
      try {
        status = response.status
        headers = response.headers
        responseBody = response.body
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
        throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth HTTP response is invalid.')
      }
      if (signal.aborted) {
        await cancelBody(responseBody)
        signal.throwIfAborted()
      }
      if (status >= 300 && status <= 399) {
        await cancelBody(responseBody)
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu OAuth HTTP redirect was rejected.',
        )
      }
      try {
        contentLength(headers, request.maximumResponseBytes)
        if (status !== 429 && status < 500) contentType(headers)
      } catch (error) {
        await cancelBody(responseBody)
        throw error
      }
      const body = await boundedBody(responseBody, request.maximumResponseBytes, controller.signal)
      try {
        signal.throwIfAborted()
        if (timedOut) {
          throw fail('retry_later', 'retry_later', 'The Feishu OAuth HTTP request timed out.')
        }
        return Object.freeze({ status, body })
      } catch (error) {
        body.fill(0)
        throw error
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof FeishuOAuthV3RefreshError) throw error
      if (timedOut) {
        throw fail('retry_later', 'retry_later', 'The Feishu OAuth HTTP request timed out.')
      }
      throw fail('retry_later', 'retry_later', 'The Feishu OAuth HTTP request failed.')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}
