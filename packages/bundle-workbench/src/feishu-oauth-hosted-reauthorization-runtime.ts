import { URL } from 'node:url'

import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
  FeishuOAuthAuthorizationFlow,
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthLoopbackCallbackHost,
  FeishuOAuthReauthorizationCoordinator,
  FeishuOAuthRotationJournal,
  FeishuOAuthUserInfoHttpClient,
  FeishuOAuthUserPrincipalVerifier,
  FeishuOAuthV3HttpTransport,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  parseFeishuIdentityConfiguration,
  parseFeishuOAuthAuthorizationConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuOAuthAuthorizationConfiguration,
  type FeishuOAuthReauthorizationResult,
} from '@twindesk/plugin-feishu'

import type {
  WorkbenchFeishuOAuthAuthorizationPresenter,
  WorkbenchFeishuOAuthAuthorizationRequest,
} from './feishu-oauth-authorization-runtime.ts'

export interface WorkbenchFeishuOAuthHostedReauthorizationRuntimeOptions {
  readonly configuration: unknown
  readonly authorization: unknown
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly journal: FeishuOAuthRotationJournal
  readonly callbackHost: FeishuOAuthLoopbackCallbackHost
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export interface WorkbenchFeishuOAuthHostedReauthorizationStoredRuntimeOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly journal: FeishuOAuthRotationJournal
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export interface DefaultWorkbenchFeishuOAuthHostedReauthorizationRuntimeOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly journal: FeishuOAuthRotationJournal
}

export interface WorkbenchFeishuOAuthHostedReauthorizationHost {
  /** Run one explicit blocked-state authorization and verified replacement. */
  reauthorize(
    clientSecret: Uint8Array,
    signal: AbortSignal,
    present: WorkbenchFeishuOAuthAuthorizationPresenter,
  ): Promise<FeishuOAuthReauthorizationResult>
}

export type WorkbenchFeishuOAuthHostedReauthorizationErrorCode =
  | 'identity_configuration_missing'
  | 'authorization_configuration_missing'
  | 'configuration_mismatch'
  | 'redirect_mismatch'
  | 'reauthorization_not_pending'
  | 'recovery_unavailable'

export type WorkbenchFeishuOAuthHostedReauthorizationRecovery =
  'configure_settings' | 'correct_configuration' | 'reconcile_rotation' | 'do_not_retry'

export class WorkbenchFeishuOAuthHostedReauthorizationError extends Error {
  readonly code: WorkbenchFeishuOAuthHostedReauthorizationErrorCode
  readonly recovery: WorkbenchFeishuOAuthHostedReauthorizationRecovery

  constructor(
    code: WorkbenchFeishuOAuthHostedReauthorizationErrorCode,
    recovery: WorkbenchFeishuOAuthHostedReauthorizationRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'WorkbenchFeishuOAuthHostedReauthorizationError'
    this.code = code
    this.recovery = recovery
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>
const fillBytes = Uint8Array.prototype.fill

interface ParsedOptions {
  readonly configuration: FeishuIdentityConfiguration
  readonly authorization: FeishuOAuthAuthorizationConfiguration
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly journal: FeishuOAuthRotationJournal
  readonly callbackHost: FeishuOAuthLoopbackCallbackHost
  readonly leaseManager: FeishuRuntimeLeaseManager
}

interface ParsedStoredOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly flow: FeishuOAuthAuthorizationFlow
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly journal: FeishuOAuthRotationJournal
  readonly leaseManager: FeishuRuntimeLeaseManager
}

function invalid(): TypeError {
  return new TypeError('The Workbench hosted Feishu OAuth reauthorization runtime is invalid.')
}

function error(
  code: WorkbenchFeishuOAuthHostedReauthorizationErrorCode,
  recovery: WorkbenchFeishuOAuthHostedReauthorizationRecovery,
  message: string,
): WorkbenchFeishuOAuthHostedReauthorizationError {
  return new WorkbenchFeishuOAuthHostedReauthorizationError(code, recovery, message)
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
    'journal',
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
    !(record.journal instanceof FeishuOAuthRotationJournal) ||
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
    journal: record.journal,
    callbackHost: record.callbackHost,
    leaseManager,
  }) as ParsedOptions
}

