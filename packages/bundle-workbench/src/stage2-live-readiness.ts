import {
  parseFeishuDiagnosticsSnapshot,
  parseFeishuOAuthRecoverySnapshot,
  parseFeishuSettingsSnapshot,
  parseModelDraftStatusSnapshot,
} from '@twindesk/web'

export const WORKBENCH_STAGE_2_LIVE_READINESS_VERSION = 1 as const

export type WorkbenchStage2ReadinessCheckId =
  'feishu_settings' | 'oauth_recovery' | 'connector_diagnostics' | 'model_draft' | 'bot_callback'

export type WorkbenchStage2ReadinessDetail =
  | 'bot_and_user_configured'
  | 'connector_configuration_incomplete'
  | 'settings_unavailable'
  | 'no_unresolved_oauth_rotation'
  | 'rotation_active'
  | 'reauthorization_required'
  | 'reconciliation_required'
  | 'recovery_state_unavailable'
  | 'healthy_runtime_and_cursor'
  | 'connector_health_incomplete'
  | 'diagnostics_unavailable'
  | 'route_configured'
  | 'route_unavailable'
  | 'model_status_unavailable'
  | 'configured_keychain_reachable'
  | 'callback_unavailable'

export interface WorkbenchStage2ReadinessCheck {
  readonly id: WorkbenchStage2ReadinessCheckId
  readonly status: 'ready' | 'attention_required'
  readonly detail: WorkbenchStage2ReadinessDetail
}

export interface WorkbenchStage2LiveReadinessReport {
  readonly version: typeof WORKBENCH_STAGE_2_LIVE_READINESS_VERSION
  readonly status: 'ready_for_live_steps' | 'attention_required'
  readonly checks: readonly WorkbenchStage2ReadinessCheck[]
  readonly limitations: readonly [
    'public_bot_delivery_unverified',
    'provider_credentials_unverified',
    'live_user_polling_unverified',
    'external_send_unverified',
  ]
}

export interface WorkbenchStage2LiveReadinessOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

type ResolvedOptions = Readonly<{
  fetch: typeof globalThis.fetch
  timeoutMs: number
}>

const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const LIMITATIONS = Object.freeze([
  'public_bot_delivery_unverified',
  'provider_credentials_unverified',
  'live_user_polling_unverified',
  'external_send_unverified',
] as const)

function invalid(message = 'The Stage 2 live-readiness request is invalid.'): TypeError {
  return new TypeError(message)
}

function originAt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== '::1') ||
    url.port.length === 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.pathname !== '/' ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw invalid()
  }
  return url.origin
}

function optionsAt(value: unknown): ResolvedOptions {
  try {
    if (value === undefined) value = {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !['fetch', 'timeoutMs'].includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const fetchImplementation = Object.hasOwn(descriptors, 'fetch')
      ? descriptors.fetch?.value
      : globalThis.fetch
    const timeoutMs = Object.hasOwn(descriptors, 'timeoutMs')
      ? descriptors.timeoutMs?.value
      : DEFAULT_TIMEOUT_MS
    if (
      typeof fetchImplementation !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 120_000
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      fetch: fetchImplementation as typeof globalThis.fetch,
      timeoutMs: timeoutMs as number,
    })
  } catch {
    throw invalid()
  }
}

function check(
  id: WorkbenchStage2ReadinessCheckId,
  status: WorkbenchStage2ReadinessCheck['status'],
  detail: WorkbenchStage2ReadinessDetail,
): WorkbenchStage2ReadinessCheck {
  return Object.freeze({ id, status, detail })
}

function abortable<TResult>(
  operation: PromiseLike<TResult>,
  signal: AbortSignal,
  cancel?: () => void,
): Promise<TResult> {
  if (signal.aborted) {
    cancel?.()
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) return
      settled = true
      cancel?.()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(value)
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

async function withResponse<TResult>(
  options: ResolvedOptions,
  url: string,
  signal: AbortSignal,
  init: RequestInit = {},
  use: (response: Response, requestSignal: AbortSignal) => Promise<TResult> | TResult,
): Promise<TResult> {
  signal.throwIfAborted()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs)
  const requestSignal = AbortSignal.any([signal, timeout.signal])
  let response: Response | undefined
  try {
    const operation = Reflect.apply(options.fetch, globalThis, [
      url,
      {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: requestSignal,
      },
    ])
    response = await abortable(operation, requestSignal)
    if (!(response instanceof Response)) throw new TypeError()
    return await use(response, requestSignal)
  } finally {
    clearTimeout(timer)
    void response?.body?.cancel().catch(() => undefined)
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    response.status !== 200 ||
    response.headers.get('content-type') !== 'application/json; charset=utf-8'
  ) {
    throw new TypeError()
  }
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength === null ||
    !/^[1-9][0-9]{0,5}$/u.test(declaredLength) ||
    Number(declaredLength) > MAX_RESPONSE_BYTES ||
    response.body === null
  ) {
    throw new TypeError()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal, () => {
        void reader.cancel().catch(() => undefined)
      })
      if (result.done) break
      length += result.value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new TypeError()
      chunks.push(result.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (length !== Number(declaredLength)) throw new TypeError()
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new TypeError()
  }
}

