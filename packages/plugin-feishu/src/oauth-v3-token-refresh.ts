import { parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'

export const FEISHU_OAUTH_V3_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token' as const
export const FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES = 32 * 1024
export const FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS = 366 * 24 * 60 * 60

export type FeishuOAuthV3RefreshErrorCode =
  | 'invalid_request'
  | 'invalid_transport'
  | 'invalid_response'
  | 'configuration_invalid'
  | 'reauthorization_required'
  | 'retry_later'
  | 'invalid_clock'

export type FeishuOAuthV3RetryDisposition = 'do_not_retry' | 'reauthorize' | 'retry_later'

export class FeishuOAuthV3RefreshError extends Error {
  readonly code: FeishuOAuthV3RefreshErrorCode
  readonly retryDisposition: FeishuOAuthV3RetryDisposition

  constructor(
    code: FeishuOAuthV3RefreshErrorCode,
    retryDisposition: FeishuOAuthV3RetryDisposition,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOAuthV3RefreshError'
    this.code = code
    this.retryDisposition = retryDisposition
  }
}

export interface FeishuOAuthV3RefreshInput {
  readonly clientId: string
  readonly clientSecret: Uint8Array
  readonly refreshToken: Uint8Array
}

export interface FeishuOAuthV3TokenSet {
  readonly tokenType: 'Bearer'
  readonly accessToken: Uint8Array
  readonly obtainedAt: IsoTimestamp
  readonly accessTokenExpiresAt: IsoTimestamp
  readonly refreshToken: Uint8Array
  readonly refreshTokenExpiresAt: IsoTimestamp
  readonly scopes: readonly string[]
}

export interface FeishuOAuthV3TransportRequest {
  readonly method: 'POST'
  readonly url: typeof FEISHU_OAUTH_V3_TOKEN_URL
  readonly headers: Readonly<{
    accept: 'application/json'
    'content-type': 'application/x-www-form-urlencoded'
  }>
  readonly body: Uint8Array
  readonly maximumResponseBytes: typeof FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES
}

export interface FeishuOAuthV3TransportResponse {
  readonly status: number
  readonly body: Uint8Array
}

export interface FeishuOAuthV3Transport {
  send(
    request: FeishuOAuthV3TransportRequest,
    signal: AbortSignal,
  ): Promise<FeishuOAuthV3TransportResponse>
}

export interface FeishuOAuthV3TokenRefresherOptions {
  readonly transport: FeishuOAuthV3Transport
  /** Trusted local clock sampled after the response is received. */
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const encoder = new TextEncoder()
const hex = encoder.encode('0123456789ABCDEF')

function fail(
  code: FeishuOAuthV3RefreshErrorCode,
  retryDisposition: FeishuOAuthV3RetryDisposition,
  message: string,
): FeishuOAuthV3RefreshError {
  return new FeishuOAuthV3RefreshError(code, retryDisposition, message)
}

function ownDataRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is invalid.')
  }
  try {
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
  } catch (error) {
    if (error instanceof FeishuOAuthV3RefreshError) throw error
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is invalid.')
  }
}

function exactKeys(record: UnknownRecord, keys: readonly string[]): void {
  const actual = Object.keys(record)
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response shape is invalid.')
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
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is invalid.')
  }
  return value
}

function requestString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth refresh request is invalid.')
  }
  return value
}

function requestSecret(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth refresh request is invalid.')
  }
  return value
}

function readRefreshInput(value: unknown): FeishuOAuthV3RefreshInput {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.length !== 3 ||
      !['clientId', 'clientSecret', 'refreshToken'].every((key) =>
        Object.hasOwn(descriptors, key),
      ) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      clientId: requestString(descriptors.clientId?.value, 128),
      clientSecret: requestSecret(descriptors.clientSecret?.value, 512),
      refreshToken: requestSecret(descriptors.refreshToken?.value, FEISHU_OAUTH_TOKEN_MAX_LENGTH),
    })
  } catch (error) {
    if (error instanceof FeishuOAuthV3RefreshError) throw error
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth refresh request is invalid.')
  }
}

function isUnreserved(value: number): boolean {
  return (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a) ||
    (value >= 0x30 && value <= 0x39) ||
    value === 0x2d ||
    value === 0x2e ||
    value === 0x5f ||
    value === 0x7e
  )
}

function encodedLength(value: Uint8Array): number {
  let length = 0
  for (const byte of value) length += isUnreserved(byte) ? 1 : 3
  return length
}

function writeEncoded(target: Uint8Array, offset: number, value: Uint8Array): number {
  for (const byte of value) {
    if (isUnreserved(byte)) {
      target[offset] = byte
      offset += 1
    } else {
      target[offset] = 0x25
      target[offset + 1] = hex[byte >> 4] as number
      target[offset + 2] = hex[byte & 0x0f] as number
      offset += 3
    }
  }
  return offset
}

