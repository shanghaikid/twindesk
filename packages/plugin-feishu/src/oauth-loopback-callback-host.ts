import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { FEISHU_OAUTH_AUTHORIZE_URL } from './oauth-v3-authorization-code.ts'

export const FEISHU_OAUTH_LOOPBACK_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
export const FEISHU_OAUTH_LOOPBACK_CALLBACK_MAX_TARGET_BYTES = 8192

export type FeishuOAuthLoopbackCallbackErrorCode =
  'invalid_request' | 'listen_unavailable' | 'cancelled' | 'timeout' | 'already_armed'

export class FeishuOAuthLoopbackCallbackError extends Error {
  readonly code: FeishuOAuthLoopbackCallbackErrorCode

  constructor(code: FeishuOAuthLoopbackCallbackErrorCode, message: string) {
    super(message)
    this.name = 'FeishuOAuthLoopbackCallbackError'
    this.code = code
  }
}

export interface FeishuOAuthLoopbackCallbackHostOptions {
  readonly host?: '127.0.0.1' | '::1'
  readonly port?: number
  readonly path?: string
  readonly timeoutMs?: number
}

export interface FeishuOAuthLoopbackCallbackListener {
  readonly redirectUri: string
  wait(authorizationUrl: string, signal: AbortSignal): Promise<string>
  close(): Promise<void>
}

type ParsedOptions = Readonly<{
  host: '127.0.0.1' | '::1'
  port: number
  path: string
  timeoutMs: number
}>

function fail(
  code: FeishuOAuthLoopbackCallbackErrorCode,
  message: string,
): FeishuOAuthLoopbackCallbackError {
  return new FeishuOAuthLoopbackCallbackError(code, message)
}

function readOptions(value: unknown): ParsedOptions {
  try {
    if (value === undefined) value = {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => !['host', 'port', 'path', 'timeoutMs'].includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const host = descriptors.host?.value ?? '127.0.0.1'
    const port = descriptors.port?.value ?? 0
    const path = descriptors.path?.value ?? '/oauth/feishu/callback'
    const timeoutMs = descriptors.timeoutMs?.value ?? FEISHU_OAUTH_LOOPBACK_CALLBACK_TIMEOUT_MS
    if (
      (host !== '127.0.0.1' && host !== '::1') ||
      !Number.isSafeInteger(port) ||
      port < 0 ||
      port > 65_535 ||
      typeof path !== 'string' ||
      !/^\/[A-Za-z0-9/_-]{1,255}$/u.test(path) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > FEISHU_OAUTH_LOOPBACK_CALLBACK_TIMEOUT_MS
    ) {
      throw new TypeError()
    }
    return Object.freeze({ host, port, path, timeoutMs }) as ParsedOptions
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth loopback callback configuration is invalid.')
  }
}

function callbackState(authorizationUrl: unknown, redirectUri: string): string {
  try {
    if (typeof authorizationUrl !== 'string' || authorizationUrl.length > 8192)
      throw new TypeError()
    const authorization = new URL(authorizationUrl)
    const expected = new URL(FEISHU_OAUTH_AUTHORIZE_URL)
    const keys = [...authorization.searchParams.keys()]
    const states = authorization.searchParams.getAll('state')
    const redirects = authorization.searchParams.getAll('redirect_uri')
    if (
      authorization.origin !== expected.origin ||
      authorization.pathname !== expected.pathname ||
      authorization.username !== '' ||
      authorization.password !== '' ||
      authorization.hash !== '' ||
      keys.length !== 8 ||
      ![
        'client_id',
        'response_type',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        'prompt',
      ].every((key) => authorization.searchParams.getAll(key).length === 1) ||
      authorization.searchParams.get('response_type') !== 'code' ||
      authorization.searchParams.get('code_challenge_method') !== 'S256' ||
      authorization.searchParams.get('prompt') !== 'consent' ||
      states.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(states[0] ?? '') ||
      redirects.length !== 1 ||
      redirects[0] !== redirectUri
    ) {
      throw new TypeError()
    }
    return states[0] as string
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth authorization URL is invalid.')
  }
}

function sameState(expected: string, observed: string): boolean {
  const left = new TextEncoder().encode(expected)
  const right = new TextEncoder().encode(observed)
  try {
    return left.byteLength === right.byteLength && timingSafeEqual(left, right)
  } finally {
    left.fill(0)
    right.fill(0)
  }
}

function acceptedTarget(
  request: IncomingMessage,
  redirectUri: string,
  state: string,
): string | undefined {
  const target = request.url
  if (
    request.method !== 'GET' ||
    typeof target !== 'string' ||
    target.length === 0 ||
    Buffer.byteLength(target) > FEISHU_OAUTH_LOOPBACK_CALLBACK_MAX_TARGET_BYTES ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
  ) {
    return undefined
  }
  let callback: URL
  try {
    callback = new URL(target, redirectUri)
  } catch {
    return undefined
  }
  const redirect = new URL(redirectUri)
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.hash !== ''
  ) {
    return undefined
  }
  const keys = [...callback.searchParams.keys()]
  const states = callback.searchParams.getAll('state')
  const codes = callback.searchParams.getAll('code')
  const errors = callback.searchParams.getAll('error')
  const success =
    codes.length === 1 &&
    /^[A-Za-z0-9_-]{1,4096}$/u.test(codes[0] ?? '') &&
    errors.length === 0 &&
    keys.length === 2 &&
    keys.every((key) => key === 'code' || key === 'state')
  const denied =
    codes.length === 0 &&
    errors.length === 1 &&
    errors[0] === 'access_denied' &&
    keys.length === 2 &&
    keys.every((key) => key === 'error' || key === 'state')
  if (states.length !== 1 || !sameState(state, states[0] ?? '') || (!success && !denied)) {
    return undefined
  }
  return callback.toString()
}

