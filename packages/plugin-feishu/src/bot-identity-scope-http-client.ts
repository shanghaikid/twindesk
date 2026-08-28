import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import { FeishuOperationScopeProbeClientError } from './operation-scope-authorization.ts'

export const FEISHU_BOT_IDENTITY_SCOPE_OBSERVATION_VERSION = 1 as const
export const FEISHU_BOT_INFO_URL = 'https://open.feishu.cn/open-apis/bot/v3/info' as const
export const FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES = 256 * 1024
export const FEISHU_BOT_IDENTITY_SCOPE_HTTP_TIMEOUT_MILLISECONDS = 30_000
export const FEISHU_BOT_IDENTITY_SCOPE_HTTP_MAX_TIMEOUT_MILLISECONDS = 120_000

const APPLICATION_INFO_PREFIX =
  'https://open.feishu.cn/open-apis/application/v6/applications/' as const
const APPLICATION_INFO_SUFFIX = '?lang=zh_cn' as const

export interface FeishuBotIdentityScopeRequest {
  readonly appId: string
  readonly accessToken: Uint8Array
}

export interface FeishuBotIdentityScopeObservation {
  readonly kind: 'feishu_bot_identity_scope_observation'
  readonly schemaVersion: typeof FEISHU_BOT_IDENTITY_SCOPE_OBSERVATION_VERSION
  readonly appId: string
  readonly principalId: string
  readonly grantedScopes: readonly string[]
}

export interface FeishuBotIdentityScopeClient {
  inspect(
    request: FeishuBotIdentityScopeRequest,
    signal: AbortSignal,
  ): Promise<FeishuBotIdentityScopeObservation>
}

export interface FeishuBotIdentityScopeHttpClientOptions {
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

function clientError(
  code: ConstructorParameters<typeof FeishuOperationScopeProbeClientError>[0],
): FeishuOperationScopeProbeClientError {
  return new FeishuOperationScopeProbeClientError(code)
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
}> {
  try {
    const options = value === undefined ? {} : dataRecord(value)
    const expected = ['fetch', 'timeoutMilliseconds'].filter((key) => Object.hasOwn(options, key))
    exactKeys(options, expected)
    const fetchImplementation = Object.hasOwn(options, 'fetch') ? options.fetch : globalThis.fetch
    const timeoutMilliseconds = Object.hasOwn(options, 'timeoutMilliseconds')
      ? options.timeoutMilliseconds
      : FEISHU_BOT_IDENTITY_SCOPE_HTTP_TIMEOUT_MILLISECONDS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      (timeoutMilliseconds as number) <= 0 ||
      (timeoutMilliseconds as number) > FEISHU_BOT_IDENTITY_SCOPE_HTTP_MAX_TIMEOUT_MILLISECONDS
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
  appId: string
  accessToken: Uint8Array<ArrayBuffer>
}> {
  try {
    const request = dataRecord(value)
    exactKeys(request, ['appId', 'accessToken'])
    const appId = boundedString(request.appId, 128)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(appId) ||
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
      appId,
      accessToken: request.accessToken as Uint8Array<ArrayBuffer>,
    })
  } catch {
    throw clientError('invalid_response')
  }
}

function applicationInfoUrl(appId: string): string {
  return `${APPLICATION_INFO_PREFIX}${encodeURIComponent(appId)}${APPLICATION_INFO_SUFFIX}`
}

function contentLength(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-length')
  } catch {
    throw clientError('invalid_response')
  }
  if (value === null) return
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(value)) throw clientError('invalid_response')
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES) {
    throw clientError('invalid_response')
  }
}

function contentType(headers: Headers): void {
  let value: string | null
  try {
    value = headers.get('content-type')
  } catch {
    throw clientError('invalid_response')
  }
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
  if (body === null) return new Uint8Array()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw clientError('invalid_response')
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
        throw clientError('invalid_response')
      }
      if (result.value.byteLength > FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES - total) {
        cancelReader(reader)
        throw clientError('invalid_response')
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
  if (body.byteLength === 0 || body.byteLength > FEISHU_BOT_IDENTITY_SCOPE_RESPONSE_MAX_BYTES) {
    throw clientError('invalid_response')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw clientError('invalid_response')
  }
  if (hasDuplicateObjectKey(text)) throw clientError('invalid_response')
  try {
    const record = dataRecord(JSON.parse(text) as unknown)
    if (!Number.isSafeInteger(record.code)) throw new TypeError()
    boundedString(record.msg, 2048)
    return record
  } catch (error) {
    if (error instanceof FeishuOperationScopeProbeClientError) throw error
    throw clientError('invalid_response')
  }
}

function applicationCodeError(code: number): FeishuOperationScopeProbeClientError {
  if (code === 99991400) return clientError('rate_limited')
  if ([10014, 99991543, 99991661, 99991662, 99991663, 99991671, 99991673].includes(code)) {
    return clientError('not_authorized')
  }
  return clientError('invalid_response')
}

