export const FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION = 1 as const

export interface FeishuOAuthAuthorizationConfiguration {
  readonly kind: 'feishu_oauth_authorization_configuration'
  readonly schemaVersion: typeof FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION
  readonly connectorId: 'feishu'
  readonly appId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): TypeError {
  return new TypeError('The Feishu OAuth authorization configuration is invalid.')
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

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const keys = Object.keys(record)
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw invalid()
  }
}

function appId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  ) {
    throw invalid()
  }
  return value
}

function redirectUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw invalid()
  const match =
    /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/[A-Za-z0-9/_-]{1,255})$/u.exec(value)
  if (match === null) throw invalid()
  const port = Number(match[2])
  if (port > 65_535 || port === 80) throw invalid()
  try {
    if (new URL(value).toString() !== value) throw new TypeError()
  } catch {
    throw invalid()
  }
  return value
}

function scopes(value: unknown): readonly string[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== value.length + 1
    ) {
      throw new TypeError()
    }
    const parsed = Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError()
      const scope = descriptor.value
      if (
        typeof scope !== 'string' ||
        scope.length === 0 ||
        scope.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)
      ) {
        throw new TypeError()
      }
      return scope
    })
    if (new Set(parsed).size !== parsed.length || !parsed.includes('offline_access')) {
      throw new TypeError()
    }
    return Object.freeze([...parsed].sort())
  } catch {
    throw invalid()
  }
}

/** Validate the non-secret OAuth settings registered for one Feishu app. */
export function parseFeishuOAuthAuthorizationConfiguration(
  value: unknown,
): FeishuOAuthAuthorizationConfiguration {
  const record = dataRecord(value)
  exactKeys(record, ['kind', 'schemaVersion', 'connectorId', 'appId', 'redirectUri', 'scopes'])
  if (
    record.kind !== 'feishu_oauth_authorization_configuration' ||
    record.schemaVersion !== FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION ||
    record.connectorId !== 'feishu'
  ) {
    throw invalid()
  }
  return Object.freeze({
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION,
    connectorId: 'feishu',
    appId: appId(record.appId),
    redirectUri: redirectUri(record.redirectUri),
    scopes: scopes(record.scopes),
  })
}
