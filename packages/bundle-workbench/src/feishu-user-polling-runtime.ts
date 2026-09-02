import {
  FEISHU_USER_MESSAGE_STREAM,
  FeishuMessageNormalizer,
  FeishuRuntimeLeaseManager,
  FeishuUserDiscoveryError,
  FeishuUserMessageDiscoverer,
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuRuntimeLease,
  type FeishuUserMessageSearchClient,
} from '@twindesk/plugin-feishu'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 60_000

export interface WorkbenchFeishuUserPollingRuntimeOptions {
  readonly database: TwinDeskDatabase
  readonly configuration: unknown
  /** Verified Host configuration; never accepted from a browser request. */
  readonly tenantKey: string
  readonly searchClient: FeishuUserMessageSearchClient
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly pageSize?: number
  readonly pollIntervalMs?: number
  readonly retryDelayMs?: number
  readonly maximumRetryDelayMs?: number
  readonly now?: () => number
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}

type UnknownRecord = Readonly<Record<string, unknown>>

interface ParsedOptions {
  readonly database: TwinDeskDatabase
  readonly configuration: FeishuIdentityConfiguration
  readonly tenantKey: string
  readonly searchClient: FeishuUserMessageSearchClient
  readonly leaseManager: FeishuRuntimeLeaseManager
  readonly pageSize: number
  readonly pollIntervalMs: number
  readonly retryDelayMs: number
  readonly maximumRetryDelayMs: number
  readonly now: () => number
  readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>
}

const REQUIRED_DATABASE_METHODS = Object.freeze([
  'commitConnectorSyncBatch',
  'getConnectorCursor',
  'getThread',
  'getWorkItem',
])

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu User polling runtime configuration is invalid.')
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

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw invalid()
  }
}

function hasDataMethod(value: object, name: string): boolean {
  try {
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    return false
  } catch {
    return false
  }
}

function isPollingDatabase(value: unknown): value is TwinDeskDatabase {
  return (
    typeof value === 'object' &&
    value !== null &&
    REQUIRED_DATABASE_METHODS.every((method) => hasDataMethod(value, method))
  )
}

function positiveInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function readOptions(value: unknown): ParsedOptions {
  const record = dataRecord(value)
  const expected = ['database', 'configuration', 'tenantKey', 'searchClient']
  for (const optional of [
    'leaseManager',
    'pageSize',
    'pollIntervalMs',
    'retryDelayMs',
    'maximumRetryDelayMs',
    'now',
    'wait',
  ]) {
    if (Object.hasOwn(record, optional)) expected.push(optional)
  }
  exactKeys(record, expected)

  let configuration: FeishuIdentityConfiguration
  try {
    configuration = parseFeishuIdentityConfiguration(record.configuration)
  } catch {
    throw invalid()
  }
  const client = dataRecord(record.searchClient)
  exactKeys(client, ['search'])
  const tenantKey = record.tenantKey
  const leaseManager = record.leaseManager ?? new FeishuRuntimeLeaseManager()
  const pageSize = record.pageSize ?? DEFAULT_PAGE_SIZE
  const pollIntervalMs = record.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const retryDelayMs = record.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maximumRetryDelayMs = record.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS
  const now = record.now ?? Date.now
  const wait = record.wait ?? defaultWait
  if (
    configuration.user === undefined ||
    !isPollingDatabase(record.database) ||
    typeof tenantKey !== 'string' ||
    tenantKey.length === 0 ||
    tenantKey.trim() !== tenantKey ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(tenantKey) ||
    typeof client.search !== 'function' ||
    !(leaseManager instanceof FeishuRuntimeLeaseManager) ||
    !positiveInteger(pageSize, 1, 50) ||
    !positiveInteger(pollIntervalMs, 1, 24 * 60 * 60 * 1000) ||
    !positiveInteger(retryDelayMs, 1, 60 * 60 * 1000) ||
    !positiveInteger(maximumRetryDelayMs, retryDelayMs as number, 24 * 60 * 60 * 1000) ||
    typeof now !== 'function' ||
    typeof wait !== 'function'
  ) {
    throw invalid()
  }
  return Object.freeze({
    database: record.database as TwinDeskDatabase,
    configuration,
    tenantKey,
    searchClient: Object.freeze({
      search: client.search as FeishuUserMessageSearchClient['search'],
    }),
    leaseManager,
    pageSize,
    pollIntervalMs,
    retryDelayMs,
    maximumRetryDelayMs,
    now: now as () => number,
    wait: wait as ParsedOptions['wait'],
  })
}

