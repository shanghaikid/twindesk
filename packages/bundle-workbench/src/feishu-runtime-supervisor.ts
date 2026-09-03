import { isAbsolute, resolve } from 'node:path'

import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationJournal,
  FeishuOAuthV3HttpTransport,
  FeishuOAuthV3TokenRefresher,
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  FeishuUserMessageSearchHttpClient,
  type FeishuIdentityConfiguration,
  type FeishuRuntimeLease,
} from '@twindesk/plugin-feishu'
import { openTwinDeskDatabase } from '@twindesk/storage-sqlite'

import {
  startWorkbenchFeishuRuntimeOwner,
  type WorkbenchFeishuRuntimeOwner,
} from './feishu-runtime-owner.ts'
import { createWorkbenchFeishuUserPollingRuntime } from './feishu-user-polling-runtime.ts'

export interface WorkbenchFeishuRuntimeSupervisorOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly rotationJournal: FeishuOAuthRotationJournal
  readonly databasePath: string
  readonly tenantKey: string
  readonly parentLeaseManager?: FeishuRuntimeLeaseManager
  readonly onAttentionRequired?: () => void
}

export interface WorkbenchFeishuRuntimeSupervisor {
  /** Stable Web-facing manager that delegates to the current exact owner. */
  readonly leaseManager: FeishuRuntimeLeaseManager
  /** Re-read durable identity state and restart polling beneath the right owner. */
  refresh(): Promise<void>
  /** Schedule refresh without making a completed Settings or OAuth write fail. */
  requestRefresh(): void
  /** Stop accepting lease work and stop polling while Web requests drain. */
  quiesce(): Promise<void>
  /** Release the owner and close the dedicated polling database. */
  close(): Promise<void>
}

type UnknownRecord = Readonly<Record<string, unknown>>
type LeaseConsumer<TResult> = (lease: FeishuRuntimeLease) => Promise<TResult> | TResult

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu runtime supervisor configuration is invalid.')
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

function identifierAt(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function pathAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new TypeError()
  }
  return value
}

function readOptions(value: unknown): WorkbenchFeishuRuntimeSupervisorOptions {
  const record = dataRecord(value)
  const required = ['identityStore', 'rotationJournal', 'databasePath', 'tenantKey']
  const allowed = [...required, 'parentLeaseManager', 'onAttentionRequired']
  if (
    Object.keys(record).length < required.length ||
    Object.keys(record).length > allowed.length ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.rotationJournal instanceof FeishuOAuthRotationJournal) ||
    (record.parentLeaseManager !== undefined &&
      !(record.parentLeaseManager instanceof FeishuRuntimeLeaseManager)) ||
    (record.onAttentionRequired !== undefined && typeof record.onAttentionRequired !== 'function')
  ) {
    throw invalid()
  }
  try {
    return Object.freeze({
      identityStore: record.identityStore,
      rotationJournal: record.rotationJournal,
      databasePath: pathAt(record.databasePath),
      tenantKey: identifierAt(record.tenantKey, 512),
      ...(record.parentLeaseManager === undefined
        ? {}
        : { parentLeaseManager: record.parentLeaseManager as FeishuRuntimeLeaseManager }),
      ...(record.onAttentionRequired === undefined
        ? {}
        : { onAttentionRequired: record.onAttentionRequired as () => void }),
    })
  } catch {
    throw invalid()
  }
}

function stopped(): FeishuRuntimeLeaseError {
  return new FeishuRuntimeLeaseError(
    'lease_lost',
    'stop_connector',
    'The Feishu runtime lease is no longer held.',
  )
}

function configurationKey(configuration: FeishuIdentityConfiguration): string {
  return JSON.stringify(configuration)
}

class DelegatingFeishuRuntimeLeaseManager extends FeishuRuntimeLeaseManager {
  readonly #withLease: <TResult>(
    configuration: unknown,
    signal: AbortSignal,
    use: LeaseConsumer<TResult>,
  ) => Promise<TResult>

  constructor(
    withLease: <TResult>(
      configuration: unknown,
      signal: AbortSignal,
      use: LeaseConsumer<TResult>,
    ) => Promise<TResult>,
  ) {
    super()
    this.#withLease = withLease
  }

  override withLease<TResult>(
    configuration: unknown,
    signal: AbortSignal,
    use: LeaseConsumer<TResult>,
  ): Promise<TResult> {
    return this.#withLease(configuration, signal, use)
  }
}

type PollingRun = Readonly<{
  controller: AbortController
  completion: Promise<void>
}>

