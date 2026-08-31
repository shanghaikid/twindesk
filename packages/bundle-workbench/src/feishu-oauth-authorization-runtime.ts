import {
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthLoopbackCallbackHost,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainError,
  FeishuSystemKeychainSecretResolver,
  parseFeishuIdentityConfiguration,
  parseFeishuOAuthAuthorizationConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuOAuthAuthorizationConfiguration,
  type FeishuOAuthInitialPersistenceResult,
} from '@twindesk/plugin-feishu'

export interface WorkbenchFeishuOAuthAuthorizationRuntimeOptions {
  readonly configuration: unknown
  readonly authorization: unknown
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly callbackHost: FeishuOAuthLoopbackCallbackHost
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export interface WorkbenchFeishuOAuthAuthorizationRequest {
  readonly authorizationUrl: string
  readonly redirectUri: string
}

export type WorkbenchFeishuOAuthAuthorizationPresenter = (
  request: WorkbenchFeishuOAuthAuthorizationRequest,
) => Promise<void> | void

export type WorkbenchFeishuOAuthAuthorizationErrorCode = 'credential_exists' | 'redirect_mismatch'
export type WorkbenchFeishuOAuthAuthorizationRecovery =
  'use_reauthorization' | 'correct_configuration'

export class WorkbenchFeishuOAuthAuthorizationError extends Error {
  readonly code: WorkbenchFeishuOAuthAuthorizationErrorCode
  readonly recovery: WorkbenchFeishuOAuthAuthorizationRecovery

  constructor(
    code: WorkbenchFeishuOAuthAuthorizationErrorCode,
    recovery: WorkbenchFeishuOAuthAuthorizationRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'WorkbenchFeishuOAuthAuthorizationError'
    this.code = code
    this.recovery = recovery
  }
}

export interface WorkbenchFeishuOAuthAuthorizationHost {
  /**
   * Run one explicit initial User authorization. The presenter owns browser or
   * UI interaction only; it receives no credential, lease, or persistence
   * capability.
   */
  authorize(
    clientSecret: Uint8Array,
    signal: AbortSignal,
    present: WorkbenchFeishuOAuthAuthorizationPresenter,
  ): Promise<FeishuOAuthInitialPersistenceResult>
}

type UnknownRecord = Readonly<Record<string, unknown>>
const fillBytes = Uint8Array.prototype.fill

interface ParsedOptions {
  readonly configuration: FeishuIdentityConfiguration
  readonly authorization: FeishuOAuthAuthorizationConfiguration
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly callbackHost: FeishuOAuthLoopbackCallbackHost
  readonly leaseManager: FeishuRuntimeLeaseManager
}

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu OAuth authorization runtime is invalid.')
}

function dataRecord(value: unknown): UnknownRecord {
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
    throw invalid()
  }
}

function readOptions(value: unknown): ParsedOptions {
  const record = dataRecord(value)
  const expected = [
    'configuration',
    'authorization',
    'flow',
    'persister',
    'resolver',
    'callbackHost',
  ]
  if (Object.hasOwn(record, 'leaseManager')) expected.push('leaseManager')
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw invalid()
  }
  let configuration: FeishuIdentityConfiguration
  let authorization: FeishuOAuthAuthorizationConfiguration
  try {
    configuration = parseFeishuIdentityConfiguration(record.configuration)
    authorization = parseFeishuOAuthAuthorizationConfiguration(record.authorization)
  } catch {
    throw invalid()
  }
  const leaseManager = Object.hasOwn(record, 'leaseManager')
    ? record.leaseManager
    : new FeishuRuntimeLeaseManager()
  if (
    configuration.user === undefined ||
    authorization.appId !== configuration.appId ||
    !(record.flow instanceof FeishuOAuthAuthorizationFlow) ||
    !(record.persister instanceof FeishuOAuthInitialCredentialPersister) ||
    !(record.resolver instanceof FeishuSystemKeychainSecretResolver) ||
    !(record.callbackHost instanceof FeishuOAuthLoopbackCallbackHost) ||
    !(leaseManager instanceof FeishuRuntimeLeaseManager)
  ) {
    throw invalid()
  }
  return Object.freeze({
    configuration,
    authorization,
    flow: record.flow,
    persister: record.persister,
    resolver: record.resolver,
    callbackHost: record.callbackHost,
    leaseManager,
  }) as ParsedOptions
}

