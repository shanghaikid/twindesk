import { isAbsolute, resolve } from 'node:path'

import {
  createHarnessModelDraftRunner,
  inspectHarnessModelDraftRoute,
} from '@twindesk/harness-adapter'
import { parseSecretReference } from '@twindesk/domain'

import { createWorkbenchFeishuRuntimeSupervisor } from './feishu-runtime-supervisor.ts'
import { openWorkbenchFeishuSettingsStores } from './local-data-paths.ts'
import { startWorkbenchWebServer } from './web-runtime.ts'

/** Stable Host plugin name for the product-owned runtime composition. */
export const name = 'twindesk-workbench-runtime'

/** Services required by the pinned Harness model-Draft adapter. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'llm']

export interface WorkbenchCordisRuntimeConfig {
  readonly version: 1
  readonly homeDirectory: string
  readonly databasePath: string
  readonly port: number
  readonly provider: string
  readonly model: string
  /** Host-only tenant identity. Omit to keep User polling disabled. */
  readonly feishuTenantKey?: string
  /** Host-only Keychain reference id for the Bot event-subscription secret bundle. */
  readonly feishuBotEventSecretReferenceId?: string
}

interface WorkbenchCordisRuntimeContext {
  effect(effect: () => Promise<() => Promise<void>>, label: string): unknown
  logger(name: string): { info(message: string): void }
}

function invalid(): TypeError {
  return new TypeError('The Workbench Cordis runtime configuration is invalid.')
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

function routeAt(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
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

function secretReferenceIdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^secret-ref:[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function configAt(value: unknown): WorkbenchCordisRuntimeConfig {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const required = ['version', 'homeDirectory', 'databasePath', 'port', 'provider', 'model']
    const allowed = [...required, 'feishuTenantKey', 'feishuBotEventSecretReferenceId']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.version?.value !== 1 ||
      !Number.isSafeInteger(descriptors.port?.value) ||
      (descriptors.port?.value as number) < 0 ||
      (descriptors.port?.value as number) > 65_535 ||
      (descriptors.feishuBotEventSecretReferenceId?.value !== undefined &&
        descriptors.feishuTenantKey?.value === undefined)
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      version: 1,
      homeDirectory: pathAt(descriptors.homeDirectory?.value),
      databasePath: pathAt(descriptors.databasePath?.value),
      port: descriptors.port?.value as number,
      provider: routeAt(descriptors.provider?.value, 120),
      model: routeAt(descriptors.model?.value, 160),
      ...(Object.hasOwn(descriptors, 'feishuTenantKey') &&
      descriptors.feishuTenantKey?.value !== undefined
        ? { feishuTenantKey: tenantKeyAt(descriptors.feishuTenantKey?.value) }
        : {}),
      ...(Object.hasOwn(descriptors, 'feishuBotEventSecretReferenceId') &&
      descriptors.feishuBotEventSecretReferenceId?.value !== undefined
        ? {
            feishuBotEventSecretReferenceId: secretReferenceIdAt(
              descriptors.feishuBotEventSecretReferenceId.value,
            ),
          }
        : {}),
    })
  } catch {
    throw invalid()
  }
}

function contextAt(value: unknown): WorkbenchCordisRuntimeContext {
  try {
    if (typeof value !== 'object' || value === null) throw new TypeError()
    const context = value as WorkbenchCordisRuntimeContext
    if (typeof context.effect !== 'function' || typeof context.logger !== 'function') {
      throw new TypeError()
    }
    return context
  } catch {
    throw new TypeError('The Workbench Cordis runtime context is invalid.')
  }
}

/**
 * Own the product Web server under the Cordis plugin lifecycle. The browser
 * receives only the existing Work Item intent; route and credentials remain
 * inside the Harness Host and its provider adapters.
 */
export function apply(contextValue: unknown, configValue: unknown): void {
  const context = contextAt(contextValue)
  const config = configAt(configValue)
  const logger = context.logger(name)
  if (typeof logger?.info !== 'function') {
    throw new TypeError('The Workbench Cordis runtime context is invalid.')
  }
  context.effect(async () => {
    const route = await inspectHarnessModelDraftRoute(contextValue, {
      provider: config.provider,
      model: config.model,
    })
    const webOptions = {
      homeDirectory: config.homeDirectory,
      databasePath: config.databasePath,
      port: config.port,
      modelDraftRuntime: {
        runner: createHarnessModelDraftRunner(contextValue),
        provider: route.provider,
        model: route.model,
      },
    }
    if (config.feishuTenantKey === undefined) {
      const running = await startWorkbenchWebServer(webOptions)
      logger.info(`TwinDesk product web: ${running.url}`)
      console.log(`TwinDesk product web: ${running.url}`)
      return () => running.close()
    }

    const stores = await openWorkbenchFeishuSettingsStores({
      homeDirectory: config.homeDirectory,
    })
    const supervisor = createWorkbenchFeishuRuntimeSupervisor({
      identityStore: stores.identityStore,
      rotationJournal: stores.rotationJournal,
      databasePath: config.databasePath,
      tenantKey: config.feishuTenantKey,
      onAttentionRequired() {
        logger.info('TwinDesk Feishu User polling stopped; Connector attention is required.')
      },
    })
    let running: Awaited<ReturnType<typeof startWorkbenchWebServer>>
    try {
      await supervisor.refresh()
      running = await startWorkbenchWebServer({
        ...webOptions,
        feishuLeaseManager: supervisor.leaseManager,
        feishuRuntimeStatus: () => supervisor.readStatus(),
        onFeishuRuntimeChanged: () => supervisor.requestRefresh(),
        ...(config.feishuBotEventSecretReferenceId === undefined
          ? {}
          : {
              feishuBotEvent: {
                tenantKey: config.feishuTenantKey,
                secretReference: parseSecretReference({
                  kind: 'secret_reference' as const,
                  schemaVersion: 1 as const,
                  id: config.feishuBotEventSecretReferenceId,
                  store: 'system_keychain' as const,
                  purpose: 'connector_api_key' as const,
                }),
              },
            }),
      })
    } catch (error) {
      await supervisor.close()
      throw error
    }
    logger.info(`TwinDesk product web: ${running.url}`)
    console.log(`TwinDesk product web: ${running.url}`)
    let closing: Promise<void> | undefined
    return () => {
      closing ??= (async () => {
        await supervisor.quiesce()
        try {
          await running.close()
        } finally {
          await supervisor.close()
        }
      })()
      return closing
    }
  }, 'twindesk-workbench-runtime.product-web()')
}
