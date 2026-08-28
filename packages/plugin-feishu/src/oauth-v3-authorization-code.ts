import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import {
  FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES,
  FEISHU_OAUTH_V3_TOKEN_URL,
  FeishuOAuthV3RefreshError,
  parseFeishuOAuthV3TokenResponse,
  readFeishuOAuthV3TransportResponse,
  type FeishuOAuthV3TokenSet,
  type FeishuOAuthV3Transport,
  type FeishuOAuthV3TransportResponse,
} from './oauth-v3-token-refresh.ts'

export const FEISHU_OAUTH_AUTHORIZE_URL =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize' as const
export const FEISHU_OAUTH_PKCE_RANDOM_BYTES = 32

export type FeishuOAuthAuthorizationErrorCode =
  | 'invalid_request'
  | 'invalid_flow'
  | 'state_mismatch'
  | 'authorization_denied'
  | 'authorization_consumed'
  | 'configuration_invalid'
  | 'reauthorization_required'
  | 'exchange_uncertain'
  | 'invalid_response'
  | 'invalid_clock'

export type FeishuOAuthAuthorizationRetryDisposition = 'do_not_retry' | 'reauthorize'

export class FeishuOAuthAuthorizationError extends Error {
  readonly code: FeishuOAuthAuthorizationErrorCode
  readonly retryDisposition: FeishuOAuthAuthorizationRetryDisposition

  constructor(
    code: FeishuOAuthAuthorizationErrorCode,
    retryDisposition: FeishuOAuthAuthorizationRetryDisposition,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOAuthAuthorizationError'
    this.code = code
    this.retryDisposition = retryDisposition
  }
}

export interface FeishuOAuthAuthorizationInput {
  readonly clientId: string
  readonly clientSecret: Uint8Array
  readonly redirectUri: string
  readonly scopes: readonly string[]
}

export interface FeishuOAuthAuthorizationFlowOptions {
  readonly transport: FeishuOAuthV3Transport
  readonly now?: () => number
  readonly randomBytes?: (length: number) => Uint8Array
}

export interface FeishuOAuthAuthorizationSession {
  readonly authorizationUrl: string
  cancel(): void
  complete<TResult>(
    callbackUri: string,
    signal: AbortSignal,
    use: (tokenSet: FeishuOAuthV3TokenSet) => Promise<TResult> | TResult,
  ): Promise<TResult>
}

type UnknownRecord = Readonly<Record<string, unknown>>
type RandomBytes = (length: number) => Uint8Array
const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

type ValidatedAuthorizationInput = Readonly<{
  clientId: string
  clientSecret: Uint8Array<ArrayBuffer>
  redirectUri: string
  redirectUrl: URL
  scopes: readonly string[]
}>

type CallbackResult = Readonly<{ kind: 'success'; code: string }> | Readonly<{ kind: 'denied' }>

function fail(
  code: FeishuOAuthAuthorizationErrorCode,
  retryDisposition: FeishuOAuthAuthorizationRetryDisposition,
  message: string,
): FeishuOAuthAuthorizationError {
  return new FeishuOAuthAuthorizationError(code, retryDisposition, message)
}

function dataRecord(value: unknown, errorCode: 'invalid_request' | 'invalid_flow'): UnknownRecord {
  try {
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
  } catch {
    throw fail(
      errorCode,
      'do_not_retry',
      errorCode === 'invalid_flow'
        ? 'The Feishu OAuth authorization flow is invalid.'
        : 'The Feishu OAuth authorization request is invalid.',
    )
  }
}

function exactKeys(
  record: UnknownRecord,
  expected: readonly string[],
  errorCode: 'invalid_request' | 'invalid_flow',
): void {
  const actual = Object.keys(record)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw fail(
      errorCode,
      'do_not_retry',
      errorCode === 'invalid_flow'
        ? 'The Feishu OAuth authorization flow is invalid.'
        : 'The Feishu OAuth authorization request is invalid.',
    )
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail(
      'invalid_request',
      'do_not_retry',
      'The Feishu OAuth authorization request is invalid.',
    )
  }
  return value
}