function respond(response: ServerResponse, status: number): void {
  const body = status === 200 ? 'Authorization received. Return to TwinDesk.' : 'Not found.'
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

class DefaultListener implements FeishuOAuthLoopbackCallbackListener {
  readonly redirectUri: string
  readonly #server: Server
  readonly #timeoutMs: number
  #armed = false
  #closed = false
  #closing: Promise<void> | undefined
  #state: string | undefined
  #resolve: ((value: string) => void) | undefined
  #reject: ((error: FeishuOAuthLoopbackCallbackError) => void) | undefined
  #cleanup: (() => void) | undefined

  constructor(server: Server, redirectUri: string, timeoutMs: number) {
    this.#server = server
    this.redirectUri = redirectUri
    this.#timeoutMs = timeoutMs
    server.on('request', (request, response) => this.#request(request, response))
    server.on('error', () => {
      const error = fail(
        'listen_unavailable',
        'The Feishu OAuth loopback listener became unavailable.',
      )
      if (this.#reject === undefined) void this.#closeServer()
      else void this.#settleError(error)
    })
  }

  wait(authorizationUrl: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw fail('cancelled', 'The Feishu OAuth callback was cancelled.')
    if (this.#armed || this.#closed) {
      throw fail('already_armed', 'The Feishu OAuth loopback listener is not available.')
    }
    this.#state = callbackState(authorizationUrl, this.redirectUri)
    this.#armed = true
    return new Promise<string>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
      const onAbort = (): void =>
        void this.#settleError(fail('cancelled', 'The Feishu OAuth callback was cancelled.'))
      const timer = setTimeout(
        () => void this.#settleError(fail('timeout', 'The Feishu OAuth callback timed out.')),
        this.#timeoutMs,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      this.#cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        clearTimeout(timer)
      }
    })
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    if (this.#closed) return
    if (this.#reject !== undefined) {
      await this.#settleError(fail('cancelled', 'The Feishu OAuth callback was cancelled.'))
      return
    }
    await this.#closeServer()
  }

  async #closeServer(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    if (this.#closed) return
    this.#closed = true
    this.#state = undefined
    this.#resolve = undefined
    this.#reject = undefined
    this.#cleanup?.()
    this.#cleanup = undefined
    this.#closing = this.#server.listening
      ? new Promise<void>((resolve) => this.#server.close(() => resolve()))
      : Promise.resolve()
    return this.#closing
  }

  #request(request: IncomingMessage, response: ServerResponse): void {
    const callback =
      this.#armed && this.#state !== undefined
        ? acceptedTarget(request, this.redirectUri, this.#state)
        : undefined
    if (callback === undefined || this.#resolve === undefined) {
      respond(response, 404)
      return
    }
    const resolve = this.#resolve
    this.#cleanup?.()
    this.#resolve = undefined
    this.#reject = undefined
    this.#cleanup = undefined
    respond(response, 200)
    void this.#closeServer().then(() => resolve(callback))
  }

  async #settleError(error: FeishuOAuthLoopbackCallbackError): Promise<void> {
    const reject = this.#reject
    if (reject === undefined) return
    this.#cleanup?.()
    this.#resolve = undefined
    this.#reject = undefined
    this.#cleanup = undefined
    await this.#closeServer()
    reject(error)
  }
}

export class FeishuOAuthLoopbackCallbackHost {
  readonly #options: ParsedOptions

  constructor(options?: FeishuOAuthLoopbackCallbackHostOptions) {
    this.#options = readOptions(options)
  }

  async listen(signal: AbortSignal): Promise<FeishuOAuthLoopbackCallbackListener> {
    if (signal.aborted) throw fail('cancelled', 'The Feishu OAuth callback was cancelled.')
    const server = createServer({
      headersTimeout: 5_000,
      keepAliveTimeout: 1_000,
      maxHeaderSize: 8192,
      requestTimeout: 5_000,
    })
    server.maxConnections = 16
    const options = this.#options
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (action: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          action()
        }
        const onAbort = (): void =>
          finish(() => {
            server.close(() => undefined)
            reject(fail('cancelled', 'The Feishu OAuth callback was cancelled.'))
          })
        const onError = (): void =>
          finish(() =>
            reject(
              fail('listen_unavailable', 'The Feishu OAuth loopback listener could not start.'),
            ),
          )
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort)
          server.removeListener('error', onError)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        server.once('error', onError)
        server.listen({ host: options.host, port: options.port, exclusive: true }, () => {
          finish(resolve)
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new TypeError()
      const host = options.host === '::1' ? '[::1]' : options.host
      return new DefaultListener(
        server,
        `http://${host}:${address.port}${options.path}`,
        options.timeoutMs,
      )
    } catch (error) {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (error instanceof FeishuOAuthLoopbackCallbackError) throw error
      throw fail('listen_unavailable', 'The Feishu OAuth loopback listener could not start.')
    }
  }
}
