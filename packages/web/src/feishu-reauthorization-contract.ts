export type FeishuReauthorizationRecovery =
  | 'configure_settings'
  | 'correct_configuration'
  | 'reauthorize'
  | 'reconcile_keychain'
  | 'reconcile_rotation'
  | 'retry_after_owner_exit'
  | 'do_not_retry'

export type FeishuReauthorizationSnapshot =
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'idle' | 'starting' | 'succeeded' | 'cancelled'
    }>
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'waiting'
      authorizationUrl: string
      redirectUri: string
    }>
  | Readonly<{
      version: 1
      connectorId: 'feishu'
      state: 'failed'
      recovery: FeishuReauthorizationRecovery
    }>

type UnknownRecord = Readonly<Record<string, unknown>>
const RECOVERIES: readonly FeishuReauthorizationRecovery[] = Object.freeze([
  'configure_settings',
  'correct_configuration',
  'reauthorize',
  'reconcile_keychain',
  'reconcile_rotation',
  'retry_after_owner_exit',
  'do_not_retry',
])
const FEISHU_AUTHORIZATION_ORIGIN = 'https://accounts.feishu.cn'
const FEISHU_AUTHORIZATION_PATH = '/open-apis/authen/v1/authorize'

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu reauthorization response.')
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

function urls(record: UnknownRecord): Readonly<{ authorizationUrl: string; redirectUri: string }> {
  if (
    typeof record.authorizationUrl !== 'string' ||
    record.authorizationUrl.length === 0 ||
    record.authorizationUrl.length > 8192 ||
    typeof record.redirectUri !== 'string' ||
    record.redirectUri.length === 0 ||
    record.redirectUri.length > 2048
  ) {
    return invalid()
  }
  try {
    const authorization = new URL(record.authorizationUrl)
    const redirect = new URL(record.redirectUri)
    const keys = [...authorization.searchParams.keys()]
    if (
      authorization.origin !== FEISHU_AUTHORIZATION_ORIGIN ||
      authorization.pathname !== FEISHU_AUTHORIZATION_PATH ||
      authorization.username.length !== 0 ||
      authorization.password.length !== 0 ||
      authorization.hash.length !== 0 ||
      keys.length !== 8 ||
      ![
        'client_id',
        'response_type',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        'prompt',
      ].every((key) => authorization.searchParams.getAll(key).length === 1) ||
      (authorization.searchParams.get('client_id')?.length ?? 0) === 0 ||
      authorization.searchParams.get('response_type') !== 'code' ||
      authorization.searchParams.get('redirect_uri') !== record.redirectUri ||
      (authorization.searchParams.get('scope')?.length ?? 0) === 0 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(authorization.searchParams.get('state') ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/u.test(authorization.searchParams.get('code_challenge') ?? '') ||
      authorization.searchParams.get('code_challenge_method') !== 'S256' ||
      authorization.searchParams.get('prompt') !== 'consent' ||
      redirect.protocol !== 'http:' ||
      (redirect.hostname !== '127.0.0.1' && redirect.hostname !== '[::1]') ||
      redirect.port.length === 0 ||
      redirect.username.length !== 0 ||
      redirect.password.length !== 0 ||
      redirect.search.length !== 0 ||
      redirect.hash.length !== 0
    ) {
      return invalid()
    }
  } catch {
    return invalid()
  }
  return Object.freeze({
    authorizationUrl: record.authorizationUrl,
    redirectUri: record.redirectUri,
  })
}

function stateAt(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, 'state')
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
  } catch {
    return invalid()
  }
}

/** Parse the exact memory-only reauthorization state before server or browser use. */
export function parseFeishuReauthorizationSnapshot(value: unknown): FeishuReauthorizationSnapshot {
  const state = stateAt(value)
  const base = recordAt(
    value,
    state === 'waiting'
      ? ['version', 'connectorId', 'state', 'authorizationUrl', 'redirectUri']
      : state === 'failed'
        ? ['version', 'connectorId', 'state', 'recovery']
        : ['version', 'connectorId', 'state'],
  )
  if (base.version !== 1 || base.connectorId !== 'feishu') return invalid()
  if (
    base.state === 'idle' ||
    base.state === 'starting' ||
    base.state === 'succeeded' ||
    base.state === 'cancelled'
  ) {
    return Object.freeze({ version: 1, connectorId: 'feishu', state: base.state })
  }
  if (base.state === 'waiting') {
    return Object.freeze({ version: 1, connectorId: 'feishu', state: 'waiting', ...urls(base) })
  }
  if (
    base.state === 'failed' &&
    typeof base.recovery === 'string' &&
    RECOVERIES.includes(base.recovery as FeishuReauthorizationRecovery)
  ) {
    return Object.freeze({
      version: 1,
      connectorId: 'feishu',
      state: 'failed',
      recovery: base.recovery as FeishuReauthorizationRecovery,
    })
  }
  return invalid()
}