/**
 * Own the durable User-message polling loop for one configured Feishu account.
 * The caller supervises the returned promise and stops the loop by aborting the
 * supplied signal. No credential value, message content, or cursor position is
 * exposed by this lifecycle boundary.
 */
export class WorkbenchFeishuUserPollingRuntime {
  readonly #options: ParsedOptions
  #running = false

  constructor(optionsValue: WorkbenchFeishuUserPollingRuntimeOptions) {
    this.#options = readOptions(optionsValue)
  }

  async run(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.#running) {
      throw new TypeError('The Workbench Feishu User polling runtime is already running.')
    }
    this.#running = true
    try {
      await this.#options.leaseManager.withLease(this.#options.configuration, signal, (lease) =>
        this.#runWithLease(lease, signal),
      )
    } finally {
      this.#running = false
    }
  }

  async #runWithLease(lease: FeishuRuntimeLease, signal: AbortSignal): Promise<void> {
    const discoverer = new FeishuUserMessageDiscoverer(
      this.#options.configuration,
      this.#options.searchClient,
      {
        tenantKey: this.#options.tenantKey,
        now: this.#options.now,
        initialLookbackMs: 24 * 60 * 60 * 1000,
        overlapMs: 5 * 60 * 1000,
        indexingDelayMs: 30 * 1000,
      },
    )
    const normalizer = new FeishuMessageNormalizer(
      this.#options.configuration,
      this.#options.tenantKey,
    )
    let retryDelayMs = this.#options.retryDelayMs

    while (true) {
      signal.throwIfAborted()
      const cursor = this.#options.database.getConnectorCursor({
        connectorId: 'feishu',
        accountId: this.#options.configuration.accountId,
        stream: FEISHU_USER_MESSAGE_STREAM,
      })
      let batch
      try {
        lease.assertHeld()
        batch = await discoverer.discover(
          {
            accountId: this.#options.configuration.accountId,
            stream: FEISHU_USER_MESSAGE_STREAM,
            limit: this.#options.pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          },
          signal,
        )
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof FeishuUserDiscoveryError) || !error.retryable) throw error
        await this.#options.wait(retryDelayMs, signal)
        retryDelayMs = Math.min(retryDelayMs * 2, this.#options.maximumRetryDelayMs)
        continue
      }

      signal.throwIfAborted()
      const normalized = normalizer.normalizeUserBatch(batch, this.#options.database)
      signal.throwIfAborted()
      lease.assertHeld()
      this.#options.database.commitConnectorSyncBatch({
        connectorId: normalized.connectorId,
        accountId: normalized.accountId,
        stream: normalized.stream,
        events: normalized.events,
        projections: normalized.projections,
        ...(normalized.candidateCursor === undefined
          ? {}
          : { candidateCursor: normalized.candidateCursor }),
      })
      if (normalized.hasMore && normalized.candidateCursor !== undefined) {
        retryDelayMs = this.#options.retryDelayMs
        continue
      }
      if (normalized.hasMore) {
        await this.#options.wait(retryDelayMs, signal)
        retryDelayMs = Math.min(retryDelayMs * 2, this.#options.maximumRetryDelayMs)
        continue
      }
      retryDelayMs = this.#options.retryDelayMs
      await this.#options.wait(this.#options.pollIntervalMs, signal)
    }
  }
}
