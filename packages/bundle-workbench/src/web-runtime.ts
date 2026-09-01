import {
  startTwinDeskWebServer,
  type RunningTwinDeskWebServer,
  type TwinDeskWebServerOptions,
} from '@twindesk/web'

import {
  openWorkbenchFeishuSettingsStores,
  type WorkbenchLocalDataPathOptions,
} from './local-data-paths.ts'
import { createWorkbenchFeishuOAuthSettingsEditor } from './feishu-oauth-settings-editor.ts'
import { createDefaultWorkbenchFeishuOAuthAuthorizationController } from './feishu-oauth-authorization-controller.ts'
import { createWorkbenchFeishuOAuthRecoveryPresentation } from './feishu-oauth-recovery-presentation.ts'
import { createDefaultWorkbenchFeishuOAuthReauthorizationController } from './feishu-oauth-reauthorization-controller.ts'
import { createWorkbenchFeishuSettingsPresentation } from './feishu-settings-presentation.ts'
import { createWorkbenchFeishuUserIdentityBootstrapper } from './feishu-user-identity-bootstrap.ts'

export interface WorkbenchWebServerOptions extends WorkbenchLocalDataPathOptions {
  readonly host?: TwinDeskWebServerOptions['host']
  readonly port?: number
  readonly databasePath?: string
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Web server options are invalid.')
}

function readOptions(value: unknown): WorkbenchWebServerOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = ['platform', 'homeDirectory', 'host', 'port', 'databasePath']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const record = Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    ) as UnknownRecord
    if (
      (record.host !== undefined && record.host !== '127.0.0.1' && record.host !== '::1') ||
      (record.port !== undefined &&
        (!Number.isSafeInteger(record.port) ||
          (record.port as number) < 0 ||
          (record.port as number) > 65_535)) ||
      (record.databasePath !== undefined &&
        (typeof record.databasePath !== 'string' ||
          record.databasePath.length === 0 ||
          record.databasePath.includes('\u0000')))
    ) {
      throw new TypeError()
    }
    return Object.freeze(record) as WorkbenchWebServerOptions
  } catch {
    throw invalid()
  }
}

/** Start the product Web shell with the default restart-safe Feishu Settings reader. */
export async function startWorkbenchWebServer(
  optionsValue: WorkbenchWebServerOptions = {},
): Promise<RunningTwinDeskWebServer> {
  const options = readOptions(optionsValue)
  const stores = await openWorkbenchFeishuSettingsStores({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  })
  const feishuSettings = createWorkbenchFeishuSettingsPresentation({
    identityStore: stores.identityStore,
    authorizationStore: stores.authorizationStore,
  })
  const feishuOAuthSettingsEditor = createWorkbenchFeishuOAuthSettingsEditor({
    identityStore: stores.identityStore,
    authorizationStore: stores.authorizationStore,
  })
  const feishuUserIdentityBootstrapper = createWorkbenchFeishuUserIdentityBootstrapper({
    identityStore: stores.identityStore,
  })
  const feishuAuthorization = createDefaultWorkbenchFeishuOAuthAuthorizationController({
    identityStore: stores.identityStore,
    authorizationStore: stores.authorizationStore,
  })
  const feishuOAuthRecovery = createWorkbenchFeishuOAuthRecoveryPresentation({
    rotationJournal: stores.rotationJournal,
  })
  const feishuReauthorization = createDefaultWorkbenchFeishuOAuthReauthorizationController({
    identityStore: stores.identityStore,
    authorizationStore: stores.authorizationStore,
    journal: stores.rotationJournal,
  })
  let pendingSettingsUpdate: Promise<void> = Promise.resolve()
  return startTwinDeskWebServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    feishuSettings: {
      read: feishuSettings.read,
      async updateOAuth(value: unknown) {
        const operation = pendingSettingsUpdate.then(async () => {
          await feishuOAuthSettingsEditor.update(value)
          return feishuSettings.read()
        })
        pendingSettingsUpdate = operation.then(
          () => undefined,
          () => undefined,
        )
        return operation
      },
      async createUserIdentity(value: unknown) {
        const operation = pendingSettingsUpdate.then(async () => {
          await feishuUserIdentityBootstrapper.create(value)
          return feishuSettings.read()
        })
        pendingSettingsUpdate = operation.then(
          () => undefined,
          () => undefined,
        )
        return operation
      },
    },
    feishuAuthorization: {
      read: feishuAuthorization.read,
      start: feishuAuthorization.start,
      cancel: feishuAuthorization.cancel,
    },
    feishuOAuthRecovery: { read: feishuOAuthRecovery.read },
    feishuReauthorization: {
      read: feishuReauthorization.read,
      start: feishuReauthorization.start,
      cancel: feishuReauthorization.cancel,
    },
  })
}
