import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthReconciler,
  FeishuOAuthRotationJournal,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
} from '@twindesk/plugin-feishu'

export type WorkbenchFeishuOAuthReconciliationSnapshot =
  | Readonly<{ version: 1; connectorId: 'feishu'; status: 'reconciled' }>
  | Readonly<{ version: 1; connectorId: 'feishu'; status: 'still_required' }>

export interface WorkbenchFeishuOAuthReconciliationService {
  reconcile(signal: AbortSignal): Promise<WorkbenchFeishuOAuthReconciliationSnapshot>
}

export interface WorkbenchFeishuOAuthReconciliationOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly journal: FeishuOAuthRotationJournal
  readonly resolver?: FeishuSystemKeychainSecretResolver
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly now?: () => number
}

type ParsedOptions = Readonly<{
  identityStore: FeishuIdentityConfigurationStore
  journal: FeishuOAuthRotationJournal
  resolver: FeishuSystemKeychainSecretResolver
  leaseManager: FeishuRuntimeLeaseManager
  now: () => number
}>

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu OAuth reconciliation runtime is invalid.')
}

function readOptions(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.length < 2 ||
      keys.length > 5 ||
      keys.some(
        (key) => !['identityStore', 'journal', 'resolver', 'leaseManager', 'now'].includes(key),
      ) ||
      !['identityStore', 'journal'].every((key) => Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const identityStore = descriptors.identityStore?.value
    const journal = descriptors.journal?.value
    const resolver = descriptors.resolver?.value ?? new FeishuSystemKeychainSecretResolver()
    const leaseManager = descriptors.leaseManager?.value ?? new FeishuRuntimeLeaseManager()
    const now = descriptors.now?.value ?? Date.now
    if (
      !(identityStore instanceof FeishuIdentityConfigurationStore) ||
      !(journal instanceof FeishuOAuthRotationJournal) ||
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(leaseManager instanceof FeishuRuntimeLeaseManager) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ identityStore, journal, resolver, leaseManager, now })
  } catch {
    throw invalid()
  }
}

function snapshot(
  status: WorkbenchFeishuOAuthReconciliationSnapshot['status'],
): WorkbenchFeishuOAuthReconciliationSnapshot {
  return Object.freeze({ version: 1, connectorId: 'feishu', status })
}

/**
 * Hold the Feishu Host lease while comparing the exact configured Keychain
 * bundle with unresolved journal evidence. This runtime cannot refresh or
 * replace a credential.
 */
export function createWorkbenchFeishuOAuthReconciliationService(
  optionsValue: WorkbenchFeishuOAuthReconciliationOptions,
): WorkbenchFeishuOAuthReconciliationService {
  const options = readOptions(optionsValue)
  const reconciler = new FeishuOAuthReconciler({
    resolver: options.resolver,
    journal: options.journal,
    now: options.now,
  })
  return Object.freeze({
    async reconcile(signal: AbortSignal): Promise<WorkbenchFeishuOAuthReconciliationSnapshot> {
      signal.throwIfAborted()
      const configuration = await options.identityStore.read()
      if (configuration?.user === undefined) throw invalid()
      return options.leaseManager.withLease(configuration, signal, async (lease) => {
        lease.assertHeld()
        const result = await reconciler.reconcile(configuration, signal)
        lease.assertHeld()
        return snapshot(result.status)
      })
    },
  })
}
