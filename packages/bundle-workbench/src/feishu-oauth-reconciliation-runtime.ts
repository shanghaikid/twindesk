import { randomUUID } from 'node:crypto'

import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthReconciler,
  FeishuOAuthRotationJournal,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
  type FeishuIdentityConfiguration,
  type FeishuOAuthRotationSnapshot,
} from '@twindesk/plugin-feishu'
import type {
  ConnectorMaintenanceResult,
  StoredConnectorMaintenanceOperation,
  TwinDeskDatabase,
} from '@twindesk/storage-sqlite'

export type WorkbenchFeishuOAuthReconciliationSnapshot =
  | Readonly<{ version: 1; connectorId: 'feishu'; status: 'reconciled' }>
  | Readonly<{ version: 1; connectorId: 'feishu'; status: 'still_required' }>

export interface WorkbenchFeishuOAuthReconciliationService {
  recoverPending(signal: AbortSignal): Promise<void>
  reconcile(signal: AbortSignal): Promise<WorkbenchFeishuOAuthReconciliationSnapshot>
}

export interface WorkbenchFeishuOAuthReconciliationOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly journal: FeishuOAuthRotationJournal
  readonly database: TwinDeskDatabase
  readonly resolver?: FeishuSystemKeychainSecretResolver
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly now?: () => number
}

type ParsedOptions = Readonly<{
  identityStore: FeishuIdentityConfigurationStore
  journal: FeishuOAuthRotationJournal
  database: TwinDeskDatabase
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
      keys.length < 3 ||
      keys.length > 6 ||
      keys.some(
        (key) =>
          !['identityStore', 'journal', 'database', 'resolver', 'leaseManager', 'now'].includes(
            key,
          ),
      ) ||
      !['identityStore', 'journal', 'database'].every((key) => Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const identityStore = descriptors.identityStore?.value
    const journal = descriptors.journal?.value
    const database = descriptors.database?.value
    const resolver = descriptors.resolver?.value ?? new FeishuSystemKeychainSecretResolver()
    const leaseManager = descriptors.leaseManager?.value ?? new FeishuRuntimeLeaseManager()
    const now = descriptors.now?.value ?? Date.now
    if (
      !(identityStore instanceof FeishuIdentityConfigurationStore) ||
      !(journal instanceof FeishuOAuthRotationJournal) ||
      typeof database !== 'object' ||
      database === null ||
      typeof Reflect.get(database, 'beginConnectorMaintenance') !== 'function' ||
      typeof Reflect.get(database, 'settleConnectorMaintenance') !== 'function' ||
      typeof Reflect.get(database, 'getPendingConnectorMaintenance') !== 'function' ||
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(leaseManager instanceof FeishuRuntimeLeaseManager) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      identityStore,
      journal,
      database: database as TwinDeskDatabase,
      resolver,
      leaseManager,
      now,
    })
  } catch {
    throw invalid()
  }
}

function snapshot(
  status: WorkbenchFeishuOAuthReconciliationSnapshot['status'],
): WorkbenchFeishuOAuthReconciliationSnapshot {
  return Object.freeze({ version: 1, connectorId: 'feishu', status })
}

function observedAt(now: () => number): StoredConnectorMaintenanceOperation['requestedAt'] {
  try {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new TypeError()
    }
    return new Date(value).toISOString() as StoredConnectorMaintenanceOperation['requestedAt']
  } catch {
    throw invalid()
  }
}

function settlementAt(
  options: ParsedOptions,
  operation: StoredConnectorMaintenanceOperation,
): StoredConnectorMaintenanceOperation['requestedAt'] {
  const current = observedAt(options.now)
  return Date.parse(current) < Date.parse(operation.requestedAt) ? operation.requestedAt : current
}

function settle(
  options: ParsedOptions,
  operation: StoredConnectorMaintenanceOperation,
  result: ConnectorMaintenanceResult,
): void {
  options.database.settleConnectorMaintenance({
    kind: 'connector_maintenance_settlement',
    schemaVersion: 1,
    id: operation.id,
    result,
    settledAt: settlementAt(options, operation),
  })
}