class DefaultWorkbenchFeishuRuntimeSupervisor implements WorkbenchFeishuRuntimeSupervisor {
  readonly #options: WorkbenchFeishuRuntimeSupervisorOptions
  readonly #parentLeaseManager: FeishuRuntimeLeaseManager
  readonly #pollingDatabase: ReturnType<typeof openTwinDeskDatabase>
  readonly leaseManager: FeishuRuntimeLeaseManager
  #tail: Promise<void> = Promise.resolve()
  #owner: WorkbenchFeishuRuntimeOwner | undefined
  #ownerConfigurationKey: string | undefined
  #polling: PollingRun | undefined
  #baseOperations = 0
  #baseDrained: Promise<void> | undefined
  #resolveBaseDrained: (() => void) | undefined
  #quiescing = false
  #quiesced: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(options: WorkbenchFeishuRuntimeSupervisorOptions) {
    this.#options = options
    this.#parentLeaseManager = options.parentLeaseManager ?? new FeishuRuntimeLeaseManager()
    this.#pollingDatabase = openTwinDeskDatabase(options.databasePath)
    this.leaseManager = new DelegatingFeishuRuntimeLeaseManager((configuration, signal, use) =>
      this.#withLease(configuration, signal, use),
    )
  }

  refresh(): Promise<void> {
    if (this.#quiescing) return Promise.reject(stopped())
    return this.#enqueue(() => this.#refreshNow())
  }

  requestRefresh(): void {
    if (this.#quiescing) return
    void this.refresh().catch(() => this.#attention())
  }

  quiesce(): Promise<void> {
    this.#quiescing = true
    this.#quiesced ??= this.#enqueue(() => this.#stopPolling())
    return this.#quiesced
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.quiesce()
      await this.#enqueue(async () => {
        await this.#waitForBaseOperations()
        const owner = this.#owner
        this.#owner = undefined
        this.#ownerConfigurationKey = undefined
        try {
          await owner?.close()
        } finally {
          this.#pollingDatabase.close()
        }
      })
    })()
    return this.#closing
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #withLease<TResult>(
    configuration: unknown,
    signal: AbortSignal,
    use: LeaseConsumer<TResult>,
  ): Promise<TResult> {
    const transition = this.#tail
    await transition
    if (this.#quiescing) throw stopped()
    const owner = this.#owner
    if (owner !== undefined) return owner.leaseManager.withLease(configuration, signal, use)
    this.#baseOperations += 1
    try {
      return await this.#parentLeaseManager.withLease(configuration, signal, use)
    } finally {
      this.#baseOperations -= 1
      if (this.#baseOperations === 0) this.#resolveBaseDrained?.()
    }
  }

  async #waitForBaseOperations(): Promise<void> {
    if (this.#baseOperations === 0) return
    this.#baseDrained ??= new Promise<void>((resolve) => {
      this.#resolveBaseDrained = resolve
    })
    await this.#baseDrained
    this.#baseDrained = undefined
    this.#resolveBaseDrained = undefined
  }

  async #refreshNow(): Promise<void> {
    if (this.#quiescing) throw stopped()
    const configuration = await this.#options.identityStore.read()
    if (configuration?.user === undefined) {
      await this.#stopPolling()
      const owner = this.#owner
      this.#owner = undefined
      this.#ownerConfigurationKey = undefined
      await owner?.close()
      return
    }

    const key = configurationKey(configuration)
    if (this.#ownerConfigurationKey !== key) {
      await this.#stopPolling()
      const previousOwner = this.#owner
      this.#owner = undefined
      this.#ownerConfigurationKey = undefined
      await previousOwner?.close()
      await this.#waitForBaseOperations()
      if (this.#quiescing) throw stopped()
      const owner = await startWorkbenchFeishuRuntimeOwner({
        configuration,
        leaseManager: this.#parentLeaseManager,
      })
      this.#owner = owner
      this.#ownerConfigurationKey = key
    } else {
      await this.#stopPolling()
    }
    this.#startPolling(configuration)
  }

  #startPolling(configuration: FeishuIdentityConfiguration): void {
    const owner = this.#owner
    if (owner === undefined || configuration.user === undefined) throw invalid()
    const resolver = new FeishuSystemKeychainSecretResolver()
    const polling = createWorkbenchFeishuUserPollingRuntime({
      database: this.#pollingDatabase,
      configuration,
      tenantKey: this.#options.tenantKey,
      resolver,
      scopeProbe: new FeishuUserCredentialScopeProbe({ configuration, resolver }),
      rotationCoordinator: new FeishuOAuthRotationCoordinator({
        resolver,
        refresher: new FeishuOAuthV3TokenRefresher({
          transport: new FeishuOAuthV3HttpTransport(),
        }),
        replacer: new FeishuSystemKeychainSecretReplacer(),
        journal: this.#options.rotationJournal,
      }),
      httpClient: new FeishuUserMessageSearchHttpClient(),
      leaseManager: owner.leaseManager,
    })
    const controller = new AbortController()
    let run!: PollingRun
    const completion = polling
      .run(controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) this.#attention()
        },
        () => {
          if (!controller.signal.aborted) this.#attention()
        },
      )
      .finally(() => {
        if (this.#polling === run) this.#polling = undefined
      })
    run = Object.freeze({ controller, completion })
    this.#polling = run
  }

  async #stopPolling(): Promise<void> {
    const run = this.#polling
    if (run === undefined) return
    run.controller.abort()
    await run.completion
    if (this.#polling === run) this.#polling = undefined
  }

  #attention(): void {
    try {
      this.#options.onAttentionRequired?.()
    } catch {
      // A diagnostic observer cannot change durable Connector state.
    }
  }
}

/** Construct the stable Web manager and its restartable Cordis polling lifecycle. */
export function createWorkbenchFeishuRuntimeSupervisor(
  optionsValue: WorkbenchFeishuRuntimeSupervisorOptions,
): WorkbenchFeishuRuntimeSupervisor {
  return new DefaultWorkbenchFeishuRuntimeSupervisor(readOptions(optionsValue))
}