function formBody(input: FeishuOAuthV3RefreshInput): Uint8Array {
  const fields = [
    [encoder.encode('grant_type'), encoder.encode('refresh_token')],
    [encoder.encode('client_id'), encoder.encode(input.clientId)],
    [encoder.encode('client_secret'), input.clientSecret],
    [encoder.encode('refresh_token'), input.refreshToken],
  ] as const
  const length = fields.reduce(
    (total, [name, value], index) =>
      total + encodedLength(name) + 1 + encodedLength(value) + (index === 0 ? 0 : 1),
    0,
  )
  const body = new Uint8Array(length)
  let offset = 0
  for (const [name, value] of fields) {
    if (offset > 0) body[offset++] = 0x26
    offset = writeEncoded(body, offset, name)
    body[offset++] = 0x3d
    offset = writeEncoded(body, offset, value)
  }
  return body
}

function readClock(now: () => number): number {
  let value: number
  try {
    value = now()
  } catch {
    throw fail('invalid_clock', 'do_not_retry', 'The Feishu OAuth clock is invalid.')
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw fail('invalid_clock', 'do_not_retry', 'The Feishu OAuth clock is invalid.')
  }
  return value
}

function expiresAt(observedAt: number, seconds: unknown): IsoTimestamp {
  if (
    !Number.isSafeInteger(seconds) ||
    (seconds as number) <= 0 ||
    (seconds as number) > FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS
  ) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth lifetime is invalid.')
  }
  const result = observedAt + (seconds as number) * 1000
  if (!Number.isSafeInteger(result) || result > 8_640_000_000_000_000) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth lifetime is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(result).toISOString())
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth lifetime is invalid.')
  }
}

function parseScopes(value: unknown): readonly string[] {
  const scopeText = boundedString(value, 32 * 1024)
  const values = scopeText.split(' ')
  if (
    values.length === 0 ||
    values.length > 128 ||
    values.some(
      (scope) =>
        scope.length === 0 || scope.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope),
    ) ||
    new Set(values).size !== values.length ||
    !values.includes('offline_access')
  ) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth scope response is invalid.')
  }
  return Object.freeze([...values].sort())
}

function errorForUpstreamCode(code: number): FeishuOAuthV3RefreshError {
  if ([20002, 20009, 20048, 20069, 20074].includes(code)) {
    return fail(
      'configuration_invalid',
      'do_not_retry',
      'The Feishu OAuth client configuration is invalid.',
    )
  }
  if ([20008, 20010, 20024, 20026, 20037, 20064, 20066, 20073].includes(code)) {
    return fail(
      'reauthorization_required',
      'reauthorize',
      'The Feishu user authorization must be renewed.',
    )
  }
  if (code === 20050 || code === 20072) {
    return fail(
      'retry_later',
      'retry_later',
      'The Feishu OAuth service is temporarily unavailable.',
    )
  }
  return fail('invalid_response', 'do_not_retry', 'The Feishu OAuth refresh was rejected.')
}

function duplicateTopLevelKey(text: string): boolean {
  const keys = new Set<string>()
  let depth = 0
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
      if (depth === 1 && text[next] === ':') {
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
      depth += 1
    } else if (character === '}') {
      depth -= 1
    }
    index += 1
  }
  return false
}

function parseResponse(
  status: number,
  body: Uint8Array,
  observedAt: number,
): FeishuOAuthV3TokenSet {
  if (body.byteLength === 0 || body.byteLength > FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response size is invalid.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response encoding is invalid.')
  }
  if (duplicateTopLevelKey(text)) {
    throw fail(
      'invalid_response',
      'do_not_retry',
      'The Feishu OAuth response has duplicate fields.',
    )
  }
  let record: UnknownRecord
  try {
    record = ownDataRecord(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof FeishuOAuthV3RefreshError) throw error
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response is not valid JSON.')
  }
  if (!Number.isSafeInteger(record.code)) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response code is invalid.')
  }
  if (record.code !== 0) {
    exactKeys(record, ['code', 'error', 'error_description'])
    boundedString(record.error, 256)
    boundedString(record.error_description, 2048)
    throw errorForUpstreamCode(record.code as number)
  }
  if (status < 200 || status > 299) {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth HTTP response is invalid.')
  }
  exactKeys(record, [
    'code',
    'access_token',
    'expires_in',
    'refresh_token',
    'refresh_token_expires_in',
    'scope',
    'token_type',
  ])
  if (record.token_type !== 'Bearer') {
    throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth token type is invalid.')
  }
  const accessToken = boundedString(record.access_token, FEISHU_OAUTH_TOKEN_MAX_LENGTH)
  const refreshToken = boundedString(record.refresh_token, FEISHU_OAUTH_TOKEN_MAX_LENGTH)
  const obtainedAt = parseIsoTimestamp(new Date(observedAt).toISOString())
  const accessTokenExpiresAt = expiresAt(observedAt, record.expires_in)
  const refreshTokenExpiresAt = expiresAt(observedAt, record.refresh_token_expires_in)
  const scopes = parseScopes(record.scope)
  return Object.freeze({
    tokenType: 'Bearer',
    accessToken: encoder.encode(accessToken),
    obtainedAt,
    accessTokenExpiresAt,
    refreshToken: encoder.encode(refreshToken),
    refreshTokenExpiresAt,
    scopes,
  })
}

