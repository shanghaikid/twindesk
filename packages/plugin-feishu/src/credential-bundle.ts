import { parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_CREDENTIAL_BUNDLE_VERSION = 1 as const
export const FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES = 32 * 1024
export const FEISHU_OAUTH_TOKEN_MAX_LENGTH = 4 * 1024

export type FeishuCredentialBundleErrorCode =
  | 'invalid_bundle'
  | 'invalid_consumer'
  | 'identity_not_configured'
  | 'identity_mismatch'
  | 'credential_expired'
  | 'invalid_clock'

export class FeishuCredentialBundleError extends Error {
  readonly code: FeishuCredentialBundleErrorCode

  constructor(code: FeishuCredentialBundleErrorCode, message: string) {
    super(message)
    this.name = 'FeishuCredentialBundleError'
    this.code = code
  }
}

export interface FeishuAppCredentialBundle {
  readonly kind: 'feishu_app_credential_bundle'
  readonly schemaVersion: typeof FEISHU_CREDENTIAL_BUNDLE_VERSION
  readonly appId: string
  readonly appSecret: Uint8Array
}

export interface FeishuUserOAuthCredentialBundle {
  readonly kind: 'feishu_user_oauth_credential_bundle'
  readonly schemaVersion: typeof FEISHU_CREDENTIAL_BUNDLE_VERSION
  readonly appId: string
  readonly principalId: string
  readonly clientSecret: Uint8Array
  readonly tokenType: 'Bearer'
  readonly accessToken: Uint8Array
  readonly accessTokenStatus: 'usable' | 'refresh_required'
  readonly obtainedAt: IsoTimestamp
  readonly accessTokenExpiresAt: IsoTimestamp
  readonly refreshToken: Uint8Array
  readonly refreshTokenExpiresAt: IsoTimestamp
  readonly scopes: readonly string[]
}

export interface FeishuUserOAuthCredentialEvidence {
  readonly kind: 'feishu_user_oauth_credential_evidence'
  readonly schemaVersion: typeof FEISHU_CREDENTIAL_BUNDLE_VERSION
  readonly obtainedAt: IsoTimestamp
  readonly refreshTokenStatus: 'usable' | 'expired'
}

export type FeishuCredentialBundle = FeishuAppCredentialBundle | FeishuUserOAuthCredentialBundle

export interface FeishuCredentialBundleParserOptions {
  /** Trusted local clock used only for OAuth lifetime checks. */
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(code: FeishuCredentialBundleErrorCode, message: string): FeishuCredentialBundleError {
  return new FeishuCredentialBundleError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('invalid_bundle', 'The Feishu credential bundle is invalid.')
  }
  try {
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
    throw fail('invalid_bundle', 'The Feishu credential bundle is invalid.')
  }
}

function exactKeys(record: UnknownRecord, keys: readonly string[]): void {
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw fail('invalid_bundle', 'The Feishu credential bundle shape is invalid.')
  }
}

function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_bundle', 'The Feishu credential bundle contains an invalid value.')
  }
  return value
}

function secretBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function timestamp(value: unknown): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_bundle', 'The Feishu credential bundle timestamp is invalid.')
  }
}

function scopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw fail('invalid_bundle', 'The Feishu OAuth scope list is invalid.')
  }
  const parsed = value.map((scope) => {
    const item = boundedString(scope, 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(item)) {
      throw fail('invalid_bundle', 'The Feishu OAuth scope list is invalid.')
    }
    return item
  })
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.some((scope, index) => index > 0 && scope <= (parsed[index - 1] as string)) ||
    !parsed.includes('offline_access')
  ) {
    throw fail('invalid_bundle', 'The Feishu OAuth scope list is invalid.')
  }
  return Object.freeze(parsed)
}

function readObservedAt(now: () => number): IsoTimestamp {
  let nowMs: number
  try {
    nowMs = now()
  } catch {
    throw fail('invalid_clock', 'The Feishu credential clock is invalid.')
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw fail('invalid_clock', 'The Feishu credential clock is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(nowMs).toISOString())
  } catch {
    throw fail('invalid_clock', 'The Feishu credential clock is invalid.')
  }
}

function duplicateTopLevelKey(text: string): boolean {
  const keys = new Set<string>()
  let depth = 0
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const current = text[index]
        if (!escaped && current === '"') break
        if (!escaped && current === '\\') escaped = true
        else escaped = false
        index += 1
      }
      if (index >= text.length) return false
      let next = index + 1
      while (/\s/u.test(text[next] ?? '')) next += 1
      if (depth === 1 && text[next] === ':') {
        let key: unknown
        try {
          key = JSON.parse(text.slice(start, index + 1)) as unknown
        } catch {
          return false
        }
        if (typeof key !== 'string') return false
        if (keys.has(key)) return true
        keys.add(key)
      }
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
    }
    index += 1
  }
  return false
}