function copySecret(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > 512
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth client secret is invalid.')
  }
  const copy = new Uint8Array(value.byteLength)
  for (let index = 0; index < value.byteLength; index += 1) {
    copy[index] = value[index] as number
  }
  return copy
}

function readScopes(value: unknown): readonly string[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => String(index)).some((index) => {
        const descriptor = descriptors[index]
        return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
      })
    ) {
      throw new TypeError()
    }
    const scopes = Array.from({ length: value.length }, (_, index) => {
      const scope = descriptors[String(index)]?.value
      if (
        typeof scope !== 'string' ||
        scope.length === 0 ||
        scope.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)
      ) {
        throw new TypeError()
      }
      return scope
    })
    if (new Set(scopes).size !== scopes.length || !scopes.includes('offline_access')) {
      throw new TypeError()
    }
    return Object.freeze([...scopes].sort())
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth scope request is invalid.')
  }
}

function readRedirect(value: unknown): Readonly<{ redirectUri: string; redirectUrl: URL }> {
  const redirectUri = boundedText(value, 2048)
  let redirectUrl: URL
  try {
    redirectUrl = new URL(redirectUri)
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth redirect URI is invalid.')
  }
  const loopbackHttp =
    redirectUrl.protocol === 'http:' &&
    (redirectUrl.hostname === '127.0.0.1' || redirectUrl.hostname === '[::1]')
  if (
    (redirectUrl.protocol !== 'https:' && !loopbackHttp) ||
    redirectUrl.username !== '' ||
    redirectUrl.password !== '' ||
    redirectUrl.search !== '' ||
    redirectUrl.hash !== ''
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth redirect URI is invalid.')
  }
  return Object.freeze({ redirectUri: redirectUrl.toString(), redirectUrl })
}

function readInput(value: unknown): ValidatedAuthorizationInput {
  const record = dataRecord(value, 'invalid_request')
  exactKeys(record, ['clientId', 'clientSecret', 'redirectUri', 'scopes'], 'invalid_request')
  const clientId = boundedText(record.clientId, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(clientId)) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth client ID is invalid.')
  }
  const redirect = readRedirect(record.redirectUri)
  return Object.freeze({
    clientId,
    clientSecret: copySecret(record.clientSecret),
    redirectUri: redirect.redirectUri,
    redirectUrl: redirect.redirectUrl,
    scopes: readScopes(record.scopes),
  })
}

function methodFromObject<TMethod extends (...arguments_: never[]) => unknown>(
  value: unknown,
  name: string,
): TMethod {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      throw new TypeError()
    }
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return descriptor.value.bind(value) as TMethod
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw fail('invalid_flow', 'do_not_retry', 'The Feishu OAuth authorization flow is invalid.')
  }
}

function readOptions(value: unknown): Readonly<{
  transport: FeishuOAuthV3Transport
  now: () => number
  randomBytes: RandomBytes
}> {
  const record = dataRecord(value, 'invalid_flow')
  const expected = ['transport']
  if (Object.hasOwn(record, 'now')) expected.push('now')
  if (Object.hasOwn(record, 'randomBytes')) expected.push('randomBytes')
  exactKeys(record, expected, 'invalid_flow')
  const send = methodFromObject<FeishuOAuthV3Transport['send']>(record.transport, 'send')
  const now = Object.hasOwn(record, 'now') ? record.now : Date.now
  const random = Object.hasOwn(record, 'randomBytes') ? record.randomBytes : nodeRandomBytes
  if (typeof now !== 'function' || typeof random !== 'function') {
    throw fail('invalid_flow', 'do_not_retry', 'The Feishu OAuth authorization flow is invalid.')
  }
  return Object.freeze({
    transport: Object.freeze({ send }),
    now: now as () => number,
    randomBytes: random as RandomBytes,
  })
}

