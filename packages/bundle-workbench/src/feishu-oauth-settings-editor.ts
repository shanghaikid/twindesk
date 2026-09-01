import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
} from '@twindesk/plugin-feishu'

export interface WorkbenchFeishuOAuthSettingsUpdate {
  readonly version: 1
  readonly redirectHost: '127.0.0.1' | '::1'
  readonly redirectPort: number
  readonly scopes: readonly string[]
}

export interface WorkbenchFeishuOAuthSettingsEditor {
  update(value: unknown): Promise<void>
}

export interface WorkbenchFeishuOAuthSettingsEditorOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu OAuth Settings update is invalid.')
}

function dataRecord(value: unknown, allowed: readonly string[]): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
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

function readOptions(value: unknown): WorkbenchFeishuOAuthSettingsEditorOptions {
  const record = dataRecord(value, ['identityStore', 'authorizationStore'])
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

function updateData(value: unknown): WorkbenchFeishuOAuthSettingsUpdate {
  const record = dataRecord(value, ['version', 'redirectHost', 'redirectPort', 'scopes'])
  if (
    Object.keys(record).length !== 4 ||
    record.version !== 1 ||
    (record.redirectHost !== '127.0.0.1' && record.redirectHost !== '::1') ||
    !Number.isSafeInteger(record.redirectPort) ||
    (record.redirectPort as number) <= 0 ||
    (record.redirectPort as number) > 65_535 ||
    record.redirectPort === 80 ||
    !Array.isArray(record.scopes)
  ) {
    throw invalid()
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.scopes)
  if (
    Object.getPrototypeOf(record.scopes) !== Array.prototype ||
    Object.getOwnPropertySymbols(record.scopes).length !== 0 ||
    Object.keys(descriptors).length !== record.scopes.length + 1 ||
    record.scopes.length === 0 ||
    record.scopes.length > 128
  ) {
    throw invalid()
  }
  const scopes = Array.from({ length: record.scopes.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    const scope = descriptor?.value
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof scope !== 'string' ||
      scope.length === 0 ||
      scope.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)
    ) {
      throw invalid()
    }
    return scope
  })
  if (
    new Set(scopes).size !== scopes.length ||
    !scopes.includes('offline_access') ||
    scopes.join(' ') !== [...scopes].sort().join(' ')
  ) {
    throw invalid()
  }
  return Object.freeze({
    version: 1,
    redirectHost: record.redirectHost,
    redirectPort: record.redirectPort as number,
    scopes: Object.freeze(scopes),
  })
}

/** Persist only app-bound, non-secret OAuth Settings for an existing User identity. */
export function createWorkbenchFeishuOAuthSettingsEditor(
  optionsValue: WorkbenchFeishuOAuthSettingsEditorOptions,
): WorkbenchFeishuOAuthSettingsEditor {
  const options = readOptions(optionsValue)
  let pendingUpdate: Promise<void> = Promise.resolve()
  return Object.freeze({
    async update(value: unknown): Promise<void> {
      const update = updateData(value)
      const operation = pendingUpdate.then(async () => {
        const identity = await options.identityStore.read()
        if (identity?.user === undefined) throw invalid()
        const host = update.redirectHost === '::1' ? '[::1]' : update.redirectHost
        await options.authorizationStore.write({
          kind: 'feishu_oauth_authorization_configuration',
          schemaVersion: 1,
          connectorId: 'feishu',
          appId: identity.appId,
          redirectUri: `http://${host}:${update.redirectPort}/oauth/feishu/callback`,
          scopes: update.scopes,
        })
      })
      pendingUpdate = operation.then(
        () => undefined,
        () => undefined,
      )
      await operation
    },
  })
}