function decodeBundle(bytes: Uint8Array): UnknownRecord {
  if (bytes.byteLength === 0 || bytes.byteLength > FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES) {
    throw fail('invalid_bundle', 'The Feishu credential bundle size is invalid.')
  }
  let end = bytes.byteLength
  if (bytes[end - 1] === 0x0a) {
    end -= 1
    if (bytes[end - 1] === 0x0d) end -= 1
  }
  if (end === 0) throw fail('invalid_bundle', 'The Feishu credential bundle is empty.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
  } catch {
    throw fail('invalid_bundle', 'The Feishu credential bundle encoding is invalid.')
  }
  if (duplicateTopLevelKey(text)) {
    throw fail('invalid_bundle', 'The Feishu credential bundle has duplicate fields.')
  }
  try {
    return dataRecord(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof FeishuCredentialBundleError) throw error
    throw fail('invalid_bundle', 'The Feishu credential bundle is not valid JSON.')
  }
}

function parseAppCredential(
  record: UnknownRecord,
  configuration: FeishuIdentityConfiguration,
): FeishuAppCredentialBundle {
  exactKeys(record, ['kind', 'schemaVersion', 'appId', 'appSecret'])
  if (record.kind !== 'feishu_app_credential_bundle' || record.schemaVersion !== 1) {
    throw fail('invalid_bundle', 'The Feishu application credential version is unsupported.')
  }
  const appId = boundedString(record.appId, 128)
  const appSecret = boundedString(record.appSecret, 512)
  if (appId !== configuration.appId) {
    throw fail('identity_mismatch', 'The Feishu application credential identity does not match.')
  }
  return Object.freeze({
    kind: 'feishu_app_credential_bundle',
    schemaVersion: FEISHU_CREDENTIAL_BUNDLE_VERSION,
    appId,
    appSecret: secretBytes(appSecret),
  })
}

function parseUserCredential(
  record: UnknownRecord,
  configuration: FeishuIdentityConfiguration,
  observedAt: IsoTimestamp,
  allowExpired: boolean,
): FeishuUserOAuthCredentialBundle {
  exactKeys(record, [
    'kind',
    'schemaVersion',
    'appId',
    'principalId',
    'clientSecret',
    'tokenType',
    'accessToken',
    'obtainedAt',
    'accessTokenExpiresAt',
    'refreshToken',
    'refreshTokenExpiresAt',
    'scopes',
  ])
  if (record.kind !== 'feishu_user_oauth_credential_bundle' || record.schemaVersion !== 1) {
    throw fail('invalid_bundle', 'The Feishu OAuth credential version is unsupported.')
  }
  if (record.tokenType !== 'Bearer') {
    throw fail('invalid_bundle', 'The Feishu OAuth token type is invalid.')
  }
  const appId = boundedString(record.appId, 128)
  const principalId = boundedString(record.principalId, 128)
  if (appId !== configuration.appId || principalId !== configuration.user?.principalId) {
    throw fail('identity_mismatch', 'The Feishu OAuth credential identity does not match.')
  }
  const obtainedAt = timestamp(record.obtainedAt)
  const accessTokenExpiresAt = timestamp(record.accessTokenExpiresAt)
  const refreshTokenExpiresAt = timestamp(record.refreshTokenExpiresAt)
  const clientSecret = boundedString(record.clientSecret, 512)
  const accessToken = boundedString(record.accessToken, FEISHU_OAUTH_TOKEN_MAX_LENGTH)
  const refreshToken = boundedString(record.refreshToken, FEISHU_OAUTH_TOKEN_MAX_LENGTH)
  const grantedScopes = scopes(record.scopes)
  if (
    Date.parse(obtainedAt) > Date.parse(observedAt) ||
    Date.parse(accessTokenExpiresAt) <= Date.parse(obtainedAt) ||
    Date.parse(refreshTokenExpiresAt) <= Date.parse(obtainedAt)
  ) {
    throw fail('invalid_bundle', 'The Feishu OAuth credential lifetime is invalid.')
  }
  if (!allowExpired && Date.parse(refreshTokenExpiresAt) <= Date.parse(observedAt)) {
    throw fail('credential_expired', 'The Feishu OAuth credential requires user authorization.')
  }
  return Object.freeze({
    kind: 'feishu_user_oauth_credential_bundle',
    schemaVersion: FEISHU_CREDENTIAL_BUNDLE_VERSION,
    appId,
    principalId,
    clientSecret: secretBytes(clientSecret),
    tokenType: 'Bearer',
    accessToken: secretBytes(accessToken),
    accessTokenStatus:
      Date.parse(accessTokenExpiresAt) > Date.parse(observedAt) ? 'usable' : 'refresh_required',
    obtainedAt,
    accessTokenExpiresAt,
    refreshToken: secretBytes(refreshToken),
    refreshTokenExpiresAt,
    scopes: grantedScopes,
  })
}

