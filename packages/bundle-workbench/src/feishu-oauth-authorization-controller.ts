import {
  FeishuIdentityConfigurationStore,
  FEISHU_OAUTH_AUTHORIZE_URL,
  FeishuOAuthAuthorizationConfigurationStore,
  FeishuOAuthAuthorizationError,
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthInitialPersistenceError,
  FeishuOAuthUserInfoHttpClient,
  FeishuOAuthUserPrincipalVerifier,
  FeishuOAuthV3HttpTransport,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from '@twindesk/plugin-feishu'

import {
  loadWorkbenchFeishuOAuthAuthorizationHost,
  WorkbenchFeishuOAuthAuthorizationError,
  type WorkbenchFeishuOAuthAuthorizationHost,
} from './feishu-oauth-authorization-runtime.ts'

export type WorkbenchFeishuOAuthAuthorizationUiRecovery =
  | 'configure_settings'
  | 'correct_configuration'
  | 'use_reauthorization'
  | 'reauthorize'
  | 'reconcile_keychain'
  | 'retry_later'
  | 'do_not_retry'

export type WorkbenchFeishuOAuthAuthorizationStatus =
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
      recovery: WorkbenchFeishuOAuthAuthorizationUiRecovery
    }>

export interface WorkbenchFeishuOAuthAuthorizationController {
  read(): WorkbenchFeishuOAuthAuthorizationStatus
  start(clientSecret: Uint8Array): Promise<WorkbenchFeishuOAuthAuthorizationStatus>
  cancel(): Promise<WorkbenchFeishuOAuthAuthorizationStatus>
}

export interface WorkbenchFeishuOAuthAuthorizationControllerOptions {
  readonly loadHost: () => Promise<WorkbenchFeishuOAuthAuthorizationHost>
  readonly onSucceeded?: () => void
}

export interface DefaultWorkbenchFeishuOAuthAuthorizationControllerOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly onSucceeded?: () => void
}

export class WorkbenchFeishuOAuthAuthorizationControllerError extends Error {
  readonly code: 'invalid_controller' | 'authorization_active'