function zeroTokenSet(tokenSet: FeishuOAuthV3TokenSet | undefined): void {
  tokenSet?.accessToken.fill(0)
  tokenSet?.refreshToken.fill(0)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number)
  }
  return difference === 0
}

function readTransportResponse(value: unknown): FeishuOAuthV3TransportResponse {
  let body: Uint8Array | undefined
  try {
    if (typeof value === 'object' && value !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'body')
      if (
        descriptor !== undefined &&
        Object.hasOwn(descriptor, 'value') &&
        descriptor.value instanceof Uint8Array
      ) {
        body = descriptor.value
      }
    }
    const record = ownDataRecord(value)
    exactKeys(record, ['status', 'body'])
    if (
      !Number.isInteger(record.status) ||
      (record.status as number) < 100 ||
      (record.status as number) > 599
    ) {
      throw fail(
        'invalid_transport',
        'retry_later',
        'The Feishu OAuth transport response is invalid.',
      )
    }
    if (!(record.body instanceof Uint8Array)) {
      throw fail(
        'invalid_transport',
        'retry_later',
        'The Feishu OAuth transport response is invalid.',
      )
    }
    body = record.body
    return { status: record.status as number, body }
  } catch (error) {
    body?.fill(0)
    if (error instanceof FeishuOAuthV3RefreshError && error.code === 'invalid_transport')
      throw error
    throw fail(
      'invalid_transport',
      'retry_later',
      'The Feishu OAuth transport response is invalid.',
    )
  }
}

/**
 * Refresh a principal-bound User OAuth credential through Feishu OAuth v3.
 * The transport receives one short-lived form body. Response bytes and parsed
 * token buffers are cleared after the callback settles.
 */
export class FeishuOAuthV3TokenRefresher {
  readonly #transport: FeishuOAuthV3Transport
  readonly #now: () => number

  constructor(options: FeishuOAuthV3TokenRefresherOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.transport !== 'object' ||
      options.transport === null ||
      typeof options.transport.send !== 'function'
    ) {
      throw fail('invalid_transport', 'do_not_retry', 'The Feishu OAuth transport is invalid.')
    }
    this.#transport = options.transport
    this.#now = options.now ?? Date.now
  }

  async refresh<TResult>(
    inputValue: FeishuOAuthV3RefreshInput,
    signal: AbortSignal,
    use: (tokenSet: FeishuOAuthV3TokenSet) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth token consumer is invalid.')
    }
    const input = readRefreshInput(inputValue)
    const body = formBody(input)
    const request = Object.freeze({
      method: 'POST' as const,
      url: FEISHU_OAUTH_V3_TOKEN_URL,
      headers: Object.freeze({
        accept: 'application/json' as const,
        'content-type': 'application/x-www-form-urlencoded' as const,
      }),
      body,
      maximumResponseBytes: FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
    })
    let response: FeishuOAuthV3TransportResponse
    try {
      try {
        response = readTransportResponse(await this.#transport.send(request, signal))
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        if (error instanceof FeishuOAuthV3RefreshError) throw error
        throw fail('retry_later', 'retry_later', 'The Feishu OAuth request could not be completed.')
      }
    } finally {
      body.fill(0)
    }
    let tokenSet: FeishuOAuthV3TokenSet | undefined
    try {
      signal.throwIfAborted()
      if (response.status === 429 || response.status >= 500) {
        throw fail(
          'retry_later',
          'retry_later',
          'The Feishu OAuth service is temporarily unavailable.',
        )
      }
      if (
        response.body.byteLength === 0 ||
        response.body.byteLength > FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES
      ) {
        throw fail('invalid_response', 'do_not_retry', 'The Feishu OAuth response size is invalid.')
      }
      const observedAt = readClock(this.#now)
      tokenSet = parseResponse(response.status, response.body, observedAt)
      if (equalBytes(tokenSet.refreshToken, input.refreshToken)) {
        throw fail(
          'invalid_response',
          'do_not_retry',
          'The Feishu OAuth response did not rotate the refresh token.',
        )
      }
      signal.throwIfAborted()
      const result = await use(tokenSet)
      signal.throwIfAborted()
      return result
    } finally {
      zeroTokenSet(tokenSet)
      response.body.fill(0)
    }
  }
}
