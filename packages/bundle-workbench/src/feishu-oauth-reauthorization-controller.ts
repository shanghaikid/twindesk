import {
  FEISHU_OAUTH_AUTHORIZE_URL,
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
  FeishuOAuthAuthorizationError,
  FeishuOAuthReauthorizationError,
  FeishuOAuthRotationJournal,
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
} from '@twindesk/plugin-feishu'

import {
  WorkbenchFeishuOAuthHostedReauthorizationError,
  loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost,
  type WorkbenchFeishuOAuthHostedReauthorizationHost,
} from './feishu-oauth-hosted-reauthorization-runtime.ts'

export type WorkbenchFeishuOAuthReauthorizationUiRecovery =
  | 'configure_settings'
  | 'correct_configuration'
  | 'reauthorize'
  | 'reconcile_keychain'
  | 'reconcile_rotation'
  | 'retry_after_owner_exit'
  | 'do_not_retry'

export type WorkbenchFeishuOAuthReauthorizationStatus =
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'idle' | 'starting' | 'succeeded' | 'cancelled'
    }>
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'waiting'
      authorizationUrl: string
      redirectUri: string
    }>
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'failed'
      recovery: WorkbenchFeishuOAuthReauthorizationUiRecovery
    }>

export interface WorkbenchFeishuOAuthReauthorizationController {
  read(): WorkbenchFeishuOAuthReauthorizationStatus
  start(clientSecret: Uint8Array): Promise<WorkbenchFeishuOAuthReauthorizationStatus>
  cancel(): Promise<WorkbenchFeishuOAuthReauthorizationStatus>
}

export interface WorkbenchFeishuOAuthReauthorizationControllerOptions {
  readonly loadHost: () => Promise<WorkbenchFeishuOAuthHostedReauthorizationHost>
}

export interface DefaultWorkbenchFeishuOAuthReauthorizationControllerOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly journal: FeishuOAuthRotationJournal
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export class WorkbenchFeishuOAuthReauthorizationControllerError extends Error {
  readonly code: 'invalid_controller' | 'reauthorization_active'

  constructor(code: 'invalid_controller' | 'reauthorization_active') {
    super(
      code === 'reauthorization_active'
        ? 'A Feishu OAuth reauthorization is already active.'
        : 'The Workbench Feishu OAuth reauthorization controller is invalid.',
    )
    this.name = 'WorkbenchFeishuOAuthReauthorizationControllerError'
    this.code = code
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>
const fillBytes = Uint8Array.prototype.fill

function invalid(): WorkbenchFeishuOAuthReauthorizationControllerError {
  return new WorkbenchFeishuOAuthReauthorizationControllerError('invalid_controller')
}

function dataRecord(value: unknown, allowed: readonly string[]): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    throw invalid()
  }
}

function hosted(value: unknown): WorkbenchFeishuOAuthHostedReauthorizationHost {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const reauthorize = descriptors.reauthorize
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      reauthorize === undefined ||
      !Object.hasOwn(reauthorize, 'value') ||
      typeof reauthorize.value !== 'function'
    ) {
      throw new TypeError()
    }
    const operation =
      reauthorize.value as WorkbenchFeishuOAuthHostedReauthorizationHost['reauthorize']
    return Object.freeze({
      reauthorize: (
        clientSecret: Uint8Array,
        signal: AbortSignal,
        present: Parameters<WorkbenchFeishuOAuthHostedReauthorizationHost['reauthorize']>[2],
      ) => Reflect.apply(operation, value, [clientSecret, signal, present]),
    })
  } catch {
    throw invalid()
  }
}

function readOptions(
  value: unknown,
): Readonly<{ loadHost: () => Promise<WorkbenchFeishuOAuthHostedReauthorizationHost> }> {
  const record = dataRecord(value, ['loadHost'])
  if (Object.keys(record).length !== 1 || typeof record.loadHost !== 'function') throw invalid()
  return Object.freeze({
    loadHost: () =>
      Promise.resolve(Reflect.apply(record.loadHost as () => unknown, undefined, [])).then(hosted),
  })
}