function zeroCredential(credential: FeishuCredentialBundle | undefined): void {
  if (credential === undefined) return
  if (credential.kind === 'feishu_app_credential_bundle') {
    credential.appSecret.fill(0)
    return
  }
  credential.clientSecret.fill(0)
  credential.accessToken.fill(0)
  credential.refreshToken.fill(0)
}

/**
 * Parse one callback-scoped Keychain byte buffer. The input buffer is consumed
 * and zeroed on every exit. Parsed secret buffers are also zeroed immediately
 * after the callback settles.
 */
export class FeishuCredentialBundleParser {
  readonly #now: () => number

  constructor(options: FeishuCredentialBundleParserOptions = {}) {
    this.#now = options.now ?? Date.now
  }

  async withCredential<TResult>(
    configurationValue: unknown,
    identityType: 'bot' | 'user',
    bundle: Uint8Array,
    signal: AbortSignal,
    use: (credential: FeishuCredentialBundle) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    if (!(bundle instanceof Uint8Array)) {
      throw fail('invalid_bundle', 'The Feishu credential bundle is invalid.')
    }
    let credential: FeishuCredentialBundle | undefined
    try {
      signal.throwIfAborted()
      if (typeof use !== 'function') {
        throw fail('invalid_consumer', 'The Feishu credential consumer is invalid.')
      }
      try {
        const configuration = parseFeishuIdentityConfiguration(configurationValue)
        if (identityType !== 'bot' && identityType !== 'user') {
          throw fail('identity_mismatch', 'The Feishu credential identity type is invalid.')
        }
        if (configuration[identityType] === undefined) {
          throw fail('identity_not_configured', 'The Feishu credential identity is not configured.')
        }
        const record = decodeBundle(bundle)
        credential =
          identityType === 'bot'
            ? parseAppCredential(record, configuration)
            : parseUserCredential(record, configuration, readObservedAt(this.#now), false)
      } catch (error) {
        if (error instanceof FeishuCredentialBundleError) throw error
        if (signal.aborted) signal.throwIfAborted()
        throw fail('invalid_bundle', 'The Feishu credential bundle could not be parsed.')
      }
      signal.throwIfAborted()
      const result = await use(credential)
      signal.throwIfAborted()
      return result
    } finally {
      zeroCredential(credential)
      bundle.fill(0)
    }
  }

  /**
   * Parse identity-bound User evidence for local journal reconciliation. The
   * caller receives explicit refresh expiry so it cannot confuse historical
   * write evidence with a currently recoverable credential. No secret bytes
   * leave this callback boundary.
   */
  async withUserCredentialEvidence<TResult>(
    configurationValue: unknown,
    bundle: Uint8Array,
    signal: AbortSignal,
    use: (evidence: FeishuUserOAuthCredentialEvidence) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    if (!(bundle instanceof Uint8Array)) {
      throw fail('invalid_bundle', 'The Feishu credential bundle is invalid.')
    }
    let credential: FeishuUserOAuthCredentialBundle | undefined
    let refreshTokenStatus: FeishuUserOAuthCredentialEvidence['refreshTokenStatus'] | undefined
    try {
      signal.throwIfAborted()
      if (typeof use !== 'function') {
        throw fail('invalid_consumer', 'The Feishu credential consumer is invalid.')
      }
      try {
        const configuration = parseFeishuIdentityConfiguration(configurationValue)
        if (configuration.user === undefined) {
          throw fail('identity_not_configured', 'The Feishu credential identity is not configured.')
        }
        const observedAt = readObservedAt(this.#now)
        credential = parseUserCredential(decodeBundle(bundle), configuration, observedAt, true)
        refreshTokenStatus =
          Date.parse(credential.refreshTokenExpiresAt) > Date.parse(observedAt)
            ? 'usable'
            : 'expired'
      } catch (error) {
        if (error instanceof FeishuCredentialBundleError) throw error
        if (signal.aborted) signal.throwIfAborted()
        throw fail('invalid_bundle', 'The Feishu credential bundle could not be parsed.')
      }
      signal.throwIfAborted()
      if (refreshTokenStatus === undefined) {
        throw fail('invalid_bundle', 'The Feishu credential bundle could not be parsed.')
      }
      const result = await use(
        Object.freeze({
          kind: 'feishu_user_oauth_credential_evidence',
          schemaVersion: FEISHU_CREDENTIAL_BUNDLE_VERSION,
          obtainedAt: credential.obtainedAt,
          refreshTokenStatus,
        }),
      )
      signal.throwIfAborted()
      return result
    } finally {
      zeroCredential(credential)
      bundle.fill(0)
    }
  }
}
