import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  createFixtureInboxService,
  FIXTURE_INBOX_STATES,
  type FixtureInboxService,
} from '@twindesk/plugin-work-hub/fixture-inbox'

import { resolveTwinDeskRoute } from './routes.ts'
import {
  parseFeishuOAuthSettingsUpdate,
  parseFeishuSettingsSnapshot,
  parseFeishuUserIdentityCreate,
} from './feishu-settings-contract.ts'
import { parseFeishuAuthorizationSnapshot } from './feishu-authorization-contract.ts'
import { parseFeishuOAuthRecoverySnapshot } from './feishu-oauth-recovery-contract.ts'

const outputRoot = dirname(fileURLToPath(import.meta.url))
const ASSETS = new Map([
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/audit-contract.js', { file: 'audit-contract.js', type: 'text/javascript; charset=utf-8' }],
  [
    '/feishu-authorization-contract.js',
    { file: 'feishu-authorization-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-oauth-recovery-contract.js',
    { file: 'feishu-oauth-recovery-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-settings-contract.js',
    { file: 'feishu-settings-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  ['/inbox-contract.js', { file: 'inbox-contract.js', type: 'text/javascript; charset=utf-8' }],
  ['/routes.js', { file: 'routes.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
])
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ')
const FEISHU_SETTINGS_BODY_MAX_BYTES = 16 * 1024
const FEISHU_CLIENT_SECRET_MAX_BYTES = 512
const FEISHU_SETTINGS_CSRF_HEADER = 'x-twindesk-csrf-token'
const FEISHU_USER_IDENTITY_CREATION_HEADER = 'x-twindesk-user-identity-creation'
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Options for the local-only TwinDesk product Web server. */
export interface TwinDeskWebServerOptions {
  readonly host?: '127.0.0.1' | '::1'
  readonly port?: number
  /** Stage 1 business database. Omit to keep fixture data in memory. */
  readonly databasePath?: string
  /** Presentation-safe Feishu Settings service supplied by the Workbench composition root. */
  readonly feishuSettings?: {
    read(): Promise<unknown>
    updateOAuth?(value: unknown): Promise<unknown>
    createUserIdentity?(value: unknown): Promise<unknown>
  }
  /** Memory-only initial OAuth authorization service supplied by Workbench. */
  readonly feishuAuthorization?: {
    read(): Promise<unknown> | unknown
    start(clientSecret: Uint8Array): Promise<unknown>
    cancel(): Promise<unknown>
  }
  /** Identifier-free durable OAuth recovery state supplied by Workbench. */
  readonly feishuOAuthRecovery?: {
    read(): Promise<unknown> | unknown
  }
}

type FeishuSettingsService = NonNullable<TwinDeskWebServerOptions['feishuSettings']>
type FeishuSettingsSnapshot = ReturnType<typeof parseFeishuSettingsSnapshot>
type FeishuAuthorizationService = NonNullable<TwinDeskWebServerOptions['feishuAuthorization']>
type FeishuOAuthRecoveryService = NonNullable<TwinDeskWebServerOptions['feishuOAuthRecovery']>

function normalizeFeishuSettingsService(value: unknown): FeishuSettingsService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      !keys.includes('read') ||
      keys.some((key) => key !== 'read' && key !== 'updateOAuth' && key !== 'createUserIdentity') ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value
    const updateOAuth = descriptors.updateOAuth?.value
    const createUserIdentity = descriptors.createUserIdentity?.value
    if (
      typeof read !== 'function' ||
      (descriptors.updateOAuth !== undefined && typeof updateOAuth !== 'function') ||
      (descriptors.createUserIdentity !== undefined && typeof createUserIdentity !== 'function')
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      read: () => Reflect.apply(read as () => Promise<unknown>, value, []),
      ...(typeof updateOAuth === 'function'
        ? {
            updateOAuth: (update: unknown) =>
              Reflect.apply(updateOAuth as (update: unknown) => Promise<unknown>, value, [update]),
          }
        : {}),
      ...(typeof createUserIdentity === 'function'
        ? {
            createUserIdentity: (create: unknown) =>
              Reflect.apply(createUserIdentity as (create: unknown) => Promise<unknown>, value, [
                create,
              ]),
          }
        : {}),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu Settings service is invalid.')
  }
}

function normalizeFeishuAuthorizationService(
  value: unknown,
): FeishuAuthorizationService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.length !== 3 ||
      !['read', 'start', 'cancel'].every((key) => keys.includes(key)) ||
      Object.values(descriptors).some(
        (descriptor) =>
          !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function',
      )
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value as () => unknown
    const start = descriptors.start?.value as (clientSecret: Uint8Array) => Promise<unknown>
    const cancel = descriptors.cancel?.value as () => Promise<unknown>
    return Object.freeze({
      read: () => Promise.resolve(Reflect.apply(read, value, [])),
      start: (clientSecret: Uint8Array) => Reflect.apply(start, value, [clientSecret]),
      cancel: () => Reflect.apply(cancel, value, []),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu authorization service is invalid.')
  }
}

function normalizeFeishuOAuthRecoveryService(
  value: unknown,
): FeishuOAuthRecoveryService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const readDescriptor = descriptors.read
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      readDescriptor === undefined ||
      !Object.hasOwn(readDescriptor, 'value') ||
      typeof readDescriptor.value !== 'function'
    ) {
      throw new TypeError()
    }
    const read = readDescriptor.value as () => unknown
    return Object.freeze({ read: () => Promise.resolve(Reflect.apply(read, value, [])) })
  } catch {
    throw new TypeError('TwinDesk Web Feishu OAuth recovery service is invalid.')
  }
}

function feishuSettingsCapabilityHeaders(
  settings: FeishuSettingsService,
  snapshot: FeishuSettingsSnapshot,
  csrfToken: string,
): Record<string, string> {
  const oauthWritable = typeof settings.updateOAuth === 'function'
  const userIdentityCreation =
    typeof settings.createUserIdentity === 'function' && !snapshot.identities.includes('user')
      ? snapshot.identities.includes('bot')
        ? 'existing'
        : 'new'
      : undefined
  const csrfAvailable = oauthWritable || userIdentityCreation !== undefined
  return {
    'x-twindesk-settings-writable': oauthWritable ? 'true' : 'false',
    ...(userIdentityCreation === undefined
      ? {}
      : { [FEISHU_USER_IDENTITY_CREATION_HEADER]: userIdentityCreation }),
    ...(csrfAvailable ? { [FEISHU_SETTINGS_CSRF_HEADER]: csrfToken } : {}),
  }
}

async function serveFeishuSettingsApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  settings: TwinDeskWebServerOptions['feishuSettings'],
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid Feishu Settings query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (settings === undefined) {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu Settings unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  let snapshot: FeishuSettingsSnapshot
  try {
    snapshot = parseFeishuSettingsSnapshot(await settings.read())
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu Settings unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    ...feishuSettingsCapabilityHeaders(settings, snapshot, csrfToken),
  })
  response.end(headOnly ? undefined : body)
}

class FeishuSettingsRequestError extends Error {
  readonly status: 400 | 403 | 413 | 415

  constructor(status: 400 | 403 | 413 | 415) {
    super('The Feishu Settings update request is invalid.')
    this.name = 'FeishuSettingsRequestError'
    this.status = status
  }
}

function csrfMatches(observed: string | string[] | undefined, expected: string): boolean {
  if (typeof observed !== 'string') return false
  const left = Buffer.from(observed, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function assertLocalWriteHeaders(
  request: IncomingMessage,
  expectedOrigin: string,
  csrfToken: string,
  contentType: string,
  maximumBodyBytes: number,
): void {
  const expectedAuthority = new URL(expectedOrigin).host
  if (
    request.headers.host !== expectedAuthority ||
    request.headers.origin !== expectedOrigin ||
    request.headers['sec-fetch-site'] !== 'same-origin' ||
    !csrfMatches(request.headers[FEISHU_SETTINGS_CSRF_HEADER], csrfToken)
  ) {
    throw new FeishuSettingsRequestError(403)
  }
  if (request.headers['content-type'] !== contentType) {
    throw new FeishuSettingsRequestError(415)
  }
  const contentLength = request.headers['content-length']
  if (
    request.headers['transfer-encoding'] !== undefined ||
    typeof contentLength !== 'string' ||
    !/^[1-9][0-9]{0,5}$/u.test(contentLength)
  ) {
    throw new FeishuSettingsRequestError(400)
  }
  const length = Number(contentLength)
  if (length > maximumBodyBytes) throw new FeishuSettingsRequestError(413)
}

async function readBoundedBody(
  request: IncomingMessage,
  maximumBodyBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  const chunks: Buffer[] = []
  let total = 0
  let oversized = false
  try {
    for await (const chunkValue of request) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue as Uint8Array)
      try {
        total += chunk.byteLength
        if (total > maximumBodyBytes) oversized = true
        if (!oversized) chunks.push(Buffer.from(chunk))
      } finally {
        chunk.fill(0)
      }
    }
    if (oversized) throw new FeishuSettingsRequestError(413)
    if (total !== declaredLength) throw new FeishuSettingsRequestError(400)
    return Buffer.concat(chunks, total)
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

async function readFeishuSettingsUpdate(request: IncomingMessage): Promise<unknown> {
  const body = await readBoundedBody(request, FEISHU_SETTINGS_BODY_MAX_BYTES)
  try {
    try {
      return JSON.parse(UTF8_DECODER.decode(body)) as unknown
    } catch {
      throw new FeishuSettingsRequestError(400)
    }
  } finally {
    body.fill(0)
  }
}

function requestFailureMessage(status: number): string {
  if (status === 403) return 'Feishu Settings write forbidden.\n'
  if (status === 413) return 'Feishu Settings request too large.\n'
  if (status === 415) return 'Feishu Settings content type unsupported.\n'
  return 'Invalid Feishu Settings update.\n'
}

function authorizationRequestFailureMessage(status: number): string {
  if (status === 403) return 'Feishu authorization forbidden.\n'
  if (status === 413) return 'Feishu authorization request too large.\n'
  if (status === 415) return 'Feishu authorization content type unsupported.\n'
  if (status === 503) return 'Feishu authorization unavailable.\n'
  return 'Invalid Feishu authorization request.\n'
}

async function serveFeishuSettingsUpdateApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  settings: TwinDeskWebServerOptions['feishuSettings'],
  expectedOrigin: string,
  csrfToken: string,
  operation: 'oauth' | 'user_identity',
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid Feishu Settings update.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      FEISHU_SETTINGS_BODY_MAX_BYTES,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    send(response, status, requestFailureMessage(status), 'text/plain; charset=utf-8')
    return
  }
  if (settings === undefined) {
    request.resume()
    send(response, 503, 'Feishu Settings unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  const writer = operation === 'oauth' ? settings.updateOAuth : settings.createUserIdentity
  if (writer === undefined) {
    request.resume()
    send(response, 503, 'Feishu Settings unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let update: unknown
  try {
    const value = await readFeishuSettingsUpdate(request)
    update =
      operation === 'oauth'
        ? parseFeishuOAuthSettingsUpdate(value)
        : parseFeishuUserIdentityCreate(value)
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(response, status, requestFailureMessage(status), 'text/plain; charset=utf-8')
    return
  }
  let snapshot: FeishuSettingsSnapshot
  try {
    snapshot = parseFeishuSettingsSnapshot(await writer(update))
    if (operation === 'user_identity') {
      if (!snapshot.identities.includes('user')) throw new TypeError()
    } else {
      const oauthUpdate = update as ReturnType<typeof parseFeishuOAuthSettingsUpdate>
      if (
        !snapshot.identities.includes('user') ||
        snapshot.oauth === null ||
        !snapshot.oauth.appMatchesIdentity ||
        snapshot.oauth.redirectHost !== oauthUpdate.redirectHost ||
        snapshot.oauth.redirectPort !== oauthUpdate.redirectPort ||
        snapshot.oauth.scopes.length !== oauthUpdate.scopes.length ||
        snapshot.oauth.scopes.some((scope, index) => scope !== oauthUpdate.scopes[index])
      ) {
        throw new TypeError()
      }
    }
  } catch {
    send(response, 503, 'Feishu Settings unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    ...feishuSettingsCapabilityHeaders(settings, snapshot, csrfToken),
  })
  response.end(body)
}

async function serveFeishuAuthorizationApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  authorization: FeishuAuthorizationService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid Feishu authorization query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (authorization === undefined) {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu authorization unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  let snapshot: ReturnType<typeof parseFeishuAuthorizationSnapshot>
  try {
    snapshot = parseFeishuAuthorizationSnapshot(await authorization.read())
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu authorization unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    [FEISHU_SETTINGS_CSRF_HEADER]: csrfToken,
  })
  response.end(headOnly ? undefined : body)
}

async function serveFeishuOAuthRecoveryApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  recovery: FeishuOAuthRecoveryService | undefined,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid Feishu OAuth recovery query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (recovery === undefined) {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu OAuth recovery unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  let snapshot: ReturnType<typeof parseFeishuOAuthRecoverySnapshot>
  try {
    snapshot = parseFeishuOAuthRecoverySnapshot(await recovery.read())
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu OAuth recovery unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(headOnly ? undefined : body)
}

function parseAuthorizationCancel(value: unknown): void {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      descriptors.version?.value !== 1 ||
      !Object.hasOwn(descriptors.version, 'value')
    ) {
      throw new TypeError()
    }
  } catch {
    throw new FeishuSettingsRequestError(400)
  }
}

async function serveFeishuAuthorizationMutationApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  authorization: FeishuAuthorizationService | undefined,
  recovery: FeishuOAuthRecoveryService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  operation: 'start' | 'cancel',
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid Feishu authorization request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      operation === 'start' ? 'application/octet-stream' : 'application/json',
      operation === 'start' ? FEISHU_CLIENT_SECRET_MAX_BYTES : FEISHU_SETTINGS_BODY_MAX_BYTES,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    send(response, status, authorizationRequestFailureMessage(status), 'text/plain; charset=utf-8')
    return
  }
  if (authorization === undefined) {
    request.resume()
    send(response, 503, 'Feishu authorization unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  if (operation === 'start') {
    let recoverySnapshot: ReturnType<typeof parseFeishuOAuthRecoverySnapshot>
    try {
      if (recovery === undefined) throw new TypeError()
      recoverySnapshot = parseFeishuOAuthRecoverySnapshot(await recovery.read())
    } catch {
      request.resume()
      send(response, 503, 'Feishu OAuth recovery unavailable.\n', 'text/plain; charset=utf-8')
      return
    }
    if (recoverySnapshot.state !== 'not_started' && recoverySnapshot.state !== 'ready') {
      request.resume()
      send(
        response,
        409,
        'Feishu OAuth recovery requires attention.\n',
        'text/plain; charset=utf-8',
      )
      return
    }
  }
  let snapshot: ReturnType<typeof parseFeishuAuthorizationSnapshot>
  if (operation === 'start') {
    let clientSecret: Buffer | undefined
    try {
      clientSecret = await readBoundedBody(request, FEISHU_CLIENT_SECRET_MAX_BYTES)
    } catch (error) {
      if (!request.complete) request.resume()
      const status = error instanceof FeishuSettingsRequestError ? error.status : 400
      send(
        response,
        status,
        authorizationRequestFailureMessage(status),
        'text/plain; charset=utf-8',
      )
      return
    }
    let result: unknown
    try {
      result = await authorization.start(clientSecret)
    } catch {
      send(response, 409, 'Feishu authorization already active.\n', 'text/plain; charset=utf-8')
      return
    } finally {
      clientSecret.fill(0)
    }
    try {
      snapshot = parseFeishuAuthorizationSnapshot(result)
      if (snapshot.state === 'idle' || snapshot.state === 'starting') throw new TypeError()
    } catch {
      send(response, 503, authorizationRequestFailureMessage(503), 'text/plain; charset=utf-8')
      return
    }
  } else {
    try {
      parseAuthorizationCancel(await readFeishuSettingsUpdate(request))
      snapshot = parseFeishuAuthorizationSnapshot(await authorization.cancel())
    } catch (error) {
      if (!request.complete) request.resume()
      const status = error instanceof FeishuSettingsRequestError ? error.status : 503
      send(
        response,
        status,
        authorizationRequestFailureMessage(status),
        'text/plain; charset=utf-8',
      )
      return
    }
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    [FEISHU_SETTINGS_CSRF_HEADER]: csrfToken,
  })
  response.end(body)
}

/** Running local server with explicit, idempotent shutdown. */
export interface RunningTwinDeskWebServer {
  readonly host: string
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

function commonHeaders(contentType: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

function send(response: ServerResponse, status: number, body: string | Buffer, type: string): void {
  response.writeHead(status, commonHeaders(type))
  response.end(body)
}

function inboxStateFrom(requestUrl: URL): (typeof FIXTURE_INBOX_STATES)[number] | undefined {
  for (const key of requestUrl.searchParams.keys()) {
    if (key !== 'state') throw new TypeError('Unsupported Inbox query parameter.')
  }
  const values = requestUrl.searchParams.getAll('state')
  if (values.length === 0) return undefined
  if (values.length !== 1 || !FIXTURE_INBOX_STATES.includes(values[0] as never)) {
    throw new TypeError('Unsupported Inbox state.')
  }
  return values[0] as (typeof FIXTURE_INBOX_STATES)[number]
}

function serveInboxApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  inbox: FixtureInboxService,
): void {
  let state: (typeof FIXTURE_INBOX_STATES)[number] | undefined
  try {
    state = inboxStateFrom(requestUrl)
  } catch {
    send(response, 400, headOnly ? '' : 'Invalid Inbox query.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = JSON.stringify(inbox.read(state))
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(headOnly ? undefined : body)
}

function serveAuditApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  inbox: FixtureInboxService,
): void {
  if (requestUrl.search.length > 0) {
    send(response, 400, headOnly ? '' : 'Invalid Audit query.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = JSON.stringify(inbox.readAudit())
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(headOnly ? undefined : body)
}

async function serveAsset(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const asset = ASSETS.get(pathname)
  if (asset === undefined) {
    send(response, 404, 'Not found.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = await readFile(join(outputRoot, asset.file))
  response.writeHead(200, {
    ...commonHeaders(asset.type),
    'content-length': String(body.byteLength),
  })
  response.end(headOnly ? undefined : body)
}

async function serveIndex(response: ServerResponse, headOnly: boolean): Promise<void> {
  const body = await readFile(join(outputRoot, 'index.html'))
  response.writeHead(200, {
    ...commonHeaders('text/html; charset=utf-8'),
    'content-length': String(body.byteLength),
  })
  response.end(headOnly ? undefined : body)
}

function addressOf(server: Server): { host: string; port: number } {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('TwinDesk Web server did not acquire a TCP address')
  }
  return { host: address.address, port: address.port }
}

/**
 * Start the product-owned local Web shell without exposing it to the network.
 * @param options - optional loopback host and TCP port; port 0 selects an available port.
 * @returns the running server and its idempotent shutdown operation.
 */
export async function startTwinDeskWebServer(
  options: TwinDeskWebServerOptions = {},
): Promise<RunningTwinDeskWebServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4173
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('TwinDesk Web must bind to loopback')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('TwinDesk Web port must be an integer from 0 through 65535')
  }
  const feishuSettings = normalizeFeishuSettingsService(options.feishuSettings)
  const feishuAuthorization = normalizeFeishuAuthorizationService(options.feishuAuthorization)
  const feishuOAuthRecovery = normalizeFeishuOAuthRecoveryService(options.feishuOAuthRecovery)

  const inbox = createFixtureInboxService(options.databasePath, {
    includeAudit: true,
    includeDraftFlow: true,
  })
  const csrfToken = randomBytes(32).toString('base64url')
  let boundOrigin: string | undefined

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET'
      const requestUrl = new URL(request.url ?? '/', `http://${host}`)
      const oauthSettingsUpdate =
        method === 'POST' && requestUrl.pathname === '/api/settings/feishu'
      const userIdentityCreate =
        method === 'POST' && requestUrl.pathname === '/api/settings/feishu/user-identity'
      const authorizationStart =
        method === 'POST' && requestUrl.pathname === '/api/authorization/feishu/start'
      const authorizationCancel =
        method === 'POST' && requestUrl.pathname === '/api/authorization/feishu/cancel'
      const supportedMutation =
        oauthSettingsUpdate || userIdentityCreate || authorizationStart || authorizationCancel
      if (method !== 'GET' && method !== 'HEAD' && !supportedMutation) {
        response.setHeader(
          'allow',
          requestUrl.pathname === '/api/settings/feishu'
            ? 'GET, HEAD, POST'
            : requestUrl.pathname === '/api/settings/feishu/user-identity'
              ? 'POST'
              : requestUrl.pathname === '/api/authorization/feishu/start' ||
                  requestUrl.pathname === '/api/authorization/feishu/cancel'
                ? 'POST'
                : 'GET, HEAD',
        )
        send(response, 405, 'Method not allowed.\n', 'text/plain; charset=utf-8')
        return
      }

      if (oauthSettingsUpdate || userIdentityCreate) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuSettingsUpdateApi(
          request,
          response,
          requestUrl,
          feishuSettings,
          boundOrigin,
          csrfToken,
          oauthSettingsUpdate ? 'oauth' : 'user_identity',
        )
        return
      }
      if (authorizationStart || authorizationCancel) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuAuthorizationMutationApi(
          request,
          response,
          requestUrl,
          feishuAuthorization,
          feishuOAuthRecovery,
          boundOrigin,
          csrfToken,
          authorizationStart ? 'start' : 'cancel',
        )
        return
      }
      if (requestUrl.pathname === '/health') {
        const body = JSON.stringify({ service: 'twindesk-web', status: 'ok', version: 1 })
        send(response, 200, method === 'HEAD' ? '' : body, 'application/json; charset=utf-8')
        return
      }
      if (requestUrl.pathname === '/api/inbox') {
        serveInboxApi(response, requestUrl, method === 'HEAD', inbox)
        return
      }
      if (requestUrl.pathname === '/api/audit') {
        serveAuditApi(response, requestUrl, method === 'HEAD', inbox)
        return
      }
      if (requestUrl.pathname === '/api/settings/feishu') {
        await serveFeishuSettingsApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuSettings,
          csrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/authorization/feishu') {
        await serveFeishuAuthorizationApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuAuthorization,
          csrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/recovery/feishu/oauth') {
        await serveFeishuOAuthRecoveryApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuOAuthRecovery,
        )
        return
      }
      if (ASSETS.has(requestUrl.pathname)) {
        await serveAsset(response, requestUrl.pathname, method === 'HEAD')
        return
      }
      if (resolveTwinDeskRoute(requestUrl.pathname) !== undefined) {
        await serveIndex(response, method === 'HEAD')
        return
      }
      send(response, 404, 'Not found.\n', 'text/plain; charset=utf-8')
    })().catch(() => {
      if (!response.headersSent) {
        send(response, 500, 'Internal server error.\n', 'text/plain; charset=utf-8')
      } else {
        response.destroy()
      }
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (error) {
    inbox.close()
    throw error
  }

  const address = addressOf(server)
  const displayHost = address.host.includes(':') ? `[${address.host}]` : address.host
  boundOrigin = `http://${displayHost}:${address.port}`
  let closing: Promise<void> | undefined
  return {
    host: address.host,
    port: address.port,
    url: boundOrigin,
    close() {
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) reject(error)
            else resolve()
          })
        })
        try {
          try {
            await feishuAuthorization?.cancel()
          } catch {
            // Shutdown still owns the HTTP and Inbox lifecycles when cancellation fails.
          }
          await serverClosed
        } finally {
          inbox.close()
        }
      })()
      return closing
    },
  }
}