  constructor(code: 'invalid_controller' | 'authorization_active') {
    super(
      code === 'authorization_active'
        ? 'A Feishu OAuth authorization is already active.'
        : 'The Workbench Feishu OAuth authorization controller is invalid.',
    )
    this.name = 'WorkbenchFeishuOAuthAuthorizationControllerError'
    this.code = code
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>
const fillBytes = Uint8Array.prototype.fill

function invalid(): WorkbenchFeishuOAuthAuthorizationControllerError {
  return new WorkbenchFeishuOAuthAuthorizationControllerError('invalid_controller')
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

function readOptions(value: unknown): WorkbenchFeishuOAuthAuthorizationControllerOptions {
  const record = dataRecord(value, ['loadHost', 'onSucceeded'])
  if (
    (Object.keys(record).length !== 1 && Object.keys(record).length !== 2) ||
    typeof record.loadHost !== 'function' ||
    (record.onSucceeded !== undefined && typeof record.onSucceeded !== 'function')
  ) {
    throw invalid()
  }
  return Object.freeze({
    loadHost: () =>
      Reflect.apply(record.loadHost as () => Promise<unknown>, undefined, []).then(host),
    ...(record.onSucceeded === undefined
      ? {}
      : {
          onSucceeded: () => Reflect.apply(record.onSucceeded as () => void, undefined, []) as void,
        }),
  })
}

function readDefaultOptions(
  value: unknown,
): DefaultWorkbenchFeishuOAuthAuthorizationControllerOptions {
  const record = dataRecord(value, [
    'identityStore',
    'authorizationStore',
    'leaseManager',
    'onSucceeded',
  ])
  if (
    Object.keys(record).length < 2 ||
    Object.keys(record).length > 4 ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.authorizationStore instanceof FeishuOAuthAuthorizationConfigurationStore) ||
    (Object.hasOwn(record, 'leaseManager') &&
      !(record.leaseManager instanceof FeishuRuntimeLeaseManager)) ||
    (record.onSucceeded !== undefined && typeof record.onSucceeded !== 'function')
  ) {
    throw invalid()
  }
  return Object.freeze({
    identityStore: record.identityStore,
    authorizationStore: record.authorizationStore,
    ...(Object.hasOwn(record, 'leaseManager')
      ? { leaseManager: record.leaseManager as FeishuRuntimeLeaseManager }
      : {}),
    ...(record.onSucceeded === undefined ? {} : { onSucceeded: record.onSucceeded as () => void }),
  })
}

function host(value: unknown): WorkbenchFeishuOAuthAuthorizationHost {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      typeof descriptors.authorize?.value !== 'function' ||
      !Object.hasOwn(descriptors.authorize, 'value')
    ) {
      throw new TypeError()
    }
    const authorize = descriptors.authorize
      .value as WorkbenchFeishuOAuthAuthorizationHost['authorize']
    const boundAuthorize: WorkbenchFeishuOAuthAuthorizationHost['authorize'] = (
      clientSecret,
      signal,
      present,
    ) => Reflect.apply(authorize, value, [clientSecret, signal, present])
    return Object.freeze({ authorize: boundAuthorize })
  } catch {
    throw invalid()
  }
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
    const authorizationKeys = [...authorization.searchParams.keys()]
    if (
      authorization.origin !== endpoint.origin ||
      authorization.pathname !== endpoint.pathname ||
      authorization.username.length !== 0 ||
      authorization.password.length !== 0 ||
      authorization.hash.length !== 0 ||
      authorizationKeys.length !== 8 ||
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

function assertPersistenceResult(value: unknown): void {
  const record = dataRecord(value, ['status', 'obtainedAt'])
  const milliseconds =
    typeof record.obtainedAt === 'string' ? Date.parse(record.obtainedAt) : Number.NaN
  if (
    Object.keys(record).length !== 2 ||
    record.status !== 'persisted' ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== record.obtainedAt
  ) {
    throw invalid()
  }
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

function simpleState(
  state: 'idle' | 'starting' | 'succeeded' | 'cancelled',
): WorkbenchFeishuOAuthAuthorizationStatus {
  return Object.freeze({ version: 1, connectorId: 'feishu', state })
}

function failureRecovery(error: unknown): WorkbenchFeishuOAuthAuthorizationUiRecovery {
  if (error instanceof WorkbenchFeishuOAuthAuthorizationError) return error.recovery
  if (error instanceof FeishuOAuthInitialPersistenceError) return error.recovery
  if (error instanceof FeishuOAuthAuthorizationError) return error.retryDisposition
  return 'do_not_retry'
}

/** Coordinate one memory-only authorization attempt around the existing lease-held Host. */
export function createWorkbenchFeishuOAuthAuthorizationController(
  optionsValue: WorkbenchFeishuOAuthAuthorizationControllerOptions,
): WorkbenchFeishuOAuthAuthorizationController {
  const options = readOptions(optionsValue)
  let status = simpleState('idle')
  let active: Readonly<{ controller: AbortController; completion: Promise<void> }> | undefined

  return Object.freeze({
    read(): WorkbenchFeishuOAuthAuthorizationStatus {
      return status
    },
    async start(clientSecretValue: Uint8Array): Promise<WorkbenchFeishuOAuthAuthorizationStatus> {
      if (active !== undefined) {
        throw new WorkbenchFeishuOAuthAuthorizationControllerError('authorization_active')
      }
      const clientSecret = copySecret(clientSecretValue)
      const controller = new AbortController()
      status = simpleState('starting')
      let presented: (() => void) | undefined
      const presentation = new Promise<void>((resolve) => {
        presented = resolve
      })
      const operation = (async () => {
        try {
          const authorizationHost = await options.loadHost()
          controller.signal.throwIfAborted()
          const authorization = authorizationHost.authorize(
            clientSecret,
            controller.signal,
            (requestValue) => {
              const request = presentationRequest(requestValue)
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
          assertPersistenceResult(await authorization)
          status = simpleState('succeeded')
          try {
            options.onSucceeded?.()
          } catch {
            // Durable credential success remains authoritative over lifecycle notification.
          }
        } catch (error) {
          status = controller.signal.aborted
            ? simpleState('cancelled')
            : Object.freeze({
                version: 1,
                connectorId: 'feishu',
                state: 'failed',
                recovery: failureRecovery(error),
              })
        } finally {
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
    async cancel(): Promise<WorkbenchFeishuOAuthAuthorizationStatus> {
      const operation = active
      if (operation === undefined) return status
      operation.controller.abort()
      await operation.completion
      return status
    },
  })
}

/** Compose the controller with production HTTP, Keychain, and persisted Settings boundaries. */
export function createDefaultWorkbenchFeishuOAuthAuthorizationController(
  optionsValue: DefaultWorkbenchFeishuOAuthAuthorizationControllerOptions,
): WorkbenchFeishuOAuthAuthorizationController {
  const options = readDefaultOptions(optionsValue)
  const flow = new FeishuOAuthAuthorizationFlow({ transport: new FeishuOAuthV3HttpTransport() })
  const resolver = new FeishuSystemKeychainSecretResolver()
  const persister = new FeishuOAuthInitialCredentialPersister({
    verifier: new FeishuOAuthUserPrincipalVerifier({
      client: new FeishuOAuthUserInfoHttpClient(),
    }),
    replacer: new FeishuSystemKeychainSecretReplacer(),
  })
  return createWorkbenchFeishuOAuthAuthorizationController({
    loadHost: () =>
      loadWorkbenchFeishuOAuthAuthorizationHost({
        identityStore: options.identityStore,
        authorizationStore: options.authorizationStore,
        flow,
        persister,
        resolver,
        ...(options.leaseManager === undefined ? {} : { leaseManager: options.leaseManager }),
      }),
    ...(options.onSucceeded === undefined ? {} : { onSucceeded: options.onSucceeded }),
  })
}
