import {
  FeishuOAuthReauthorizationCoordinator,
  FeishuRuntimeLeaseManager,
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuOAuthReauthorizationResult,
  type FeishuOAuthV3TokenSet,
} from '@twindesk/plugin-feishu'

export interface WorkbenchFeishuOAuthReauthorizationRuntimeOptions {
  readonly configuration: unknown
  readonly coordinator: FeishuOAuthReauthorizationCoordinator
  readonly leaseManager?: FeishuRuntimeLeaseManager
}

export interface WorkbenchFeishuOAuthReauthorizationHost {
  /**
   * Persist already-exchanged replacement evidence only while the exact
   * rotation journal is blocked on User reauthorization.
   */
  replace(
    clientSecret: Uint8Array,
    tokenSet: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
  ): Promise<FeishuOAuthReauthorizationResult>
}

type UnknownRecord = Readonly<Record<string, unknown>>

interface ParsedOptions {
  readonly configuration: FeishuIdentityConfiguration
  readonly coordinator: FeishuOAuthReauthorizationCoordinator
  readonly leaseManager: FeishuRuntimeLeaseManager
}

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu OAuth reauthorization runtime is invalid.')
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
  const expected = ['configuration', 'coordinator']
  if (Object.hasOwn(record, 'leaseManager')) expected.push('leaseManager')
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw invalid()
  }
  let configuration: FeishuIdentityConfiguration
  try {
    configuration = parseFeishuIdentityConfiguration(record.configuration)
  } catch {
    throw invalid()
  }
  const leaseManager = Object.hasOwn(record, 'leaseManager')
    ? record.leaseManager
    : new FeishuRuntimeLeaseManager()
  if (
    configuration.user === undefined ||
    !(record.coordinator instanceof FeishuOAuthReauthorizationCoordinator) ||
    !(leaseManager instanceof FeishuRuntimeLeaseManager)
  ) {
    throw invalid()
  }
  return Object.freeze({
    configuration,
    coordinator: record.coordinator,
    leaseManager,
  }) as ParsedOptions
}

/**
 * Bind the already-verified OAuth replacement boundary to the same exclusive
 * Feishu Host ownership used by polling, rotation, and external writes.
 * This host neither starts authorization nor retries an approved action.
 */
export function createWorkbenchFeishuOAuthReauthorizationHost(
  optionsValue: WorkbenchFeishuOAuthReauthorizationRuntimeOptions,
): WorkbenchFeishuOAuthReauthorizationHost {
  const options = readOptions(optionsValue)
  return Object.freeze({
    replace(
      clientSecret: Uint8Array,
      tokenSet: FeishuOAuthV3TokenSet,
      signal: AbortSignal,
    ): Promise<FeishuOAuthReauthorizationResult> {
      return options.leaseManager.withLease(options.configuration, signal, (lease) => {
        lease.assertHeld()
        return options.coordinator.replace(options.configuration, clientSecret, tokenSet, signal)
      })
    },
  })
}