function readStoredOptions(value: unknown): ParsedStoredOptions {
  const record = dataRecord(value)
  const expected = ['identityStore', 'authorizationStore', 'flow', 'persister', 'journal']
  if (Object.hasOwn(record, 'leaseManager')) expected.push('leaseManager')
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw invalid()
  }
  const leaseManager = Object.hasOwn(record, 'leaseManager')
    ? record.leaseManager
    : new FeishuRuntimeLeaseManager()
  if (
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.authorizationStore instanceof FeishuOAuthAuthorizationConfigurationStore) ||
    !(record.flow instanceof FeishuOAuthAuthorizationFlow) ||
    !(record.persister instanceof FeishuOAuthInitialCredentialPersister) ||
    !(record.journal instanceof FeishuOAuthRotationJournal) ||
    !(leaseManager instanceof FeishuRuntimeLeaseManager)
  ) {
    throw invalid()
  }
  return Object.freeze({
    identityStore: record.identityStore,
    authorizationStore: record.authorizationStore,
    flow: record.flow,
    persister: record.persister,
    journal: record.journal,
    leaseManager,
  }) as ParsedStoredOptions
}

function readDefaultStoredOptions(
  value: unknown,
): DefaultWorkbenchFeishuOAuthHostedReauthorizationRuntimeOptions {
  const record = dataRecord(value)
  if (
    Object.keys(record).length !== 3 ||
    !['identityStore', 'authorizationStore', 'journal'].every((key) =>
      Object.hasOwn(record, key),
    ) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.authorizationStore instanceof FeishuOAuthAuthorizationConfigurationStore) ||
    !(record.journal instanceof FeishuOAuthRotationJournal)
  ) {
    throw invalid()
  }
  return Object.freeze({
    identityStore: record.identityStore,
    authorizationStore: record.authorizationStore,
    journal: record.journal,
  })
}

function callbackHostFromAuthorization(
  authorization: FeishuOAuthAuthorizationConfiguration,
): FeishuOAuthLoopbackCallbackHost {
  const redirect = new URL(authorization.redirectUri)
  let host: '127.0.0.1' | '::1'
  if (redirect.hostname === '127.0.0.1') host = '127.0.0.1'
  else if (redirect.hostname === '[::1]') host = '::1'
  else throw invalid()
  return new FeishuOAuthLoopbackCallbackHost({
    host,
    port: Number(redirect.port),
    path: redirect.pathname,
  })
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
  for (let index = 0; index < value.byteLength; index += 1) copy[index] = value[index] as number
  return copy
}

function presentationFailure(
  present: WorkbenchFeishuOAuthAuthorizationPresenter,
  request: WorkbenchFeishuOAuthAuthorizationRequest,
): Promise<never> {
  let presentation: Promise<void>
  try {
    presentation = Promise.resolve(present(request))
  } catch (cause) {
    return Promise.reject(cause)
  }
  return presentation.then(
    () => new Promise<never>(() => undefined),
    (cause: unknown) => Promise.reject(cause),
  )
}

async function assertReauthorizationPending(options: ParsedOptions): Promise<void> {
  let latest: Awaited<ReturnType<FeishuOAuthRotationJournal['inspect']>>
  try {
    latest = await options.journal.inspect()
  } catch {
    throw error(
      'recovery_unavailable',
      'do_not_retry',
      'The Feishu OAuth recovery journal is unavailable.',
    )
  }
  if (latest?.state === 'reauthorization_required') return
  if (latest?.state === 'reserved' || latest?.state === 'uncertain') {
    throw error(
      'reauthorization_not_pending',
      'reconcile_rotation',
      'Feishu OAuth rotation requires reconciliation before reauthorization.',
    )
  }
  throw error(
    'reauthorization_not_pending',
    'do_not_retry',
    'No Feishu OAuth reauthorization is pending.',
  )
}

