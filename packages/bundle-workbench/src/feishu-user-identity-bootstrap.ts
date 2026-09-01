import { randomUUID } from 'node:crypto'

import { FeishuIdentityConfigurationStore } from '@twindesk/plugin-feishu'

export interface WorkbenchFeishuUserIdentityCreate {
  readonly version: 1
  readonly connection: 'new' | 'existing'
  readonly appId: string | null
  readonly displayName: string
  readonly principalId: string
}

export interface WorkbenchFeishuUserIdentityBootstrapper {
  create(value: unknown): Promise<void>
}

export interface WorkbenchFeishuUserIdentityBootstrapperOptions {
  readonly identityStore: FeishuIdentityConfigurationStore
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu User identity creation is invalid.')
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

function text(value: unknown, pattern: RegExp, maximumLength = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw invalid()
  }
  return value
}

function readOptions(value: unknown): WorkbenchFeishuUserIdentityBootstrapperOptions {
  const record = dataRecord(value, ['identityStore'])
  if (
    Object.keys(record).length !== 1 ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore)
  ) {
    throw invalid()
  }
  return Object.freeze({ identityStore: record.identityStore })
}

function createData(value: unknown): WorkbenchFeishuUserIdentityCreate {
  const record = dataRecord(value, ['version', 'connection', 'appId', 'displayName', 'principalId'])
  if (
    Object.keys(record).length !== 5 ||
    record.version !== 1 ||
    (record.connection !== 'new' && record.connection !== 'existing') ||
    (record.connection === 'new' && typeof record.appId !== 'string') ||
    (record.connection === 'existing' && record.appId !== null)
  ) {
    throw invalid()
  }
  return Object.freeze({
    version: 1,
    connection: record.connection,
    appId: record.connection === 'new' ? text(record.appId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u) : null,
    displayName: text(record.displayName, /^[^\u0000-\u001f\u007f]+$/u),
    principalId: text(record.principalId, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  })
}

function opaqueSuffix(): string {
  return randomUUID()
}

/** Create one User identity and opaque Keychain reference without accepting a credential. */
export function createWorkbenchFeishuUserIdentityBootstrapper(
  optionsValue: WorkbenchFeishuUserIdentityBootstrapperOptions,
): WorkbenchFeishuUserIdentityBootstrapper {
  const options = readOptions(optionsValue)
  let pendingCreate: Promise<void> = Promise.resolve()
  return Object.freeze({
    async create(value: unknown): Promise<void> {
      const create = createData(value)
      const operation = pendingCreate.then(async () => {
        const existing = await options.identityStore.read()
        if (existing?.user !== undefined) throw invalid()
        if (
          (existing === undefined && create.connection !== 'new') ||
          (existing !== undefined && create.connection !== 'existing')
        ) {
          throw invalid()
        }
        const appId = existing?.appId ?? create.appId
        if (appId === null) throw invalid()
        await options.identityStore.write({
          kind: 'feishu_identity_configuration',
          schemaVersion: 1,
          connectorId: 'feishu',
          accountId: existing?.accountId ?? `feishu-account:${opaqueSuffix()}`,
          appId,
          ...(existing?.bot === undefined ? {} : { bot: existing.bot }),
          user: {
            identityType: 'user',
            displayName: create.displayName,
            principalId: create.principalId,
            credentialReference: {
              kind: 'secret_reference',
              schemaVersion: 1,
              id: `secret-ref:feishu-user-oauth-${opaqueSuffix()}`,
              store: 'system_keychain',
              purpose: 'connector_oauth',
            },
          },
        })
      })
      pendingCreate = operation.then(
        () => undefined,
        () => undefined,
      )
      await operation
    },
  })
}