function readDefaultOptions(
  value: unknown,
): DefaultWorkbenchFeishuOAuthReauthorizationControllerOptions {
  const record = dataRecord(value, [
    'identityStore',
    'authorizationStore',
    'journal',
    'leaseManager',
  ])
  if (
    (Object.keys(record).length !== 3 && Object.keys(record).length !== 4) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.authorizationStore instanceof FeishuOAuthAuthorizationConfigurationStore) ||
    !(record.journal instanceof FeishuOAuthRotationJournal) ||
    (Object.hasOwn(record, 'leaseManager') &&
      !(record.leaseManager instanceof FeishuRuntimeLeaseManager))
  ) {
    throw invalid()
  }
  return Object.freeze({
    identityStore: record.identityStore,
    authorizationStore: record.authorizationStore,
    journal: record.journal,
    ...(Object.hasOwn(record, 'leaseManager')
      ? { leaseManager: record.leaseManager as FeishuRuntimeLeaseManager }
      : {}),
  })
}

function presentationRequest(value: unknown): Readonly<{
  authorizationUrl: string
  redirectUri: string
}> {
  const record = dataRecord(value, ['authorizationUrl', 'redirectUri'])
  if (
    Object.keys(record).length !== 2 ||
    typeof record.authorizationUrl !== 'string' ||
    record.authorizationUrl.length === 0 ||
    record.authorizationUrl.length > 8192 ||
    typeof record.redirectUri !== 'string' ||
    record.redirectUri.length === 0 ||
    record.redirectUri.length > 2048
  ) {
    throw invalid()
  }
  try {
    const authorization = new URL(record.authorizationUrl)
    const endpoint = new URL(FEISHU_OAUTH_AUTHORIZE_URL)
    const redirect = new URL(record.redirectUri)
    const keys = [...authorization.searchParams.keys()]
    if (
      authorization.origin !== endpoint.origin ||
      authorization.pathname !== endpoint.pathname ||
      authorization.username.length !== 0 ||
      authorization.password.length !== 0 ||
      authorization.hash.length !== 0 ||
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
      (authorization.searchParams.get('client_id')?.length ?? 0) === 0 ||
      authorization.searchParams.get('response_type') !== 'code' ||
      authorization.searchParams.get('redirect_uri') !== record.redirectUri ||
      (authorization.searchParams.get('scope')?.length ?? 0) === 0 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(authorization.searchParams.get('state') ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/u.test(authorization.searchParams.get('code_challenge') ?? '') ||
      authorization.searchParams.get('code_challenge_method') !== 'S256' ||
      authorization.searchParams.get('prompt') !== 'consent' ||
      redirect.protocol !== 'http:' ||
      (redirect.hostname !== '127.0.0.1' && redirect.hostname !== '[::1]') ||
      redirect.port.length === 0 ||
      redirect.username.length !== 0 ||
      redirect.password.length !== 0 ||
      redirect.search.length !== 0 ||
      redirect.hash.length !== 0
    ) {
      throw new TypeError()
    }
  } catch {
    throw invalid()
  }
  return Object.freeze({
    authorizationUrl: record.authorizationUrl,
    redirectUri: record.redirectUri,
  })
}

function copySecret(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > 512
  ) {
    throw invalid()
  }
  const copy = new Uint8Array(value.byteLength)
  for (let index = 0; index < value.byteLength; index += 1) copy[index] = value[index] as number
  return copy
}

function reauthorizationResult(value: unknown): void {
  const record = dataRecord(value, ['status', 'obtainedAt'])
  if (
    Object.keys(record).length !== 2 ||
    record.status !== 'reauthorized' ||
    typeof record.obtainedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.obtainedAt)) ||
    new Date(Date.parse(record.obtainedAt)).toISOString() !== record.obtainedAt
  ) {
    throw invalid()
  }
}

function simpleState(
  state: 'idle' | 'starting' | 'succeeded' | 'cancelled',
): WorkbenchFeishuOAuthReauthorizationStatus {
  return Object.freeze({ version: 1, connectorId: 'feishu', state })
}