function secretCopy(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > 512
  ) {
    throw invalid()
  }
  const copy = new Uint8Array(value.byteLength)
  for (let index = 0; index < value.byteLength; index += 1) {
    copy[index] = value[index] as number
  }
  return copy
}

function presentationFailure(
  present: WorkbenchFeishuOAuthAuthorizationPresenter,
  request: WorkbenchFeishuOAuthAuthorizationRequest,
): Promise<never> {
  let presentation: Promise<void>
  try {
    presentation = Promise.resolve(present(request))
  } catch (error) {
    return Promise.reject(error)
  }
  return presentation.then(
    () => new Promise<never>(() => undefined),
    (error: unknown) => Promise.reject(error),
  )
}

async function assertCredentialMissing(options: ParsedOptions, signal: AbortSignal): Promise<void> {
  try {
    await options.resolver.withSecret(
      options.configuration.user!.credentialReference,
      signal,
      () => undefined,
    )
  } catch (error) {
    if (error instanceof FeishuSystemKeychainError && error.code === 'not_found') return
    throw error
  }
  throw new WorkbenchFeishuOAuthAuthorizationError(
    'credential_exists',
    'use_reauthorization',
    'A Feishu User credential already exists; use the reauthorization path.',
  )
}

/**
 * Compose literal-loopback capture, PKCE exchange, principal verification, and
 * initial Keychain persistence under one exclusive Feishu Host lease.
 */
export function createWorkbenchFeishuOAuthAuthorizationHost(
  optionsValue: WorkbenchFeishuOAuthAuthorizationRuntimeOptions,
): WorkbenchFeishuOAuthAuthorizationHost {
  const options = readOptions(optionsValue)
  return Object.freeze({
    async authorize(
      clientSecretValue: Uint8Array,
      signal: AbortSignal,
      present: WorkbenchFeishuOAuthAuthorizationPresenter,
    ): Promise<FeishuOAuthInitialPersistenceResult> {
      if (!(signal instanceof AbortSignal) || typeof present !== 'function') throw invalid()
      const clientSecret = secretCopy(clientSecretValue)
      try {
        return await options.leaseManager.withLease(
          options.configuration,
          signal,
          async (lease) => {
            lease.assertHeld()
            const listener = await options.callbackHost.listen(signal)
            try {
              if (listener.redirectUri !== options.authorization.redirectUri) {
                throw new WorkbenchFeishuOAuthAuthorizationError(
                  'redirect_mismatch',
                  'correct_configuration',
                  'The Feishu OAuth callback listener does not match the registered redirect URI.',
                )
              }
              lease.assertHeld()
              await assertCredentialMissing(options, signal)
              lease.assertHeld()
              const session = options.flow.start({
                clientId: options.configuration.appId,
                clientSecret,
                redirectUri: options.authorization.redirectUri,
                scopes: options.authorization.scopes,
              })
              try {
                const callback = listener.wait(session.authorizationUrl, signal)
                void callback.catch(() => undefined)
                const request = Object.freeze({
                  authorizationUrl: session.authorizationUrl,
                  redirectUri: listener.redirectUri,
                })
                const callbackUri = await Promise.race([
                  callback,
                  presentationFailure(present, request),
                ])
                lease.assertHeld()
                await assertCredentialMissing(options, signal)
                lease.assertHeld()
                return await session.complete(callbackUri, signal, (tokenSet) => {
                  lease.assertHeld()
                  return options.persister.persistWithResultGuarded(
                    options.configuration,
                    clientSecret,
                    tokenSet,
                    signal,
                    () => lease.assertHeld(),
                  )
                })
              } finally {
                session.cancel()
              }
            } finally {
              await listener.close()
            }
          },
        )
      } finally {
        fillBytes.call(clientSecret, 0)
      }
    },
  })
}
