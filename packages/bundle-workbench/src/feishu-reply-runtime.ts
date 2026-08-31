import {
  FeishuBotKeychainScopeProbe,
  FeishuBotTenantTokenAcquirer,
  FeishuOAuthRotationCoordinator,
  FeishuReplyExecutionAdapter,
  FeishuReplyExecutor,
  FeishuReplyHttpClient,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
  type FeishuRuntimeLease,
} from '@twindesk/plugin-feishu'
import {
  WorkHubActionExecutionHost,
  type WorkHubActionExecutionHostOptions,
} from '@twindesk/plugin-work-hub'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

export interface WorkbenchFeishuReplyRuntimeOptions {
  readonly database: TwinDeskDatabase
  readonly configuration: unknown
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly replyClient: FeishuReplyHttpClient
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly botScopeProbe?: FeishuBotKeychainScopeProbe
  readonly botTokenAcquirer?: FeishuBotTenantTokenAcquirer
  readonly userScopeProbe?: FeishuUserCredentialScopeProbe
  readonly userRotationCoordinator?: FeishuOAuthRotationCoordinator
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

interface ParsedOptions {
  readonly database: TwinDeskDatabase
  readonly configuration: FeishuIdentityConfiguration
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly replyClient: FeishuReplyHttpClient
  readonly leaseManager: FeishuRuntimeLeaseManager
  readonly botScopeProbe?: FeishuBotKeychainScopeProbe
  readonly botTokenAcquirer?: FeishuBotTenantTokenAcquirer
  readonly userScopeProbe?: FeishuUserCredentialScopeProbe
  readonly userRotationCoordinator?: FeishuOAuthRotationCoordinator
  readonly now: () => number
}

const REQUIRED_DATABASE_METHODS = Object.freeze([
  'appendAuditRecords',
  'beginActionExecution',
  'consumeActionApproval',
  'getActionApproval',
  'getActionExecutionReceipt',
  'getActionProposal',
  'recordActionExecutionReceipt',
  'recoverActionExecution',
  'reserveActionDispatch',
])

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu reply runtime configuration is invalid.')
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

function isExecutionDatabase(value: unknown): value is TwinDeskDatabase {
  return (
    typeof value === 'object' &&
    value !== null &&
    REQUIRED_DATABASE_METHODS.every((method) => hasDataMethod(value, method))
  )
}

function readOptions(value: unknown): ParsedOptions {
  const record = dataRecord(value)
  let configuration: FeishuIdentityConfiguration
  try {
    configuration = parseFeishuIdentityConfiguration(record.configuration)
  } catch {
    throw invalid()
  }
  const expected = ['database', 'configuration', 'resolver', 'replyClient']
  if (Object.hasOwn(record, 'leaseManager')) expected.push('leaseManager')
  if (configuration.bot !== undefined) expected.push('botScopeProbe', 'botTokenAcquirer')
  if (configuration.user !== undefined) expected.push('userScopeProbe', 'userRotationCoordinator')
  if (Object.hasOwn(record, 'now')) expected.push('now')
  exactKeys(record, expected)

  const leaseManager = Object.hasOwn(record, 'leaseManager')
    ? record.leaseManager
    : new FeishuRuntimeLeaseManager()
  const now = Object.hasOwn(record, 'now') ? record.now : Date.now
  if (
    !isExecutionDatabase(record.database) ||
    !(record.resolver instanceof FeishuSystemKeychainSecretResolver) ||
    !(record.replyClient instanceof FeishuReplyHttpClient) ||
    !(leaseManager instanceof FeishuRuntimeLeaseManager) ||
    typeof now !== 'function' ||
    (configuration.bot !== undefined &&
      (!(record.botScopeProbe instanceof FeishuBotKeychainScopeProbe) ||
        !(record.botTokenAcquirer instanceof FeishuBotTenantTokenAcquirer))) ||
    (configuration.user !== undefined &&
      (!(record.userScopeProbe instanceof FeishuUserCredentialScopeProbe) ||
        !(record.userRotationCoordinator instanceof FeishuOAuthRotationCoordinator)))
  ) {
    throw invalid()
  }
  return Object.freeze({
    database: record.database as TwinDeskDatabase,
    configuration,
    resolver: record.resolver,
    replyClient: record.replyClient,
    leaseManager,
    ...(configuration.bot === undefined
      ? {}
      : {
          botScopeProbe: record.botScopeProbe as FeishuBotKeychainScopeProbe,
          botTokenAcquirer: record.botTokenAcquirer as FeishuBotTenantTokenAcquirer,
        }),
    ...(configuration.user === undefined
      ? {}
      : {
          userScopeProbe: record.userScopeProbe as FeishuUserCredentialScopeProbe,
          userRotationCoordinator: record.userRotationCoordinator as FeishuOAuthRotationCoordinator,
        }),
    now: now as () => number,
  })
}

/**
 * Bind the Connector-neutral Work Hub operation to the complete Feishu reply
 * execution stack under one kernel-backed Host lease.
 */
export function createWorkbenchFeishuReplyExecutionHost(
  optionsValue: WorkbenchFeishuReplyRuntimeOptions,
): WorkHubActionExecutionHost<FeishuRuntimeLease> {
  const options = readOptions(optionsValue)
  const hostOptions: WorkHubActionExecutionHostOptions<FeishuRuntimeLease> = {
    database: options.database,
    now: options.now,
    withExclusiveOperation(signal, operation) {
      return options.leaseManager.withLease(options.configuration, signal, operation)
    },
    async execute(action, lease, signal, reserveDispatch) {
      const client = new FeishuReplyExecutionAdapter({
        configuration: options.configuration,
        lease,
        resolver: options.resolver,
        replyClient: options.replyClient,
        ...(options.configuration.bot === undefined
          ? {}
          : {
              botScopeProbe: options.botScopeProbe as FeishuBotKeychainScopeProbe,
              botTokenAcquirer: options.botTokenAcquirer as FeishuBotTenantTokenAcquirer,
            }),
        ...(options.configuration.user === undefined
          ? {}
          : {
              userScopeProbe: options.userScopeProbe as FeishuUserCredentialScopeProbe,
              userRotationCoordinator:
                options.userRotationCoordinator as FeishuOAuthRotationCoordinator,
            }),
        now: options.now,
      })
      return new FeishuReplyExecutor(options.configuration, client, {
        now: options.now,
        async reserveDispatch(reservedAction, reservedAt, reserveSignal) {
          reserveSignal.throwIfAborted()
          return reserveDispatch(reservedAction, reservedAt)
        },
      }).execute(action, signal)
    },
  }
  return new WorkHubActionExecutionHost(hostOptions)
}