function recovery(error: unknown): WorkbenchFeishuOAuthReauthorizationUiRecovery {
  if (error instanceof WorkbenchFeishuOAuthHostedReauthorizationError) return error.recovery
  if (error instanceof FeishuOAuthReauthorizationError) return error.recovery
  if (error instanceof FeishuOAuthAuthorizationError) return error.retryDisposition
  if (error instanceof FeishuRuntimeLeaseError) {
    return error.recovery === 'retry_after_owner_exit' ? 'retry_after_owner_exit' : 'do_not_retry'
  }
  return 'do_not_retry'
}

/** Coordinate one memory-only hosted reauthorization attempt. */
export function createWorkbenchFeishuOAuthReauthorizationController(
  optionsValue: WorkbenchFeishuOAuthReauthorizationControllerOptions,
): WorkbenchFeishuOAuthReauthorizationController {
  const options = readOptions(optionsValue)
  let status = simpleState('idle')
  let active: Readonly<{ controller: AbortController; completion: Promise<void> }> | undefined

  return Object.freeze({
    read(): WorkbenchFeishuOAuthReauthorizationStatus {
      return status
    },
    async start(clientSecretValue: Uint8Array): Promise<WorkbenchFeishuOAuthReauthorizationStatus> {
      if (active !== undefined) {
        throw new WorkbenchFeishuOAuthReauthorizationControllerError('reauthorization_active')
      }
      const clientSecret = copySecret(clientSecretValue)
      const controller = new AbortController()
      status = simpleState('starting')
      let presented: (() => void) | undefined
      let presentationState: 'accepting' | 'presented' | 'closed' = 'accepting'
      const presentationWasAccepted = (): boolean => presentationState === 'presented'
      const presentation = new Promise<void>((resolve) => {
        presented = resolve
      })
      const operation = (async () => {
        try {
          const reauthorizationHost = await options.loadHost()
          controller.signal.throwIfAborted()
          const result = reauthorizationHost.reauthorize(
            clientSecret,
            controller.signal,
            (requestValue) => {
              if (presentationState === 'closed') return
              if (presentationState === 'presented') throw invalid()
              const request = presentationRequest(requestValue)
              presentationState = 'presented'
              status = Object.freeze({
                version: 1,
                connectorId: 'feishu',
                state: 'waiting',
                authorizationUrl: request.authorizationUrl,
                redirectUri: request.redirectUri,
              })
              presented?.()
            },
          )
          fillBytes.call(clientSecret, 0)
          const completed = await result
          if (!presentationWasAccepted()) throw invalid()
          reauthorizationResult(completed)
          presentationState = 'closed'
          status = simpleState('succeeded')
        } catch (cause) {
          presentationState = 'closed'
          status = controller.signal.aborted
            ? simpleState('cancelled')
            : Object.freeze({
                version: 1,
                connectorId: 'feishu',
                state: 'failed',
                recovery: recovery(cause),
              })
        } finally {
          presentationState = 'closed'
          fillBytes.call(clientSecret, 0)
        }
      })()
      const completion = operation.finally(() => {
        if (active?.controller === controller) active = undefined
      })
      active = Object.freeze({ controller, completion })
      await Promise.race([presentation, completion])
      return status
    },
    async cancel(): Promise<WorkbenchFeishuOAuthReauthorizationStatus> {
      const operation = active
      if (operation === undefined) return status
      operation.controller.abort()
      await operation.completion
      return status
    },
  })
}

/** Compose the controller with restart-safe Settings, journal, and production adapters. */
export function createDefaultWorkbenchFeishuOAuthReauthorizationController(
  optionsValue: DefaultWorkbenchFeishuOAuthReauthorizationControllerOptions,
): WorkbenchFeishuOAuthReauthorizationController {
  const options = readDefaultOptions(optionsValue)
  return createWorkbenchFeishuOAuthReauthorizationController({
    loadHost: () =>
      loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost({
        identityStore: options.identityStore,
        authorizationStore: options.authorizationStore,
        journal: options.journal,
        ...(options.leaseManager === undefined ? {} : { leaseManager: options.leaseManager }),
      }),
  })
}