function terminalAfterRequest(
  latest: FeishuOAuthRotationSnapshot | undefined,
  operation: StoredConnectorMaintenanceOperation,
): boolean {
  return (
    (latest?.state === 'completed' || latest?.state === 'reauthorized') &&
    Date.parse(latest.recordedAt) >= Date.parse(operation.requestedAt)
  )
}

async function repairPending(
  options: ParsedOptions,
  operation: StoredConnectorMaintenanceOperation,
): Promise<WorkbenchFeishuOAuthReconciliationSnapshot | undefined> {
  const latest = await options.journal.inspect()
  if (terminalAfterRequest(latest, operation)) {
    settle(options, operation, 'reconciled')
    return snapshot('reconciled')
  }
  if (
    latest?.state === 'uncertain' ||
    latest?.state === 'reauthorization_reserved' ||
    (latest?.state === 'reserved' && !options.journal.isActiveReservation(latest.sequence))
  ) {
    settle(options, operation, 'still_required')
    return snapshot('still_required')
  }
  if (latest?.state === 'reserved') throw invalid()
  settle(options, operation, 'failed')
  return undefined
}

async function withConfiguredLease<TResult>(
  options: ParsedOptions,
  signal: AbortSignal,
  use: (
    configuration: FeishuIdentityConfiguration & {
      readonly user: NonNullable<FeishuIdentityConfiguration['user']>
    },
  ) => Promise<TResult>,
): Promise<TResult> {
  const configuration = await options.identityStore.read()
  if (configuration?.user === undefined) throw invalid()
  const configured = configuration as FeishuIdentityConfiguration & {
    readonly user: NonNullable<FeishuIdentityConfiguration['user']>
  }
  return options.leaseManager.withLease(configured, signal, async (lease) => {
    lease.assertHeld()
    const result = await use(configured)
    lease.assertHeld()
    return result
  })
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
    async recoverPending(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted()
      if (
        options.database.getPendingConnectorMaintenance('feishu', 'credential_reconciliation') ===
        undefined
      ) {
        return
      }
      await withConfiguredLease(options, signal, async () => {
        const pending = options.database.getPendingConnectorMaintenance(
          'feishu',
          'credential_reconciliation',
        )
        if (pending !== undefined) await repairPending(options, pending)
      })
    },
    async reconcile(signal: AbortSignal): Promise<WorkbenchFeishuOAuthReconciliationSnapshot> {
      signal.throwIfAborted()
      return withConfiguredLease(options, signal, async (configuration) => {
        const pending = options.database.getPendingConnectorMaintenance(
          'feishu',
          'credential_reconciliation',
        )
        if (pending !== undefined) {
          const repaired = await repairPending(options, pending)
          if (repaired !== undefined) return repaired
          throw invalid()
        }
        const started = options.database.beginConnectorMaintenance({
          kind: 'connector_maintenance_request',
          schemaVersion: 1,
          id: `connector-maintenance:feishu:credential-reconciliation:${randomUUID()}`,
          connectorId: 'feishu',
          operation: 'credential_reconciliation',
          requestedAt: observedAt(options.now),
        }).operation
        let result: Awaited<ReturnType<FeishuOAuthReconciler['reconcile']>>
        try {
          result = await reconciler.reconcile(configuration, signal)
        } catch (error) {
          let latest: FeishuOAuthRotationSnapshot | undefined
          try {
            latest = await options.journal.inspect()
          } catch {
            throw error
          }
          if (terminalAfterRequest(latest, started)) {
            settle(options, started, 'reconciled')
            return snapshot('reconciled')
          }
          settle(options, started, signal.aborted ? 'cancelled' : 'failed')
          if (signal.aborted) signal.throwIfAborted()
          throw error
        }
        settle(options, started, result.status)
        return snapshot(result.status)
      })
    },
  })
}