function randomValue(randomBytes: RandomBytes): Uint8Array<ArrayBuffer> {
  let source: Uint8Array | undefined
  try {
    source = randomBytes(FEISHU_OAUTH_PKCE_RANDOM_BYTES)
    if (
      !(source instanceof Uint8Array) ||
      !(source.buffer instanceof ArrayBuffer) ||
      source.byteLength !== FEISHU_OAUTH_PKCE_RANDOM_BYTES
    ) {
      throw new TypeError()
    }
    return new Uint8Array(source)
  } catch {
    throw fail('invalid_flow', 'do_not_retry', 'The Feishu OAuth random source is invalid.')
  } finally {
    if (source instanceof Uint8Array) zeroBytes(source)
  }
}

function base64UrlBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = Buffer.from(value)
  try {
    return new TextEncoder().encode(copy.toString('base64url'))
  } finally {
    zeroBytes(copy)
  }
}

function makeAuthorizationUrl(
  input: ValidatedAuthorizationInput,
  state: Uint8Array,
  verifier: Uint8Array,
): string {
  const stateText = new TextDecoder().decode(state)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = [
    ['client_id', input.clientId],
    ['response_type', 'code'],
    ['redirect_uri', input.redirectUri],
    ['scope', input.scopes.join(' ')],
    ['state', stateText],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
  ] as const
  return `${FEISHU_OAUTH_AUTHORIZE_URL}?${query
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')}`
}

function stateMatches(expected: Uint8Array, observed: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(observed)) return false
  const observedBytes = new TextEncoder().encode(observed)
  try {
    return (
      expected.byteLength === observedBytes.byteLength && timingSafeEqual(expected, observedBytes)
    )
  } finally {
    zeroBytes(observedBytes)
  }
}

function callbackResult(
  callbackUri: unknown,
  redirect: URL,
  expectedState: Uint8Array,
): CallbackResult {
  const value = boundedText(callbackUri, 8192)
  let callback: URL
  try {
    callback = new URL(value)
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth callback URI is invalid.')
  }
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth callback target is invalid.')
  }
  const keys = [...callback.searchParams.keys()]
  const stateValues = callback.searchParams.getAll('state')
  if (stateValues.length !== 1 || !stateMatches(expectedState, stateValues[0] ?? '')) {
    throw fail('state_mismatch', 'do_not_retry', 'The Feishu OAuth callback state is invalid.')
  }
  const codeValues = callback.searchParams.getAll('code')
  const errorValues = callback.searchParams.getAll('error')
  if (
    errorValues.length === 1 &&
    errorValues[0] === 'access_denied' &&
    codeValues.length === 0 &&
    keys.length === 2 &&
    keys.every((key) => key === 'error' || key === 'state')
  ) {
    return Object.freeze({ kind: 'denied' })
  }
  if (
    codeValues.length !== 1 ||
    errorValues.length !== 0 ||
    keys.length !== 2 ||
    !keys.every((key) => key === 'code' || key === 'state') ||
    !/^[A-Za-z0-9_-]{1,4096}$/u.test(codeValues[0] ?? '')
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth callback response is invalid.')
  }
  return Object.freeze({ kind: 'success', code: codeValues[0] as string })
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

const hex = new TextEncoder().encode('0123456789ABCDEF')

function encodedLength(value: Uint8Array): number {
  let length = 0
  for (let index = 0; index < value.byteLength; index += 1) {
    length += isUnreserved(value[index] as number) ? 1 : 3
  }
  return length
}

