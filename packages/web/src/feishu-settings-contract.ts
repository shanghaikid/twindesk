export type FeishuSettingsState = 'not_configured' | 'incomplete' | 'ready'
export type FeishuConfiguredIdentity = 'bot' | 'user'

export interface FeishuOAuthSettingsView {
  readonly redirectHost: '127.0.0.1' | '::1'
  readonly redirectPort: number
  readonly scopes: readonly string[]
  readonly appMatchesIdentity: boolean
}

export interface FeishuSettingsSnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly state: FeishuSettingsState
  readonly identities: readonly FeishuConfiguredIdentity[]
  readonly oauth: FeishuOAuthSettingsView | null
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu Settings response.')
}

function recordAt(value: unknown, keys: readonly string[]): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      actual.length !== keys.length ||
      actual.some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      return invalid()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    return invalid()
  }
}

function arrayAt(value: unknown, maximumLength: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || value.length > maximumLength) return invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== value.length + 1 ||
      !Object.hasOwn(descriptors, 'length')
    ) {
      return invalid()
    }
    return Object.freeze(
      Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return invalid()
        return descriptor.value
      }),
    )
  } catch {
    return invalid()
  }
}

function identitiesAt(value: unknown): readonly FeishuConfiguredIdentity[] {
  const identities = arrayAt(value, 2).map((identity) => {
    if (identity !== 'bot' && identity !== 'user') return invalid()
    return identity
  })
  if (
    new Set(identities).size !== identities.length ||
    identities.join(' ') !== [...identities].sort().join(' ')
  ) {
    return invalid()
  }
  return Object.freeze(identities)
}

function oauthAt(value: unknown): FeishuOAuthSettingsView | null {
  if (value === null) return null
  const oauth = recordAt(value, ['redirectHost', 'redirectPort', 'scopes', 'appMatchesIdentity'])
  if (
    (oauth.redirectHost !== '127.0.0.1' && oauth.redirectHost !== '::1') ||
    !Number.isSafeInteger(oauth.redirectPort) ||
    (oauth.redirectPort as number) <= 0 ||
    (oauth.redirectPort as number) > 65_535 ||
    typeof oauth.appMatchesIdentity !== 'boolean' ||
    !Array.isArray(oauth.scopes)
  ) {
    return invalid()
  }
  const scopeValues = arrayAt(oauth.scopes, 128)
  if (scopeValues.length === 0) return invalid()
  const scopes = scopeValues.map((scope) => {
    if (
      typeof scope !== 'string' ||
      scope.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)
    ) {
      return invalid()
    }
    return scope
  })
  if (
    new Set(scopes).size !== scopes.length ||
    scopes.join(' ') !== [...scopes].sort().join(' ') ||
    !scopes.includes('offline_access')
  ) {
    return invalid()
  }
  return Object.freeze({
    redirectHost: oauth.redirectHost,
    redirectPort: oauth.redirectPort as number,
    scopes: Object.freeze(scopes),
    appMatchesIdentity: oauth.appMatchesIdentity,
  }) as FeishuOAuthSettingsView
}

/** Parse the versioned, identity-minimized Feishu Settings response before rendering. */
export function parseFeishuSettingsSnapshot(value: unknown): FeishuSettingsSnapshot {
  const snapshot = recordAt(value, ['version', 'connectorId', 'state', 'identities', 'oauth'])
  if (
    snapshot.version !== 1 ||
    snapshot.connectorId !== 'feishu' ||
    (snapshot.state !== 'not_configured' &&
      snapshot.state !== 'incomplete' &&
      snapshot.state !== 'ready')
  ) {
    return invalid()
  }
  const identities = identitiesAt(snapshot.identities)
  const oauth = oauthAt(snapshot.oauth)
  const expectedState: FeishuSettingsState =
    identities.length === 0 && oauth === null
      ? 'not_configured'
      : identities.includes('user') && oauth?.appMatchesIdentity === true
        ? 'ready'
        : 'incomplete'
  if (snapshot.state !== expectedState) return invalid()
  return Object.freeze({
    version: 1,
    connectorId: 'feishu',
    state: snapshot.state,
    identities,
    oauth,
  })
}