async function inspectSettings(
  origin: string,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<WorkbenchStage2ReadinessCheck> {
  try {
    const snapshot = parseFeishuSettingsSnapshot(
      await withResponse(options, `${origin}/api/settings/feishu`, signal, {}, readJson),
    )
    const ready =
      snapshot.state === 'ready' &&
      snapshot.identities.length === 2 &&
      snapshot.identities.includes('bot') &&
      snapshot.identities.includes('user')
    return check(
      'feishu_settings',
      ready ? 'ready' : 'attention_required',
      ready ? 'bot_and_user_configured' : 'connector_configuration_incomplete',
    )
  } catch {
    signal.throwIfAborted()
    return check('feishu_settings', 'attention_required', 'settings_unavailable')
  }
}

async function inspectRecovery(
  origin: string,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<WorkbenchStage2ReadinessCheck> {
  try {
    const snapshot = parseFeishuOAuthRecoverySnapshot(
      await withResponse(options, `${origin}/api/recovery/feishu/oauth`, signal, {}, readJson),
    )
    const ready = snapshot.state === 'not_started' || snapshot.state === 'ready'
    return check(
      'oauth_recovery',
      ready ? 'ready' : 'attention_required',
      ready ? 'no_unresolved_oauth_rotation' : snapshot.state,
    )
  } catch {
    signal.throwIfAborted()
    return check('oauth_recovery', 'attention_required', 'recovery_state_unavailable')
  }
}

async function inspectDiagnostics(
  origin: string,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<WorkbenchStage2ReadinessCheck> {
  try {
    const snapshot = parseFeishuDiagnosticsSnapshot(
      await withResponse(options, `${origin}/api/diagnostics/feishu`, signal, {}, readJson),
    )
    const ready =
      snapshot.status === 'healthy' &&
      snapshot.runtime.state === 'running' &&
      snapshot.identities.length === 2 &&
      snapshot.identities.every(({ status }) => status === 'ready') &&
      snapshot.cursors.length === 1 &&
      snapshot.cursors[0]?.status === 'current'
    return check(
      'connector_diagnostics',
      ready ? 'ready' : 'attention_required',
      ready ? 'healthy_runtime_and_cursor' : 'connector_health_incomplete',
    )
  } catch {
    signal.throwIfAborted()
    return check('connector_diagnostics', 'attention_required', 'diagnostics_unavailable')
  }
}

async function inspectModelDraft(
  origin: string,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<WorkbenchStage2ReadinessCheck> {
  try {
    const snapshot = parseModelDraftStatusSnapshot(
      await withResponse(options, `${origin}/api/model-drafts`, signal, {}, readJson),
    )
    return check(
      'model_draft',
      snapshot.capability === 'ready' ? 'ready' : 'attention_required',
      snapshot.capability === 'ready' ? 'route_configured' : 'route_unavailable',
    )
  } catch {
    signal.throwIfAborted()
    return check('model_draft', 'attention_required', 'model_status_unavailable')
  }
}

async function inspectBotCallback(
  origin: string,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<WorkbenchStage2ReadinessCheck> {
  try {
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const status = await withResponse(
      options,
      `${origin}/api/connectors/feishu/bot/events`,
      signal,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': 'twindesk-stage2-readiness',
          'x-lark-signature': '0'.repeat(64),
        },
        body: '{}',
      },
      (response) => response.status,
    )
    const ready = status === 401
    return check(
      'bot_callback',
      ready ? 'ready' : 'attention_required',
      ready ? 'configured_keychain_reachable' : 'callback_unavailable',
    )
  } catch {
    signal.throwIfAborted()
    return check('bot_callback', 'attention_required', 'callback_unavailable')
  }
}

/**
 * Inspect only presentation-safe loopback capabilities before a user performs
 * the explicit live-account acceptance steps. A ready report is not live proof.
 */
export async function inspectWorkbenchStage2LiveReadiness(
  originValue: unknown,
  signal: AbortSignal,
  optionsValue: WorkbenchStage2LiveReadinessOptions = {},
): Promise<WorkbenchStage2LiveReadinessReport> {
  if (!(signal instanceof AbortSignal)) throw invalid()
  const origin = originAt(originValue)
  const options = optionsAt(optionsValue)
  signal.throwIfAborted()
  const checks = Object.freeze([
    await inspectSettings(origin, signal, options),
    await inspectRecovery(origin, signal, options),
    await inspectDiagnostics(origin, signal, options),
    await inspectModelDraft(origin, signal, options),
    await inspectBotCallback(origin, signal, options),
  ])
  return Object.freeze({
    version: WORKBENCH_STAGE_2_LIVE_READINESS_VERSION,
    status: checks.every(({ status }) => status === 'ready')
      ? 'ready_for_live_steps'
      : 'attention_required',
    checks,
    limitations: LIMITATIONS,
  })
}
