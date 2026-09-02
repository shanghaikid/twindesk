import {
  startTwinDeskWebServer,
  type RunningTwinDeskWebServer,
  type TwinDeskWebServerOptions,
} from '@twindesk/web'
import { openTwinDeskDatabase } from '@twindesk/storage-sqlite'

import {
  openWorkbenchFeishuSettingsStores,
  type WorkbenchLocalDataPathOptions,
} from './local-data-paths.ts'
import { createWorkbenchFeishuOAuthSettingsEditor } from './feishu-oauth-settings-editor.ts'
import { createDefaultWorkbenchFeishuOAuthAuthorizationController } from './feishu-oauth-authorization-controller.ts'
import { createWorkbenchFeishuOAuthRecoveryPresentation } from './feishu-oauth-recovery-presentation.ts'
import { createWorkbenchFeishuOAuthReconciliationService } from './feishu-oauth-reconciliation-runtime.ts'
import { createDefaultWorkbenchFeishuOAuthReauthorizationController } from './feishu-oauth-reauthorization-controller.ts'
import { createWorkbenchFeishuSettingsPresentation } from './feishu-settings-presentation.ts'
import { createWorkbenchFeishuUserIdentityBootstrapper } from './feishu-user-identity-bootstrap.ts'
import { createWorkbenchFeishuReplyProposalController } from './feishu-reply-proposal-controller.ts'
import { createWorkbenchFeishuReplyApprovalController } from './feishu-reply-approval-controller.ts'
import { createDefaultWorkbenchFeishuReplyExecutionController } from './feishu-reply-execution-controller.ts'
import { createWorkbenchFeishuReplyFlowController } from './feishu-reply-flow-controller.ts'
import {
  createWorkbenchModelDraftController,
  type WorkbenchModelDraftControllerOptions,
} from './model-draft-controller.ts'

export interface WorkbenchWebServerOptions extends WorkbenchLocalDataPathOptions {
  readonly host?: TwinDeskWebServerOptions['host']
  readonly port?: number
  readonly databasePath?: string
  /** Host-owned Harness route. Credentials remain in the configured provider. */
  readonly modelDraftRuntime?: Omit<WorkbenchModelDraftControllerOptions, 'database'>
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Web server options are invalid.')
}

function modelDraftRuntimeAt(
  value: unknown,
): Omit<WorkbenchModelDraftControllerOptions, 'database'> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = ['runner', 'provider', 'model']
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    throw new TypeError()
  }
  return Object.freeze({
    runner: descriptors.runner?.value as WorkbenchModelDraftControllerOptions['runner'],
    provider: descriptors.provider?.value as string,
    model: descriptors.model?.value as string,
  })
}

function readOptions(value: unknown): WorkbenchWebServerOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = [
      'platform',
      'homeDirectory',
      'host',
      'port',
      'databasePath',
      'modelDraftRuntime',
    ]
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
    return Object.freeze({
      ...record,
      ...(record.modelDraftRuntime === undefined
        ? {}
        : { modelDraftRuntime: modelDraftRuntimeAt(record.modelDraftRuntime) }),
    }) as WorkbenchWebServerOptions
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
  const maintenanceDatabase = openTwinDeskDatabase(options.databasePath ?? ':memory:')
  try {
    const feishuOAuthReconciliation = createWorkbenchFeishuOAuthReconciliationService({
      identityStore: stores.identityStore,
      journal: stores.rotationJournal,
      database: maintenanceDatabase,
    })
    const feishuReauthorization = createDefaultWorkbenchFeishuOAuthReauthorizationController({
      identityStore: stores.identityStore,
      authorizationStore: stores.authorizationStore,
      journal: stores.rotationJournal,
    })
    const modelDraft =
      options.modelDraftRuntime === undefined
        ? undefined
        : createWorkbenchModelDraftController({
            database: maintenanceDatabase,
            runner: options.modelDraftRuntime.runner,
            provider: options.modelDraftRuntime.provider,
            model: options.modelDraftRuntime.model,
          })
    const feishuReplyProposal = createWorkbenchFeishuReplyProposalController({
      database: maintenanceDatabase,
      identityStore: stores.identityStore,
    })
    const feishuReplyApproval = createWorkbenchFeishuReplyApprovalController({
      database: maintenanceDatabase,
      proposalController: feishuReplyProposal,
    })
    const feishuReplyExecution = createDefaultWorkbenchFeishuReplyExecutionController({
      database: maintenanceDatabase,
      identityStore: stores.identityStore,
      proposalController: feishuReplyProposal,
      rotationJournal: stores.rotationJournal,
    })
    const feishuReplyFlow = createWorkbenchFeishuReplyFlowController({
      database: maintenanceDatabase,
    })
    await feishuOAuthReconciliation.recoverPending(new AbortController().signal)
    let pendingSettingsUpdate: Promise<void> = Promise.resolve()
    const running = await startTwinDeskWebServer({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      database: maintenanceDatabase,
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
      feishuOAuthReconciliation: {
        reconcile: feishuOAuthReconciliation.reconcile,
      },
      feishuReauthorization: {
        read: feishuReauthorization.read,
        start: feishuReauthorization.start,
        cancel: feishuReauthorization.cancel,
      },
      ...(modelDraft === undefined ? {} : { modelDraft }),
      feishuReplyProposal: {
        read: feishuReplyProposal.read,
        create: feishuReplyProposal.create,
      },
      feishuReplyApproval,
      feishuReplyExecution,
      feishuReplyFlow,
    })
    let closing: Promise<void> | undefined
    return Object.freeze({
      host: running.host,
      port: running.port,
      url: running.url,
      close() {
        closing ??= running.close().finally(() => maintenanceDatabase.close())
        return closing
      },
    })
  } catch (error) {
    maintenanceDatabase.close()
    throw error
  }
}
