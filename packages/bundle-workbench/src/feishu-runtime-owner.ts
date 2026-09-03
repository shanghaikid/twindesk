import {
  FeishuRuntimeLeaseError,
  FeishuRuntimeLeaseManager,
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuRuntimeLease,
} from '@twindesk/plugin-feishu'

export interface WorkbenchFeishuRuntimeOwnerOptions {
  readonly configuration: unknown
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export interface WorkbenchFeishuRuntimeOwner {
  /** Reuses the one owner lease and never binds another kernel endpoint. */
  readonly leaseManager: FeishuRuntimeLeaseManager
  /** Stop accepting operations, drain existing callbacks, then release ownership. */
  close(): Promise<void>
}

type UnknownRecord = Readonly<Record<string, unknown>>
type WithLease = FeishuRuntimeLeaseManager['withLease']
type AssertHeld = FeishuRuntimeLease['assertHeld']

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu runtime owner configuration is invalid.')
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

function dataMethod<TMethod extends (...arguments_: never[]) => unknown>(
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
    throw invalid()
  }
}

function readOptions(value: unknown): Readonly<{
  configuration: FeishuIdentityConfiguration
  withLease: WithLease
}> {
  const record = dataRecord(value)
  const expected = Object.hasOwn(record, 'leaseManager')
    ? ['configuration', 'leaseManager']
    : ['configuration']
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalid()
  }
  try {
    const configuration = parseFeishuIdentityConfiguration(record.configuration)
    const leaseManager = record.leaseManager ?? new FeishuRuntimeLeaseManager()
    if (!(leaseManager instanceof FeishuRuntimeLeaseManager)) throw new TypeError()
    return Object.freeze({
      configuration,
      withLease: dataMethod<WithLease>(leaseManager, 'withLease'),
    })
  } catch {
    throw invalid()
  }
}

function configurationKey(value: FeishuIdentityConfiguration): string {
  return JSON.stringify(value)
}

function leaseError(
  code: ConstructorParameters<typeof FeishuRuntimeLeaseError>[0],
  recovery: ConstructorParameters<typeof FeishuRuntimeLeaseError>[1],
  message: string,
): FeishuRuntimeLeaseError {
  return new FeishuRuntimeLeaseError(code, recovery, message)
}

class SharedWorkbenchFeishuLeaseManager extends FeishuRuntimeLeaseManager {
  readonly #configurationKey: string
  readonly #lease: FeishuRuntimeLease
  #accepting = true
  #activeOperations = 0
  #drained: Promise<void> | undefined
  #resolveDrained: (() => void) | undefined

  constructor(configuration: FeishuIdentityConfiguration, lease: FeishuRuntimeLease) {
    super()
    this.#configurationKey = configurationKey(configuration)
    const assertHeld = dataMethod<AssertHeld>(lease, 'assertHeld')
    this.#lease = Object.freeze({
      assertHeld: () => {
        if (!this.#accepting) {
          throw leaseError(
            'lease_lost',
            'stop_connector',
            'The Feishu runtime lease is no longer held.',
          )
        }
        assertHeld()
      },
    })
  }

  override async withLease<TResult>(
    configurationValue: unknown,
    signal: AbortSignal,
    use: (lease: FeishuRuntimeLease) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    if (!(signal instanceof AbortSignal) || typeof use !== 'function') {
      throw leaseError(
        'invalid_request',
        'do_not_retry',
        'The Feishu runtime lease request is invalid.',
      )
    }
    if (signal.aborted) {
      throw leaseError(
        'cancelled',
        'stop_connector',
        'The Feishu runtime lease request was cancelled.',
      )
    }
    let configuration: FeishuIdentityConfiguration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw leaseError(
        'invalid_request',
        'do_not_retry',
        'The Feishu runtime lease identity configuration is invalid.',
      )
    }
    if (configurationKey(configuration) !== this.#configurationKey) {
      throw leaseError(
        'invalid_request',
        'do_not_retry',
        'The Feishu runtime lease identity configuration is invalid.',
      )
    }
    this.#lease.assertHeld()
    this.#activeOperations += 1
    try {
      if (signal.aborted) {
        throw leaseError(
          'cancelled',
          'stop_connector',
          'The Feishu runtime lease request was cancelled.',
        )
      }
      this.#lease.assertHeld()
      return await use(this.#lease)
    } finally {
      this.#activeOperations -= 1
      if (this.#activeOperations === 0) this.#resolveDrained?.()
    }
  }

  async stopAndDrain(): Promise<void> {
    this.#accepting = false
    if (this.#activeOperations === 0) return
    this.#drained ??= new Promise<void>((resolve) => {
      this.#resolveDrained = resolve
    })
    await this.#drained
  }
}

/** Acquire one kernel-backed owner and expose only an exact-configuration shared view. */
export async function startWorkbenchFeishuRuntimeOwner(
  optionsValue: WorkbenchFeishuRuntimeOwnerOptions,
): Promise<WorkbenchFeishuRuntimeOwner> {
  const options = readOptions(optionsValue)
  let resolveReady!: (manager: SharedWorkbenchFeishuLeaseManager) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<SharedWorkbenchFeishuLeaseManager>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveStop!: () => void
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve
  })
  const acquisitionSignal = new AbortController().signal
  const lifetime = options.withLease(options.configuration, acquisitionSignal, async (lease) => {
    lease.assertHeld()
    resolveReady(new SharedWorkbenchFeishuLeaseManager(options.configuration, lease))
    await stopped
  })
  void lifetime.catch(rejectReady)
  const shared = await ready
  let closing: Promise<void> | undefined
  return Object.freeze({
    leaseManager: shared,
    close() {
      closing ??= (async () => {
        await shared.stopAndDrain()
        resolveStop()
        await lifetime
      })()
      return closing
    },
  })
}