/**
 * Hold one Feishu runtime lease from blocked-state inspection through loopback
 * capture, code exchange, verified Keychain replacement, and journal settlement.
 */
export function createWorkbenchFeishuOAuthHostedReauthorizationHost(
  optionsValue: WorkbenchFeishuOAuthHostedReauthorizationRuntimeOptions,
): WorkbenchFeishuOAuthHostedReauthorizationHost {
  const options = readOptions(optionsValue)
  const coordinator = new FeishuOAuthReauthorizationCoordinator({
    persister: options.persister,
    journal: options.journal,
  })
  return Object.freeze({
    async reauthorize(
      clientSecretValue: Uint8Array,
      signal: AbortSignal,
      present: WorkbenchFeishuOAuthAuthorizationPresenter,
    ): Promise<FeishuOAuthReauthorizationResult> {
      if (!(signal instanceof AbortSignal) || typeof present !== 'function') throw invalid()
      const clientSecret = secretCopy(clientSecretValue)
      try {
        return await options.leaseManager.withLease(
          options.configuration,
          signal,
          async (lease) => {
            lease.assertHeld()
            await assertReauthorizationPending(options)
            lease.assertHeld()
            const listener = await options.callbackHost.listen(signal)
            try {
              if (listener.redirectUri !== options.authorization.redirectUri) {
                throw error(
                  'redirect_mismatch',
                  'correct_configuration',
                  'The Feishu OAuth callback listener does not match the registered redirect URI.',
                )
              }
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
                await assertReauthorizationPending(options)
                lease.assertHeld()
                return await session.complete(callbackUri, signal, (tokenSet) => {
                  lease.assertHeld()
                  return coordinator.replace(options.configuration, clientSecret, tokenSet, signal)
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

/** Load restart-safe Settings and bind the registered callback to the default journal. */
export async function loadWorkbenchFeishuOAuthHostedReauthorizationHost(
  optionsValue: WorkbenchFeishuOAuthHostedReauthorizationStoredRuntimeOptions,
): Promise<WorkbenchFeishuOAuthHostedReauthorizationHost> {
  const options = readStoredOptions(optionsValue)
  const [configuration, authorization] = await Promise.all([
    options.identityStore.read(),
    options.authorizationStore.read(),
  ])
  if (configuration === undefined) {
    throw error(
      'identity_configuration_missing',
      'configure_settings',
      'The Feishu identity configuration is missing.',
    )
  }
  if (authorization === undefined) {
    throw error(
      'authorization_configuration_missing',
      'configure_settings',
      'The Feishu OAuth authorization configuration is missing.',
    )
  }
  if (configuration.user === undefined || authorization.appId !== configuration.appId) {
    throw error(
      'configuration_mismatch',
      'correct_configuration',
      'The persisted Feishu identity and OAuth authorization configurations do not match.',
    )
  }
  return createWorkbenchFeishuOAuthHostedReauthorizationHost({
    configuration,
    authorization,
    flow: options.flow,
    persister: options.persister,
    journal: options.journal,
    callbackHost: callbackHostFromAuthorization(authorization),
    leaseManager: options.leaseManager,
  })
}

/** Construct the hosted path with production HTTP, verification, and Keychain adapters. */
export function loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost(
  optionsValue: DefaultWorkbenchFeishuOAuthHostedReauthorizationRuntimeOptions,
): Promise<WorkbenchFeishuOAuthHostedReauthorizationHost> {
  const options = readDefaultStoredOptions(optionsValue)
  return loadWorkbenchFeishuOAuthHostedReauthorizationHost({
    identityStore: options.identityStore,
    authorizationStore: options.authorizationStore,
    journal: options.journal,
    flow: new FeishuOAuthAuthorizationFlow({ transport: new FeishuOAuthV3HttpTransport() }),
    persister: new FeishuOAuthInitialCredentialPersister({
      verifier: new FeishuOAuthUserPrincipalVerifier({
        client: new FeishuOAuthUserInfoHttpClient(),
      }),
      replacer: new FeishuSystemKeychainSecretReplacer(),
    }),
  })
}
