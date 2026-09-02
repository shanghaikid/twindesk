import { isAbsolute, resolve } from 'node:path'

import {
  createHarnessModelDraftRunner,
  inspectHarnessModelDraftRoute,
} from '@twindesk/harness-adapter'

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

function configAt(value: unknown): WorkbenchCordisRuntimeConfig {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['version', 'homeDirectory', 'databasePath', 'port', 'provider', 'model']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.version?.value !== 1 ||
      !Number.isSafeInteger(descriptors.port?.value) ||
      (descriptors.port?.value as number) < 0 ||
      (descriptors.port?.value as number) > 65_535
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
    const running = await startWorkbenchWebServer({
      homeDirectory: config.homeDirectory,
      databasePath: config.databasePath,
      port: config.port,
      modelDraftRuntime: {
        runner: createHarnessModelDraftRunner(contextValue),
        provider: route.provider,
        model: route.model,
      },
    })
    logger.info(`TwinDesk product web: ${running.url}`)
    console.log(`TwinDesk product web: ${running.url}`)
    return () => running.close()
  }, 'twindesk-workbench-runtime.product-web()')
}