function formBody(
  clientId: string,
  clientSecret: Uint8Array,
  code: string,
  redirectUri: string,
  verifier: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const codeBytes = encoder.encode(code)
  const fields = [
    [encoder.encode('grant_type'), encoder.encode('authorization_code')],
    [encoder.encode('client_id'), encoder.encode(clientId)],
    [encoder.encode('client_secret'), clientSecret],
    [encoder.encode('code'), codeBytes],
    [encoder.encode('redirect_uri'), encoder.encode(redirectUri)],
    [encoder.encode('code_verifier'), verifier],
  ] as const
  try {
    const length = fields.reduce(
      (total, [name, value], index) =>
        total + encodedLength(name) + 1 + encodedLength(value) + (index === 0 ? 0 : 1),
      0,
    )
    if (length > FEISHU_OAUTH_V3_RESPONSE_MAX_BYTES) {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth token request is too large.')
    }
    const body = new Uint8Array(length)
    let offset = 0
    for (const [name, value] of fields) {
      if (offset > 0) body[offset++] = 0x26
      for (let index = 0; index < name.byteLength; index += 1) {
        const byte = name[index] as number
        if (isUnreserved(byte)) body[offset++] = byte
        else {
          body[offset++] = 0x25
          body[offset++] = hex[byte >> 4] as number
          body[offset++] = hex[byte & 0x0f] as number
        }
      }
      body[offset++] = 0x3d
      for (let index = 0; index < value.byteLength; index += 1) {
        const byte = value[index] as number
        if (isUnreserved(byte)) body[offset++] = byte
        else {
          body[offset++] = 0x25
          body[offset++] = hex[byte >> 4] as number
          body[offset++] = hex[byte & 0x0f] as number
        }
      }
    }
    return body
  } finally {
    zeroBytes(codeBytes)
  }
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

function mapExchangeFailure(error: unknown): FeishuOAuthAuthorizationError {
  if (error instanceof FeishuOAuthAuthorizationError && error.code === 'exchange_uncertain') {
    return error
  }
  if (error instanceof FeishuOAuthV3RefreshError) {
    if (error.code === 'configuration_invalid') {
      return fail(
        'configuration_invalid',
        'do_not_retry',
        'The Feishu OAuth client configuration is invalid.',
      )
    }
    if (error.code === 'reauthorization_required') {
      return fail(
        'reauthorization_required',
        'reauthorize',
        'A new Feishu authorization is required.',
      )
    }
  }
  return fail(
    'exchange_uncertain',
    'reauthorize',
    'The single-use Feishu authorization-code exchange is uncertain; start a new authorization.',
  )
}

function zeroTokenSet(tokenSet: FeishuOAuthV3TokenSet | undefined): void {
  if (tokenSet !== undefined) {
    zeroBytes(tokenSet.accessToken)
    zeroBytes(tokenSet.refreshToken)
  }
}

/**
 * One in-memory OAuth authorization transaction. The PKCE verifier and client
 * secret never leave the exchange request and are cleared on completion or
 * cancellation. A matched callback is consumed before any remote access.
 */
class DefaultFeishuOAuthAuthorizationSession implements FeishuOAuthAuthorizationSession {
  readonly authorizationUrl: string
  readonly #transport: FeishuOAuthV3Transport
  readonly #now: () => number
  readonly #redirectUrl: URL
  readonly #redirectUri: string
  readonly #clientId: string
  readonly #clientSecret: Uint8Array<ArrayBuffer>
  readonly #state: Uint8Array<ArrayBuffer>
  readonly #verifier: Uint8Array<ArrayBuffer>
  #status: 'active' | 'consumed' | 'cancelled' = 'active'

  /** @internal Construct sessions through FeishuOAuthAuthorizationFlow.start(). */
  constructor(
    input: ValidatedAuthorizationInput,
    transport: FeishuOAuthV3Transport,
    now: () => number,
    randomBytes: RandomBytes,
  ) {
    const stateRandom = randomValue(randomBytes)
    try {
      const verifierRandom = randomValue(randomBytes)
      try {
        this.#state = base64UrlBytes(stateRandom)
        this.#verifier = base64UrlBytes(verifierRandom)
        this.#transport = transport
        this.#now = now
        this.#redirectUrl = input.redirectUrl
        this.#redirectUri = input.redirectUri
        this.#clientId = input.clientId
        this.#clientSecret = input.clientSecret
        try {
          this.authorizationUrl = makeAuthorizationUrl(input, this.#state, this.#verifier)
        } catch {
          this.#clearSecrets()
          throw fail(
            'invalid_flow',
            'do_not_retry',
            'The Feishu OAuth authorization flow is invalid.',
          )
        }
      } finally {
        zeroBytes(verifierRandom)
      }
    } finally {
      zeroBytes(stateRandom)
    }
  }

  cancel(): void {
    if (this.#status !== 'active') return
    this.#status = 'cancelled'
    this.#clearSecrets()
  }

  async complete<TResult>(
    callbackUri: string,
    signal: AbortSignal,
    use: (tokenSet: FeishuOAuthV3TokenSet) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (this.#status !== 'active') {
      throw fail(
        'authorization_consumed',
        'reauthorize',
        'The Feishu OAuth authorization has already been consumed.',
      )
    }
    if (typeof use !== 'function') {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth token consumer is invalid.')
    }
    const callback = callbackResult(callbackUri, this.#redirectUrl, this.#state)
    if (callback.kind === 'denied') {
      this.#status = 'consumed'
      this.#clearSecrets()
      throw fail(
        'authorization_denied',
        'do_not_retry',
        'The Feishu OAuth authorization was denied.',
      )
    }
    this.#status = 'consumed'
    const body = formBody(
      this.#clientId,
      this.#clientSecret,
      callback.code,
      this.#redirectUri,
      this.#verifier,
    )
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
    let response: FeishuOAuthV3TransportResponse | undefined
    let tokenSet: FeishuOAuthV3TokenSet | undefined
    try {
      try {
        response = readFeishuOAuthV3TransportResponse(await this.#transport.send(request, signal))
        signal.throwIfAborted()
        if (response.status === 429 || response.status >= 500) {
          throw fail(
            'exchange_uncertain',
            'reauthorize',
            'The single-use Feishu authorization-code exchange is uncertain; start a new authorization.',
          )
        }
        tokenSet = parseFeishuOAuthV3TokenResponse(
          response.status,
          response.body,
          readClock(this.#now),
        )
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        throw mapExchangeFailure(error)
      }
      signal.throwIfAborted()
      // Once the consumer succeeds, its verified persistence outcome is
      // authoritative even if cancellation arrives during that callback.
      return await use(tokenSet)
    } finally {
      zeroBytes(body)
      if (response !== undefined) zeroBytes(response.body)
      zeroTokenSet(tokenSet)
      this.#clearSecrets()
    }
  }

  #clearSecrets(): void {
    zeroBytes(this.#clientSecret)
    zeroBytes(this.#state)
    zeroBytes(this.#verifier)
  }
}

/** Create one explicit state-bound S256 PKCE authorization transaction. */
export class FeishuOAuthAuthorizationFlow {
  readonly #transport: FeishuOAuthV3Transport
  readonly #now: () => number
  readonly #randomBytes: RandomBytes

  constructor(options: FeishuOAuthAuthorizationFlowOptions) {
    const validated = readOptions(options)
    this.#transport = validated.transport
    this.#now = validated.now
    this.#randomBytes = validated.randomBytes
  }

  start(inputValue: FeishuOAuthAuthorizationInput): FeishuOAuthAuthorizationSession {
    const input = readInput(inputValue)
    try {
      return new DefaultFeishuOAuthAuthorizationSession(
        input,
        this.#transport,
        this.#now,
        this.#randomBytes,
      )
    } catch (error) {
      zeroBytes(input.clientSecret)
      if (error instanceof FeishuOAuthAuthorizationError) throw error
      throw fail('invalid_flow', 'do_not_retry', 'The Feishu OAuth authorization flow is invalid.')
    }
  }
}
