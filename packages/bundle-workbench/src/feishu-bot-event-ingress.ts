import { isAbsolute, resolve } from 'node:path'

import { parseSecretReference, type SecretReference } from '@twindesk/domain'
import {
  FeishuBotEventConsumer,
  FeishuBotEventError,
  FeishuBotEventReceiptStore,
  FeishuIdentityConfigurationStore,
  FeishuMessageNormalizer,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
  withFeishuBotEventSubscriptionSecrets,
} from '@twindesk/plugin-feishu'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

export const WORKBENCH_FEISHU_BOT_EVENT_INGRESS_VERSION = 1 as const

export type WorkbenchFeishuBotEventIngressResult =
  | Readonly<{
      version: typeof WORKBENCH_FEISHU_BOT_EVENT_INGRESS_VERSION
      disposition: 'accepted' | 'duplicate' | 'ignored' | 'rejected' | 'unavailable'
    }>
  | Readonly<{
      version: typeof WORKBENCH_FEISHU_BOT_EVENT_INGRESS_VERSION
      disposition: 'challenge'
      challenge: string
    }>

export interface WorkbenchFeishuBotEventIngress {
  consume(request: unknown, signal: AbortSignal): Promise<WorkbenchFeishuBotEventIngressResult>
}

export interface WorkbenchFeishuBotEventIngressOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly database: TwinDeskDatabase
  readonly tenantKey: string
  readonly receiptStorePath: string
  readonly secretReference: SecretReference
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly resolver?: FeishuSystemKeychainSecretResolver
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu Bot event ingress configuration is invalid.')
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

function tenantKeyAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function databaseAt(value: unknown): TwinDeskDatabase {
  if (typeof value !== 'object' || value === null) throw new TypeError()
  for (const method of ['getThread', 'getWorkItem', 'commitConnectorSyncBatch']) {
    let owner: object | null = value
    let found = false
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method)
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        found = true
        break
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    if (!found) throw new TypeError()
  }
  return value as TwinDeskDatabase
}

function readOptions(value: unknown): Required<
  Omit<WorkbenchFeishuBotEventIngressOptions, 'leaseManager' | 'resolver' | 'now'>
> &
  Readonly<{
    leaseManager: FeishuRuntimeLeaseManager
    resolver: FeishuSystemKeychainSecretResolver
    now: () => number
  }> {
  const record = dataRecord(value)
  const required = ['identityStore', 'database', 'tenantKey', 'receiptStorePath', 'secretReference']
  const allowed = [...required, 'leaseManager', 'resolver', 'now']
  if (
    Object.keys(record).length < required.length ||
    Object.keys(record).length > allowed.length ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    (record.leaseManager !== undefined &&
      !(record.leaseManager instanceof FeishuRuntimeLeaseManager)) ||
    (record.resolver !== undefined &&
      !(record.resolver instanceof FeishuSystemKeychainSecretResolver)) ||
    (record.now !== undefined && typeof record.now !== 'function')
  ) {
    throw invalid()
  }
  try {
    const secretReference = parseSecretReference(record.secretReference)
    if (
      secretReference.store !== 'system_keychain' ||
      secretReference.purpose !== 'connector_api_key'
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      identityStore: record.identityStore,
      database: databaseAt(record.database),
      tenantKey: tenantKeyAt(record.tenantKey),
      receiptStorePath: pathAt(record.receiptStorePath),
      secretReference,
      leaseManager: record.leaseManager ?? new FeishuRuntimeLeaseManager(),
      resolver: record.resolver ?? new FeishuSystemKeychainSecretResolver(),
      now: (record.now ?? Date.now) as () => number,
    })
  } catch {
    throw invalid()
  }
}

function simple(
  disposition: Exclude<WorkbenchFeishuBotEventIngressResult['disposition'], 'challenge'>,
): WorkbenchFeishuBotEventIngressResult {
  return Object.freeze({ version: WORKBENCH_FEISHU_BOT_EVENT_INGRESS_VERSION, disposition })
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, 'name')?.value === 'AbortError'
    )
  } catch {
    return false
  }
}

function unavailable(error: unknown): WorkbenchFeishuBotEventIngressResult {
  if (error instanceof FeishuBotEventError) {
    if (
      error.code === 'invalid_request' ||
      error.code === 'invalid_signature' ||
      error.code === 'stale_request' ||
      error.code === 'invalid_event' ||
      error.code === 'identity_mismatch' ||
      error.code === 'receipt_conflict'
    ) {
      return simple('rejected')
    }
  }
  return simple('unavailable')
}

/**
 * Resolve one Keychain event-subscription bundle per callback, verify it under
 * the shared Host lease, and commit the normalized Inbox projection before ack.
 */
export function createWorkbenchFeishuBotEventIngress(
  optionsValue: WorkbenchFeishuBotEventIngressOptions,
): WorkbenchFeishuBotEventIngress {
  const options = readOptions(optionsValue)
  const receiptStore = new FeishuBotEventReceiptStore(options.receiptStorePath)
  return Object.freeze({
    async consume(request: unknown, signal: AbortSignal) {
      if (!(signal instanceof AbortSignal)) return simple('rejected')
      try {
        signal.throwIfAborted()
        const configuration = await options.identityStore.read()
        signal.throwIfAborted()
        if (configuration?.bot === undefined) return simple('unavailable')
        return await options.leaseManager.withLease(configuration, signal, async (lease) => {
          lease.assertHeld()
          return options.resolver.withSecret(options.secretReference, signal, async (secretBytes) =>
            withFeishuBotEventSubscriptionSecrets(configuration, secretBytes, async (secrets) => {
              signal.throwIfAborted()
              lease.assertHeld()
              const consumer = new FeishuBotEventConsumer(
                configuration,
                secrets.encryptionKey,
                receiptStore,
                {
                  tenantKey: options.tenantKey,
                  verificationToken: secrets.verificationToken,
                  now: options.now,
                },
              )
              const result = await consumer.consume(request, async (event) => {
                signal.throwIfAborted()
                lease.assertHeld()
                const now = options.now()
                if (!Number.isSafeInteger(now) || now < 0) throw new TypeError()
                const normalized = new FeishuMessageNormalizer(
                  configuration,
                  options.tenantKey,
                ).normalizeBotMessage(event, new Date(now).toISOString(), options.database)
                signal.throwIfAborted()
                lease.assertHeld()
                options.database.commitConnectorSyncBatch({
                  connectorId: normalized.connectorId,
                  accountId: normalized.accountId,
                  stream: normalized.stream,
                  events: normalized.events,
                  projections: normalized.projections,
                })
              })
              if (result.status === 'challenge') {
                return Object.freeze({
                  version: WORKBENCH_FEISHU_BOT_EVENT_INGRESS_VERSION,
                  disposition: 'challenge' as const,
                  challenge: result.challenge,
                })
              }
              return simple(result.status)
            }),
          )
        })
      } catch (error) {
        if (isAbort(error, signal)) throw error
        return unavailable(error)
      }
    },
  })
}
