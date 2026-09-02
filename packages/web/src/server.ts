import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  createFixtureInboxService,
  createFixtureInboxServiceFromDatabase,
  FIXTURE_INBOX_STATES,
  type FixtureInboxService,
} from '@twindesk/plugin-work-hub/fixture-inbox'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

import { resolveTwinDeskRoute } from './routes.ts'
import {
  parseFeishuOAuthSettingsUpdate,
  parseFeishuSettingsSnapshot,
  parseFeishuUserIdentityCreate,
} from './feishu-settings-contract.ts'
import { parseFeishuAuthorizationSnapshot } from './feishu-authorization-contract.ts'
import { parseFeishuOAuthRecoverySnapshot } from './feishu-oauth-recovery-contract.ts'
import { parseFeishuOAuthReconciliationSnapshot } from './feishu-oauth-reconciliation-contract.ts'
import { parseFeishuReauthorizationSnapshot } from './feishu-reauthorization-contract.ts'
import {
  parseFeishuReplyApprovalDecisionRequest,
  parseFeishuReplyApprovalRequest,
  parseFeishuReplyApprovalSnapshot,
  parseFeishuReplyApprovalStatusSnapshot,
} from './feishu-reply-approval-contract.ts'
import {
  parseFeishuReplyExecutionRequest,
  parseFeishuReplyExecutionSnapshot,
  parseFeishuReplyExecutionStatusSnapshot,
} from './feishu-reply-execution-contract.ts'
import {
  parseFeishuReplyProposalCreateRequest,
  parseFeishuReplyProposalSnapshot,
  parseFeishuReplyProposalStatusSnapshot,
} from './feishu-reply-proposal-contract.ts'
import {
  parseModelDraftCreateRequest,
  parseModelDraftCreateSnapshot,
  parseModelDraftEditRequest,
  parseModelDraftEditSnapshot,
  parseModelDraftStatusSnapshot,
} from './model-draft-contract.ts'

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
    '/feishu-oauth-reconciliation-contract.js',
    { file: 'feishu-oauth-reconciliation-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-reauthorization-contract.js',
    { file: 'feishu-reauthorization-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-reply-approval-contract.js',
    { file: 'feishu-reply-approval-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-reply-execution-contract.js',
    { file: 'feishu-reply-execution-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-reply-proposal-contract.js',
    { file: 'feishu-reply-proposal-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/feishu-settings-contract.js',
    { file: 'feishu-settings-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
  ['/inbox-contract.js', { file: 'inbox-contract.js', type: 'text/javascript; charset=utf-8' }],
  [
    '/model-draft-contract.js',
    { file: 'model-draft-contract.js', type: 'text/javascript; charset=utf-8' },
  ],
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
const MODEL_DRAFT_BODY_MAX_BYTES = 1_024
const MODEL_DRAFT_EDIT_BODY_MAX_BYTES = 66 * 1_024
const FEISHU_REPLY_PROPOSAL_BODY_MAX_BYTES = 1_024
const FEISHU_REPLY_APPROVAL_BODY_MAX_BYTES = 1_024
const FEISHU_REPLY_EXECUTION_BODY_MAX_BYTES = 1_024
const FEISHU_SETTINGS_CSRF_HEADER = 'x-twindesk-csrf-token'
const MODEL_DRAFT_CSRF_HEADER = 'x-twindesk-model-draft-csrf-token'
const FEISHU_REPLY_PROPOSAL_CSRF_HEADER = 'x-twindesk-action-proposal-csrf-token'
const FEISHU_REPLY_APPROVAL_CSRF_HEADER = 'x-twindesk-action-approval-csrf-token'
const FEISHU_REPLY_EXECUTION_CSRF_HEADER = 'x-twindesk-action-execution-csrf-token'
const FEISHU_USER_IDENTITY_CREATION_HEADER = 'x-twindesk-user-identity-creation'
const FEISHU_OAUTH_RECONCILIATION_HEADER = 'x-twindesk-oauth-reconciliation'
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Options for the local-only TwinDesk product Web server. */
export interface TwinDeskWebServerOptions {
  readonly host?: '127.0.0.1' | '::1'
  readonly port?: number
  /** Stage 1 business database. Omit to keep fixture data in memory. */
  readonly databasePath?: string
  /** Caller-owned Stage 1 database. Mutually exclusive with `databasePath`. */
  readonly database?: TwinDeskDatabase
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
  /** Explicit local-only Keychain/journal reconciliation supplied by Workbench. */
  readonly feishuOAuthReconciliation?: {
    reconcile(signal: AbortSignal): Promise<unknown>
  }
  /** Memory-only hosted OAuth reauthorization service supplied by Workbench. */
  readonly feishuReauthorization?: {
    read(): Promise<unknown> | unknown
    start(clientSecret: Uint8Array): Promise<unknown>
    cancel(): Promise<unknown>
  }
  /** Host-controlled model Draft entry; browser input is limited to a Work Item identity. */
  readonly modelDraft?: {
    read(): Promise<unknown> | unknown
    create(workItemId: string, signal: AbortSignal): Promise<unknown>
    edit?(request: unknown, signal: AbortSignal): Promise<unknown>
  }
  /** Host-controlled exact Feishu User reply preview; it cannot approve or execute. */
  readonly feishuReplyProposal?: {
    read(): Promise<unknown> | unknown
    create(request: unknown, signal: AbortSignal): Promise<unknown>
  }
  /** Host-controlled exact one-time approval; it cannot consume approval or execute. */
  readonly feishuReplyApproval?: {
    read(): Promise<unknown> | unknown
    request(request: unknown, signal: AbortSignal): Promise<unknown>
    decide(request: unknown, signal: AbortSignal): Promise<unknown>
  }
  /** Host-controlled execution of one exact durable approval. */
  readonly feishuReplyExecution?: {
    read(): Promise<unknown> | unknown
    execute(request: unknown, signal: AbortSignal): Promise<unknown>
  }
}

type FeishuSettingsService = NonNullable<TwinDeskWebServerOptions['feishuSettings']>
type FeishuSettingsSnapshot = ReturnType<typeof parseFeishuSettingsSnapshot>
type FeishuAuthorizationService = NonNullable<TwinDeskWebServerOptions['feishuAuthorization']>
type FeishuOAuthRecoveryService = NonNullable<TwinDeskWebServerOptions['feishuOAuthRecovery']>
type FeishuOAuthReconciliationService = NonNullable<
  TwinDeskWebServerOptions['feishuOAuthReconciliation']
>
type FeishuReauthorizationService = NonNullable<TwinDeskWebServerOptions['feishuReauthorization']>
type ModelDraftService = NonNullable<TwinDeskWebServerOptions['modelDraft']>
type FeishuReplyProposalService = NonNullable<TwinDeskWebServerOptions['feishuReplyProposal']>
type FeishuReplyApprovalService = NonNullable<TwinDeskWebServerOptions['feishuReplyApproval']>
type FeishuReplyExecutionService = NonNullable<TwinDeskWebServerOptions['feishuReplyExecution']>

function normalizeFeishuReplyExecutionService(
  value: unknown,
): FeishuReplyExecutionService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['read', 'execute']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(
        (descriptor) =>
          !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function',
      )
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value as () => unknown
    const execute = descriptors.execute?.value as (
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>
    return Object.freeze({
      read: () => Promise.resolve(Reflect.apply(read, value, [])),
      execute: (input: unknown, signal: AbortSignal) =>
        Reflect.apply(execute, value, [input, signal]),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu reply execution service is invalid.')
  }
}

function normalizeFeishuReplyApprovalService(
  value: unknown,
): FeishuReplyApprovalService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['read', 'request', 'decide']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(
        (descriptor) =>
          !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function',
      )
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value as () => unknown
    const request = descriptors.request?.value as (
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>
    const decide = descriptors.decide?.value as (
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>
    return Object.freeze({
      read: () => Promise.resolve(Reflect.apply(read, value, [])),
      request: (input: unknown, signal: AbortSignal) =>
        Reflect.apply(request, value, [input, signal]),
      decide: (input: unknown, signal: AbortSignal) =>
        Reflect.apply(decide, value, [input, signal]),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu reply approval service is invalid.')
  }
}

function normalizeFeishuReplyProposalService(
  value: unknown,
): FeishuReplyProposalService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['read', 'create']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(
        (descriptor) =>
          !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function',
      )
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value as () => unknown
    const create = descriptors.create?.value as (
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>
    return Object.freeze({
      read: () => Promise.resolve(Reflect.apply(read, value, [])),
      create: (request: unknown, signal: AbortSignal) =>
        Reflect.apply(create, value, [request, signal]),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu reply proposal service is invalid.')
  }
}

function normalizeModelDraftService(value: unknown): ModelDraftService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      (Object.keys(descriptors).length !== 2 && Object.keys(descriptors).length !== 3) ||
      !Object.hasOwn(descriptors, 'read') ||
      !Object.hasOwn(descriptors, 'create') ||
      (Object.hasOwn(descriptors, 'edit') && typeof descriptors.edit?.value !== 'function') ||
      Object.values(descriptors).some(
        (descriptor) =>
          !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function',
      )
    ) {
      throw new TypeError()
    }
    const read = descriptors.read?.value as () => unknown
    const create = descriptors.create?.value as (
      workItemId: string,
      signal: AbortSignal,
    ) => Promise<unknown>
    const edit = descriptors.edit?.value as
      ((request: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    return Object.freeze({
      read: () => Promise.resolve(Reflect.apply(read, value, [])),
      create: (workItemId: string, signal: AbortSignal) =>
        Reflect.apply(create, value, [workItemId, signal]),
      ...(edit === undefined
        ? {}
        : {
            edit: (request: unknown, signal: AbortSignal) =>
              Reflect.apply(edit, value, [request, signal]),
          }),
    })
  } catch {
    throw new TypeError('TwinDesk Web model Draft service is invalid.')
  }
}

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

function normalizeFeishuOAuthReconciliationService(
  value: unknown,
): FeishuOAuthReconciliationService | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const reconcileDescriptor = descriptors.reconcile
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      reconcileDescriptor === undefined ||
      !Object.hasOwn(reconcileDescriptor, 'value') ||
      typeof reconcileDescriptor.value !== 'function'
    ) {
      throw new TypeError()
    }
    const reconcile = reconcileDescriptor.value as (signal: AbortSignal) => Promise<unknown>
    return Object.freeze({
      reconcile: (signal: AbortSignal) => Reflect.apply(reconcile, value, [signal]),
    })
  } catch {
    throw new TypeError('TwinDesk Web Feishu OAuth reconciliation service is invalid.')
  }
}

function normalizeFeishuReauthorizationService(
  value: unknown,
): FeishuReauthorizationService | undefined {
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
    throw new TypeError('TwinDesk Web Feishu reauthorization service is invalid.')
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
  csrfHeader = FEISHU_SETTINGS_CSRF_HEADER,
): void {
  const expectedAuthority = new URL(expectedOrigin).host
  if (
    request.headers.host !== expectedAuthority ||
    request.headers.origin !== expectedOrigin ||
    request.headers['sec-fetch-site'] !== 'same-origin' ||
    !csrfMatches(request.headers[csrfHeader], csrfToken)
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

function reauthorizationRequestFailureMessage(status: number): string {
  if (status === 403) return 'Feishu reauthorization forbidden.\n'
  if (status === 413) return 'Feishu reauthorization request too large.\n'
  if (status === 415) return 'Feishu reauthorization content type unsupported.\n'
  if (status === 503) return 'Feishu reauthorization unavailable.\n'
  return 'Invalid Feishu reauthorization request.\n'
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
  reconciliation: FeishuOAuthReconciliationService | undefined,
  csrfToken: string,
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
    ...(reconciliation === undefined ? {} : { [FEISHU_OAUTH_RECONCILIATION_HEADER]: csrfToken }),
  })
  response.end(headOnly ? undefined : body)
}

async function serveFeishuOAuthReconciliationMutationApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  recovery: FeishuOAuthRecoveryService | undefined,
  reconciliation: FeishuOAuthReconciliationService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(
      response,
      400,
      'Invalid Feishu OAuth reconciliation request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      FEISHU_SETTINGS_BODY_MAX_BYTES,
      FEISHU_OAUTH_RECONCILIATION_HEADER,
    )
  } catch (cause) {
    request.resume()
    const status = cause instanceof FeishuSettingsRequestError ? cause.status : 403
    send(response, status, requestFailureMessage(status), 'text/plain; charset=utf-8')
    return
  }
  if (recovery === undefined || reconciliation === undefined) {
    request.resume()
    send(response, 503, 'Feishu OAuth reconciliation unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let before: ReturnType<typeof parseFeishuOAuthRecoverySnapshot>
  try {
    before = parseFeishuOAuthRecoverySnapshot(await recovery.read())
  } catch {
    request.resume()
    send(response, 503, 'Feishu OAuth recovery unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  if (before.state !== 'reconciliation_required') {
    request.resume()
    send(
      response,
      409,
      'Feishu OAuth reconciliation is not pending.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  try {
    parseAuthorizationCancel(await readFeishuSettingsUpdate(request))
  } catch (cause) {
    if (!request.complete) request.resume()
    const status = cause instanceof FeishuSettingsRequestError ? cause.status : 400
    send(response, status, requestFailureMessage(status), 'text/plain; charset=utf-8')
    return
  }
  const controller = new AbortController()
  activeControllers.add(controller)
  let snapshot: ReturnType<typeof parseFeishuOAuthReconciliationSnapshot>
  try {
    snapshot = parseFeishuOAuthReconciliationSnapshot(
      await reconciliation.reconcile(controller.signal),
    )
    const after = parseFeishuOAuthRecoverySnapshot(await recovery.read())
    if (
      (snapshot.status === 'reconciled' && after.state !== 'ready') ||
      (snapshot.status === 'still_required' && after.state !== 'reconciliation_required')
    ) {
      throw new TypeError()
    }
  } catch {
    send(
      response,
      409,
      'Feishu OAuth reconciliation still requires attention.\n',
      'text/plain; charset=utf-8',
    )
    return
  } finally {
    activeControllers.delete(controller)
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    [FEISHU_OAUTH_RECONCILIATION_HEADER]: csrfToken,
  })
  response.end(body)
}

async function serveFeishuReauthorizationApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  reauthorization: FeishuReauthorizationService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid Feishu reauthorization query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (reauthorization === undefined) {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu reauthorization unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  let snapshot: ReturnType<typeof parseFeishuReauthorizationSnapshot>
  try {
    snapshot = parseFeishuReauthorizationSnapshot(await reauthorization.read())
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Feishu reauthorization unavailable.\n',
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

async function serveFeishuReauthorizationMutationApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  reauthorization: FeishuReauthorizationService | undefined,
  recovery: FeishuOAuthRecoveryService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  operation: 'start' | 'cancel',
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid Feishu reauthorization request.\n', 'text/plain; charset=utf-8')
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
  } catch (cause) {
    request.resume()
    const status = cause instanceof FeishuSettingsRequestError ? cause.status : 403
    send(
      response,
      status,
      reauthorizationRequestFailureMessage(status),
      'text/plain; charset=utf-8',
    )
    return
  }
  if (reauthorization === undefined) {
    request.resume()
    send(response, 503, 'Feishu reauthorization unavailable.\n', 'text/plain; charset=utf-8')
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
    if (recoverySnapshot.state !== 'reauthorization_required') {
      request.resume()
      send(
        response,
        409,
        'Feishu OAuth reauthorization is not pending.\n',
        'text/plain; charset=utf-8',
      )
      return
    }
  }
  let snapshot: ReturnType<typeof parseFeishuReauthorizationSnapshot>
  if (operation === 'start') {
    let clientSecret: Buffer | undefined
    try {
      clientSecret = await readBoundedBody(request, FEISHU_CLIENT_SECRET_MAX_BYTES)
    } catch (cause) {
      if (!request.complete) request.resume()
      const status = cause instanceof FeishuSettingsRequestError ? cause.status : 400
      send(
        response,
        status,
        reauthorizationRequestFailureMessage(status),
        'text/plain; charset=utf-8',
      )
      return
    }
    let result: unknown
    try {
      result = await reauthorization.start(clientSecret)
    } catch {
      send(response, 409, 'Feishu reauthorization already active.\n', 'text/plain; charset=utf-8')
      return
    } finally {
      clientSecret.fill(0)
    }
    try {
      snapshot = parseFeishuReauthorizationSnapshot(result)
      if (snapshot.state === 'idle' || snapshot.state === 'starting') throw new TypeError()
    } catch {
      send(response, 503, reauthorizationRequestFailureMessage(503), 'text/plain; charset=utf-8')
      return
    }
  } else {
    try {
      parseAuthorizationCancel(await readFeishuSettingsUpdate(request))
      snapshot = parseFeishuReauthorizationSnapshot(await reauthorization.cancel())
    } catch (cause) {
      if (!request.complete) request.resume()
      const status = cause instanceof FeishuSettingsRequestError ? cause.status : 503
      send(
        response,
        status,
        reauthorizationRequestFailureMessage(status),
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

async function serveModelDraftStatusApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  service: ModelDraftService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(response, 400, headOnly ? '' : 'Invalid model Draft query.\n', 'text/plain; charset=utf-8')
    return
  }
  if (service === undefined) {
    const body = JSON.stringify({ version: 1, capability: 'unavailable', autonomy: 'draft_only' })
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(headOnly ? undefined : body)
    return
  }
  let snapshot: ReturnType<typeof parseModelDraftStatusSnapshot>
  try {
    snapshot = parseModelDraftStatusSnapshot(await service.read())
  } catch {
    send(response, 503, headOnly ? '' : 'Model Draft unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    ...(snapshot.capability === 'ready' ? { [MODEL_DRAFT_CSRF_HEADER]: csrfToken } : {}),
  })
  response.end(headOnly ? undefined : body)
}

async function serveModelDraftCreateApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  service: ModelDraftService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid model Draft request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      MODEL_DRAFT_BODY_MAX_BYTES,
      MODEL_DRAFT_CSRF_HEADER,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    const message =
      status === 403
        ? 'Model Draft request forbidden.\n'
        : status === 413
          ? 'Model Draft request too large.\n'
          : status === 415
            ? 'Model Draft content type unsupported.\n'
            : 'Invalid model Draft request.\n'
    send(response, status, message, 'text/plain; charset=utf-8')
    return
  }
  if (service === undefined) {
    request.resume()
    send(response, 503, 'Model Draft unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let create: ReturnType<typeof parseModelDraftCreateRequest>
  try {
    const body = await readBoundedBody(request, MODEL_DRAFT_BODY_MAX_BYTES)
    try {
      create = parseModelDraftCreateRequest(JSON.parse(UTF8_DECODER.decode(body)) as unknown)
    } finally {
      body.fill(0)
    }
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(
      response,
      status,
      status === 413 ? 'Model Draft request too large.\n' : 'Invalid model Draft request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  activeControllers.add(controller)
  request.once('aborted', abort)
  try {
    const snapshot = parseModelDraftCreateSnapshot(
      await service.create(create.workItemId, controller.signal),
    )
    if (snapshot.draft.workItemId !== create.workItemId) throw new TypeError()
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      [MODEL_DRAFT_CSRF_HEADER]: csrfToken,
    })
    response.end(body)
  } catch {
    send(response, 503, 'Model Draft unavailable.\n', 'text/plain; charset=utf-8')
  } finally {
    request.off('aborted', abort)
    activeControllers.delete(controller)
  }
}

async function serveModelDraftEditApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  service: ModelDraftService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid model Draft edit request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      MODEL_DRAFT_EDIT_BODY_MAX_BYTES,
      MODEL_DRAFT_CSRF_HEADER,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    const message =
      status === 403
        ? 'Model Draft edit forbidden.\n'
        : status === 413
          ? 'Model Draft edit request too large.\n'
          : status === 415
            ? 'Model Draft edit content type unsupported.\n'
            : 'Invalid model Draft edit request.\n'
    send(response, status, message, 'text/plain; charset=utf-8')
    return
  }
  if (service?.edit === undefined) {
    request.resume()
    send(response, 503, 'Model Draft editing unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let edit: ReturnType<typeof parseModelDraftEditRequest>
  try {
    const body = await readBoundedBody(request, MODEL_DRAFT_EDIT_BODY_MAX_BYTES)
    try {
      edit = parseModelDraftEditRequest(JSON.parse(UTF8_DECODER.decode(body)) as unknown)
    } finally {
      body.fill(0)
    }
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(
      response,
      status,
      status === 413
        ? 'Model Draft edit request too large.\n'
        : 'Invalid model Draft edit request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  activeControllers.add(controller)
  request.once('aborted', abort)
  try {
    const snapshot = parseModelDraftEditSnapshot(await service.edit(edit, controller.signal))
    if (snapshot.draft.workItemId !== edit.workItemId) throw new TypeError()
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      [MODEL_DRAFT_CSRF_HEADER]: csrfToken,
    })
    response.end(body)
  } catch {
    send(response, 503, 'Model Draft editing unavailable.\n', 'text/plain; charset=utf-8')
  } finally {
    request.off('aborted', abort)
    activeControllers.delete(controller)
  }
}

async function serveFeishuReplyProposalStatusApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  service: FeishuReplyProposalService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid reply preview query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (service === undefined) {
    const body = JSON.stringify({
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
    })
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(headOnly ? undefined : body)
    return
  }
  let snapshot: ReturnType<typeof parseFeishuReplyProposalStatusSnapshot>
  try {
    snapshot = parseFeishuReplyProposalStatusSnapshot(await service.read())
  } catch {
    send(response, 503, headOnly ? '' : 'Reply preview unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    ...(snapshot.capability === 'ready' ? { [FEISHU_REPLY_PROPOSAL_CSRF_HEADER]: csrfToken } : {}),
  })
  response.end(headOnly ? undefined : body)
}

async function serveFeishuReplyProposalCreateApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  service: FeishuReplyProposalService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid reply preview request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      FEISHU_REPLY_PROPOSAL_BODY_MAX_BYTES,
      FEISHU_REPLY_PROPOSAL_CSRF_HEADER,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    const message =
      status === 403
        ? 'Reply preview request forbidden.\n'
        : status === 413
          ? 'Reply preview request too large.\n'
          : status === 415
            ? 'Reply preview content type unsupported.\n'
            : 'Invalid reply preview request.\n'
    send(response, status, message, 'text/plain; charset=utf-8')
    return
  }
  if (service === undefined) {
    request.resume()
    send(response, 503, 'Reply preview unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let create: ReturnType<typeof parseFeishuReplyProposalCreateRequest>
  try {
    const body = await readBoundedBody(request, FEISHU_REPLY_PROPOSAL_BODY_MAX_BYTES)
    try {
      create = parseFeishuReplyProposalCreateRequest(
        JSON.parse(UTF8_DECODER.decode(body)) as unknown,
      )
    } finally {
      body.fill(0)
    }
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(
      response,
      status,
      status === 413 ? 'Reply preview request too large.\n' : 'Invalid reply preview request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  activeControllers.add(controller)
  request.once('aborted', abort)
  try {
    const snapshot = parseFeishuReplyProposalSnapshot(
      await service.create(create, controller.signal),
    )
    if (
      snapshot.proposal.workItemId !== create.workItemId ||
      snapshot.proposal.draftRevision !== create.draftRevision
    ) {
      throw new TypeError()
    }
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      [FEISHU_REPLY_PROPOSAL_CSRF_HEADER]: csrfToken,
    })
    response.end(body)
  } catch {
    send(response, 503, 'Reply preview unavailable.\n', 'text/plain; charset=utf-8')
  } finally {
    request.off('aborted', abort)
    activeControllers.delete(controller)
  }
}

async function serveFeishuReplyApprovalStatusApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  service: FeishuReplyApprovalService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid reply approval query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (service === undefined) {
    const body = JSON.stringify({
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    })
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(headOnly ? undefined : body)
    return
  }
  let snapshot: ReturnType<typeof parseFeishuReplyApprovalStatusSnapshot>
  try {
    snapshot = parseFeishuReplyApprovalStatusSnapshot(await service.read())
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Reply approval unavailable.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const body = JSON.stringify(snapshot)
  response.writeHead(200, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': String(Buffer.byteLength(body)),
    ...(snapshot.capability === 'ready' ? { [FEISHU_REPLY_APPROVAL_CSRF_HEADER]: csrfToken } : {}),
  })
  response.end(headOnly ? undefined : body)
}

async function serveFeishuReplyApprovalMutationApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  service: FeishuReplyApprovalService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
  operation: 'request' | 'decision',
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid reply approval request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      FEISHU_REPLY_APPROVAL_BODY_MAX_BYTES,
      FEISHU_REPLY_APPROVAL_CSRF_HEADER,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    const message =
      status === 403
        ? 'Reply approval request forbidden.\n'
        : status === 413
          ? 'Reply approval request too large.\n'
          : status === 415
            ? 'Reply approval content type unsupported.\n'
            : 'Invalid reply approval request.\n'
    send(response, status, message, 'text/plain; charset=utf-8')
    return
  }
  if (service === undefined) {
    request.resume()
    send(response, 503, 'Reply approval unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let input:
    | ReturnType<typeof parseFeishuReplyApprovalRequest>
    | ReturnType<typeof parseFeishuReplyApprovalDecisionRequest>
  try {
    const body = await readBoundedBody(request, FEISHU_REPLY_APPROVAL_BODY_MAX_BYTES)
    try {
      const decoded = JSON.parse(UTF8_DECODER.decode(body)) as unknown
      input =
        operation === 'request'
          ? parseFeishuReplyApprovalRequest(decoded)
          : parseFeishuReplyApprovalDecisionRequest(decoded)
    } finally {
      body.fill(0)
    }
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(
      response,
      status,
      status === 413 ? 'Reply approval request too large.\n' : 'Invalid reply approval request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  activeControllers.add(controller)
  request.once('aborted', abort)
  try {
    const snapshot = parseFeishuReplyApprovalSnapshot(
      operation === 'request'
        ? await service.request(input, controller.signal)
        : await service.decide(input, controller.signal),
    )
    if (
      snapshot.operation !== operation ||
      snapshot.proposal.workItemId !== input.workItemId ||
      snapshot.proposal.draftRevision !== input.draftRevision
    ) {
      throw new TypeError()
    }
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      [FEISHU_REPLY_APPROVAL_CSRF_HEADER]: csrfToken,
    })
    response.end(body)
  } catch {
    send(response, 503, 'Reply approval unavailable.\n', 'text/plain; charset=utf-8')
  } finally {
    request.off('aborted', abort)
    activeControllers.delete(controller)
  }
}

async function serveFeishuReplyExecutionStatusApi(
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  service: FeishuReplyExecutionService | undefined,
  csrfToken: string,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    send(
      response,
      400,
      headOnly ? '' : 'Invalid reply execution query.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (service === undefined) {
    const body = JSON.stringify({
      version: 1,
      capability: 'unavailable',
      actionType: 'feishu.reply',
    })
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(headOnly ? undefined : body)
    return
  }
  try {
    const snapshot = parseFeishuReplyExecutionStatusSnapshot(await service.read())
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      ...(snapshot.capability === 'ready'
        ? { [FEISHU_REPLY_EXECUTION_CSRF_HEADER]: csrfToken }
        : {}),
    })
    response.end(headOnly ? undefined : body)
  } catch {
    send(
      response,
      503,
      headOnly ? '' : 'Reply execution unavailable.\n',
      'text/plain; charset=utf-8',
    )
  }
}

async function serveFeishuReplyExecutionApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  service: FeishuReplyExecutionService | undefined,
  expectedOrigin: string,
  csrfToken: string,
  activeControllers: Set<AbortController>,
): Promise<void> {
  if (requestUrl.search.length > 0) {
    request.resume()
    send(response, 400, 'Invalid reply execution request.\n', 'text/plain; charset=utf-8')
    return
  }
  try {
    assertLocalWriteHeaders(
      request,
      expectedOrigin,
      csrfToken,
      'application/json',
      FEISHU_REPLY_EXECUTION_BODY_MAX_BYTES,
      FEISHU_REPLY_EXECUTION_CSRF_HEADER,
    )
  } catch (error) {
    request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 403
    send(
      response,
      status,
      status === 403
        ? 'Reply execution request forbidden.\n'
        : status === 413
          ? 'Reply execution request too large.\n'
          : status === 415
            ? 'Reply execution content type unsupported.\n'
            : 'Invalid reply execution request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  if (service === undefined) {
    request.resume()
    send(response, 503, 'Reply execution unavailable.\n', 'text/plain; charset=utf-8')
    return
  }
  let input: ReturnType<typeof parseFeishuReplyExecutionRequest>
  try {
    const body = await readBoundedBody(request, FEISHU_REPLY_EXECUTION_BODY_MAX_BYTES)
    try {
      input = parseFeishuReplyExecutionRequest(JSON.parse(UTF8_DECODER.decode(body)) as unknown)
    } finally {
      body.fill(0)
    }
  } catch (error) {
    if (!request.complete) request.resume()
    const status = error instanceof FeishuSettingsRequestError ? error.status : 400
    send(
      response,
      status,
      status === 413
        ? 'Reply execution request too large.\n'
        : 'Invalid reply execution request.\n',
      'text/plain; charset=utf-8',
    )
    return
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  activeControllers.add(controller)
  request.once('aborted', abort)
  try {
    const snapshot = parseFeishuReplyExecutionSnapshot(
      await service.execute(input, controller.signal),
    )
    if (
      snapshot.proposal.workItemId !== input.workItemId ||
      snapshot.proposal.draftRevision !== input.draftRevision
    ) {
      throw new TypeError()
    }
    const body = JSON.stringify(snapshot)
    response.writeHead(200, {
      ...commonHeaders('application/json; charset=utf-8'),
      'content-length': String(Buffer.byteLength(body)),
      [FEISHU_REPLY_EXECUTION_CSRF_HEADER]: csrfToken,
    })
    response.end(body)
  } catch {
    send(response, 503, 'Reply execution unavailable.\n', 'text/plain; charset=utf-8')
  } finally {
    request.off('aborted', abort)
    activeControllers.delete(controller)
  }
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
  if (options.database !== undefined && options.databasePath !== undefined) {
    throw new Error('TwinDesk Web accepts only one business database source')
  }
  const feishuSettings = normalizeFeishuSettingsService(options.feishuSettings)
  const feishuAuthorization = normalizeFeishuAuthorizationService(options.feishuAuthorization)
  const feishuOAuthRecovery = normalizeFeishuOAuthRecoveryService(options.feishuOAuthRecovery)
  const feishuOAuthReconciliation = normalizeFeishuOAuthReconciliationService(
    options.feishuOAuthReconciliation,
  )
  const feishuReauthorization = normalizeFeishuReauthorizationService(options.feishuReauthorization)
  const modelDraft = normalizeModelDraftService(options.modelDraft)
  const feishuReplyProposal = normalizeFeishuReplyProposalService(options.feishuReplyProposal)
  const feishuReplyApproval = normalizeFeishuReplyApprovalService(options.feishuReplyApproval)
  const feishuReplyExecution = normalizeFeishuReplyExecutionService(options.feishuReplyExecution)

  const inboxOptions = { includeAudit: true, includeDraftFlow: true }
  const inbox =
    options.database === undefined
      ? createFixtureInboxService(options.databasePath, inboxOptions)
      : createFixtureInboxServiceFromDatabase(options.database, inboxOptions)
  const csrfToken = randomBytes(32).toString('base64url')
  const reauthorizationCsrfToken = randomBytes(32).toString('base64url')
  const reconciliationCsrfToken = randomBytes(32).toString('base64url')
  const modelDraftCsrfToken = randomBytes(32).toString('base64url')
  const feishuReplyProposalCsrfToken = randomBytes(32).toString('base64url')
  const feishuReplyApprovalCsrfToken = randomBytes(32).toString('base64url')
  const feishuReplyExecutionCsrfToken = randomBytes(32).toString('base64url')
  const activeReconciliationControllers = new Set<AbortController>()
  const activeModelDraftControllers = new Set<AbortController>()
  const activeFeishuReplyProposalControllers = new Set<AbortController>()
  const activeFeishuReplyApprovalControllers = new Set<AbortController>()
  const activeFeishuReplyExecutionControllers = new Set<AbortController>()
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
      const reauthorizationStart =
        method === 'POST' && requestUrl.pathname === '/api/reauthorization/feishu/start'
      const reauthorizationCancel =
        method === 'POST' && requestUrl.pathname === '/api/reauthorization/feishu/cancel'
      const oauthReconciliation =
        method === 'POST' && requestUrl.pathname === '/api/recovery/feishu/oauth/reconcile'
      const modelDraftCreate =
        method === 'POST' && requestUrl.pathname === '/api/model-drafts/create'
      const modelDraftEdit = method === 'POST' && requestUrl.pathname === '/api/model-drafts/edit'
      const feishuReplyProposalCreate =
        method === 'POST' && requestUrl.pathname === '/api/action-proposals/feishu-reply/create'
      const feishuReplyApprovalRequest =
        method === 'POST' && requestUrl.pathname === '/api/action-approvals/feishu-reply/request'
      const feishuReplyApprovalDecision =
        method === 'POST' && requestUrl.pathname === '/api/action-approvals/feishu-reply/decide'
      const feishuReplyExecutionRun =
        method === 'POST' && requestUrl.pathname === '/api/action-executions/feishu-reply/execute'
      const supportedMutation =
        oauthSettingsUpdate ||
        userIdentityCreate ||
        authorizationStart ||
        authorizationCancel ||
        reauthorizationStart ||
        reauthorizationCancel ||
        oauthReconciliation ||
        modelDraftCreate ||
        modelDraftEdit ||
        feishuReplyProposalCreate ||
        feishuReplyApprovalRequest ||
        feishuReplyApprovalDecision ||
        feishuReplyExecutionRun
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
                : requestUrl.pathname === '/api/reauthorization/feishu/start' ||
                    requestUrl.pathname === '/api/reauthorization/feishu/cancel'
                  ? 'POST'
                  : requestUrl.pathname === '/api/recovery/feishu/oauth/reconcile'
                    ? 'POST'
                    : requestUrl.pathname === '/api/model-drafts/create' ||
                        requestUrl.pathname === '/api/model-drafts/edit'
                      ? 'POST'
                      : requestUrl.pathname === '/api/action-proposals/feishu-reply/create'
                        ? 'POST'
                        : requestUrl.pathname === '/api/action-approvals/feishu-reply/request' ||
                            requestUrl.pathname === '/api/action-approvals/feishu-reply/decide'
                          ? 'POST'
                          : requestUrl.pathname === '/api/action-executions/feishu-reply/execute'
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
      if (reauthorizationStart || reauthorizationCancel) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuReauthorizationMutationApi(
          request,
          response,
          requestUrl,
          feishuReauthorization,
          feishuOAuthRecovery,
          boundOrigin,
          reauthorizationCsrfToken,
          reauthorizationStart ? 'start' : 'cancel',
        )
        return
      }
      if (oauthReconciliation) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuOAuthReconciliationMutationApi(
          request,
          response,
          requestUrl,
          feishuOAuthRecovery,
          feishuOAuthReconciliation,
          boundOrigin,
          reconciliationCsrfToken,
          activeReconciliationControllers,
        )
        return
      }
      if (modelDraftCreate) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveModelDraftCreateApi(
          request,
          response,
          requestUrl,
          modelDraft,
          boundOrigin,
          modelDraftCsrfToken,
          activeModelDraftControllers,
        )
        return
      }
      if (modelDraftEdit) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveModelDraftEditApi(
          request,
          response,
          requestUrl,
          modelDraft,
          boundOrigin,
          modelDraftCsrfToken,
          activeModelDraftControllers,
        )
        return
      }
      if (feishuReplyProposalCreate) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuReplyProposalCreateApi(
          request,
          response,
          requestUrl,
          feishuReplyProposal,
          boundOrigin,
          feishuReplyProposalCsrfToken,
          activeFeishuReplyProposalControllers,
        )
        return
      }
      if (feishuReplyApprovalRequest || feishuReplyApprovalDecision) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuReplyApprovalMutationApi(
          request,
          response,
          requestUrl,
          feishuReplyApproval,
          boundOrigin,
          feishuReplyApprovalCsrfToken,
          activeFeishuReplyApprovalControllers,
          feishuReplyApprovalRequest ? 'request' : 'decision',
        )
        return
      }
      if (feishuReplyExecutionRun) {
        if (boundOrigin === undefined) throw new Error('TwinDesk Web origin is unavailable')
        await serveFeishuReplyExecutionApi(
          request,
          response,
          requestUrl,
          feishuReplyExecution,
          boundOrigin,
          feishuReplyExecutionCsrfToken,
          activeFeishuReplyExecutionControllers,
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
      if (requestUrl.pathname === '/api/model-drafts') {
        await serveModelDraftStatusApi(
          response,
          requestUrl,
          method === 'HEAD',
          modelDraft,
          modelDraftCsrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/action-proposals/feishu-reply') {
        await serveFeishuReplyProposalStatusApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuReplyProposal,
          feishuReplyProposalCsrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/action-approvals/feishu-reply') {
        await serveFeishuReplyApprovalStatusApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuReplyApproval,
          feishuReplyApprovalCsrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/action-executions/feishu-reply') {
        await serveFeishuReplyExecutionStatusApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuReplyExecution,
          feishuReplyExecutionCsrfToken,
        )
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
          feishuOAuthReconciliation,
          reconciliationCsrfToken,
        )
        return
      }
      if (requestUrl.pathname === '/api/reauthorization/feishu') {
        await serveFeishuReauthorizationApi(
          response,
          requestUrl,
          method === 'HEAD',
          feishuReauthorization,
          reauthorizationCsrfToken,
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
          for (const controller of activeReconciliationControllers) controller.abort()
          for (const controller of activeModelDraftControllers) controller.abort()
          for (const controller of activeFeishuReplyProposalControllers) controller.abort()
          for (const controller of activeFeishuReplyApprovalControllers) controller.abort()
          for (const controller of activeFeishuReplyExecutionControllers) controller.abort()
          try {
            await feishuAuthorization?.cancel()
          } catch {
            // Shutdown still owns the HTTP and Inbox lifecycles when cancellation fails.
          }
          try {
            await feishuReauthorization?.cancel()
          } catch {
            // Reauthorization cancellation cannot prevent server shutdown.
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