function parseBotPrincipal(body: Uint8Array): string {
  const record = parseJson(body)
  if (record.code !== 0) throw applicationCodeError(record.code as number)
  try {
    exactKeys(record, ['code', 'msg', 'bot'])
    const bot = dataRecord(record.bot)
    const principalId = boundedString(bot.open_id, 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(principalId)) throw new TypeError()
    return principalId
  } catch (error) {
    if (error instanceof FeishuOperationScopeProbeClientError) throw error
    throw clientError('invalid_response')
  }
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new TypeError()
  }
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    throw new TypeError()
  }
  const result = Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
    return boundedString(descriptor.value, maximumLength)
  })
  if (new Set(result).size !== result.length) throw new TypeError()
  return result
}

function parseGrantedScopes(body: Uint8Array): readonly string[] {
  const record = parseJson(body)
  if (record.code !== 0) throw applicationCodeError(record.code as number)
  try {
    exactKeys(record, ['code', 'msg', 'data'])
    const data = dataRecord(record.data)
    const app = dataRecord(data.app)
    if (!Array.isArray(app.scopes) || app.scopes.length > 512) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(app.scopes)
    if (
      Object.getPrototypeOf(app.scopes) !== Array.prototype ||
      Object.getOwnPropertySymbols(app.scopes).length !== 0 ||
      Object.keys(descriptors).length !== app.scopes.length + 1 ||
      !Object.hasOwn(descriptors, 'length')
    ) {
      throw new TypeError()
    }
    const seen = new Set<string>()
    const granted: string[] = []
    for (let index = 0; index < app.scopes.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
      const scope = dataRecord(descriptor.value)
      exactKeys(scope, ['scope', 'token_types'])
      const name = boundedString(scope.scope, 256)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(name) || seen.has(name)) {
        throw new TypeError()
      }
      seen.add(name)
      const tokenTypes = stringArray(scope.token_types, 8, 32)
      if (tokenTypes.includes('tenant')) granted.push(name)
    }
    return Object.freeze(granted.sort())
  } catch (error) {
    if (error instanceof FeishuOperationScopeProbeClientError) throw error
    throw clientError('invalid_response')
  }
}

/** Production fixed-endpoint Bot identity and current-scope observation client. */
export class FeishuBotIdentityScopeHttpClient implements FeishuBotIdentityScopeClient {
  readonly #fetch: typeof fetch
  readonly #timeoutMilliseconds: number

  constructor(options?: FeishuBotIdentityScopeHttpClientOptions) {
    const validated = readOptions(options)
    this.#fetch = validated.fetch
    this.#timeoutMilliseconds = validated.timeoutMilliseconds
  }

  async #read(
    url: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBufferLike>> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
    } catch {
      signal.throwIfAborted()
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
      throw clientError('invalid_response')
    }
    if (status >= 300 && status <= 399) {
      await cancelBody(stream)
      throw clientError('invalid_response')
    }
    if (status === 401 || status === 403) {
      await cancelBody(stream)
      throw clientError('not_authorized')
    }
    if (status === 429) {
      await cancelBody(stream)
      throw clientError('rate_limited')
    }
    if (status >= 500) {
      await cancelBody(stream)
      throw clientError('unavailable')
    }
    if (status !== 200) {
      await cancelBody(stream)
      throw clientError('invalid_response')
    }
    try {
      contentLength(headers)
      contentType(headers)
    } catch (error) {
      await cancelBody(stream)
      throw error
    }
    return boundedBody(stream, signal)
  }

  async inspect(
    requestValue: FeishuBotIdentityScopeRequest,
    signal: AbortSignal,
  ): Promise<FeishuBotIdentityScopeObservation> {
    if (!(signal instanceof AbortSignal)) throw clientError('invalid_response')
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
    let botBody: Uint8Array | undefined
    let scopesBody: Uint8Array | undefined
    try {
      const token = new TextDecoder().decode(request.accessToken)
      botBody = await this.#read(FEISHU_BOT_INFO_URL, token, controller.signal)
      signal.throwIfAborted()
      const principalId = parseBotPrincipal(botBody)
      scopesBody = await this.#read(applicationInfoUrl(request.appId), token, controller.signal)
      signal.throwIfAborted()
      const grantedScopes = parseGrantedScopes(scopesBody)
      return Object.freeze({
        kind: 'feishu_bot_identity_scope_observation',
        schemaVersion: FEISHU_BOT_IDENTITY_SCOPE_OBSERVATION_VERSION,
        appId: request.appId,
        principalId,
        grantedScopes,
      })
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      if (timedOut) throw clientError('network')
      if (error instanceof FeishuOperationScopeProbeClientError) throw error
      throw clientError('unavailable')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (botBody !== undefined) zeroBytes(botBody)
      if (scopesBody !== undefined) zeroBytes(scopesBody)
    }
  }
}
