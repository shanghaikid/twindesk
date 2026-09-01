import { URL } from 'node:url'

import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
} from '@twindesk/plugin-feishu'

export type WorkbenchFeishuSettingsState = 'not_configured' | 'incomplete' | 'ready'
export type WorkbenchFeishuConfiguredIdentity = 'bot' | 'user'

export interface WorkbenchFeishuOAuthSettingsView {
  readonly redirectHost: '127.0.0.1' | '::1'
  readonly redirectPort: number
  readonly scopes: readonly string[]
  readonly appMatchesIdentity: boolean
}

export interface WorkbenchFeishuSettingsSnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly state: WorkbenchFeishuSettingsState
  readonly identities: readonly WorkbenchFeishuConfiguredIdentity[]
  readonly oauth: WorkbenchFeishuOAuthSettingsView | null
}

export interface WorkbenchFeishuSettingsPresentation {
  read(): Promise<WorkbenchFeishuSettingsSnapshot>
}

export interface WorkbenchFeishuSettingsPresentationOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu Settings presentation is invalid.')
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some(
        (key) => !['identityStore', 'authorizationStore'].includes(key),
      ) ||
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

function readOptions(value: unknown): WorkbenchFeishuSettingsPresentationOptions {
  const record = dataRecord(value)
  if (
    Object.keys(record).length !== 2 ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.authorizationStore instanceof FeishuOAuthAuthorizationConfigurationStore)
  ) {
    throw invalid()
  }
  return Object.freeze({
    identityStore: record.identityStore,
    authorizationStore: record.authorizationStore,
  })
}

/** Project persisted non-secret Feishu Settings without exposing local or external identities. */
export function createWorkbenchFeishuSettingsPresentation(
  optionsValue: WorkbenchFeishuSettingsPresentationOptions,
): WorkbenchFeishuSettingsPresentation {
  const options = readOptions(optionsValue)
  async function read(): Promise<WorkbenchFeishuSettingsSnapshot> {
    const [identity, authorization] = await Promise.all([
      options.identityStore.read(),
      options.authorizationStore.read(),
    ])
    const identities = Object.freeze(
      identity === undefined
        ? []
        : [
            ...(identity.bot === undefined ? [] : (['bot'] as const)),
            ...(identity.user === undefined ? [] : (['user'] as const)),
          ],
    )
    let oauth: WorkbenchFeishuOAuthSettingsView | null = null
    if (authorization !== undefined) {
      const redirect = new URL(authorization.redirectUri)
      let redirectHost: '127.0.0.1' | '::1'
      if (redirect.hostname === '127.0.0.1') redirectHost = '127.0.0.1'
      else if (redirect.hostname === '[::1]') redirectHost = '::1'
      else throw invalid()
      oauth = Object.freeze({
        redirectHost,
        redirectPort: Number(redirect.port),
        scopes: Object.freeze([...authorization.scopes]),
        appMatchesIdentity: identity !== undefined && identity.appId === authorization.appId,
      })
    }
    const state: WorkbenchFeishuSettingsState =
      identity === undefined && authorization === undefined
        ? 'not_configured'
        : identity?.user !== undefined && oauth?.appMatchesIdentity === true
          ? 'ready'
          : 'incomplete'
    return Object.freeze({ version: 1, connectorId: 'feishu', state, identities, oauth })
  }

  return Object.freeze({ read })
}
