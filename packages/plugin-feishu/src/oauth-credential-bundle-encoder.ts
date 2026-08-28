import { parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import {
  FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES,
  FEISHU_CREDENTIAL_BUNDLE_VERSION,
  FEISHU_OAUTH_TOKEN_MAX_LENGTH,
  type FeishuUserOAuthCredentialBundle,
} from './credential-bundle.ts'
import { parseFeishuIdentityConfiguration } from './identity-configuration.ts'
import type { FeishuOAuthV3TokenSet } from './oauth-v3-token-refresh.ts'

export type FeishuOAuthCredentialBundleEncoderErrorCode =
  'invalid_credential' | 'invalid_token_set' | 'invalid_consumer' | 'bundle_too_large'

export class FeishuOAuthCredentialBundleEncoderError extends Error {
  readonly code: FeishuOAuthCredentialBundleEncoderErrorCode

  constructor(code: FeishuOAuthCredentialBundleEncoderErrorCode, message: string) {
    super(message)
    this.name = 'FeishuOAuthCredentialBundleEncoderError'
    this.code = code
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(
  code: FeishuOAuthCredentialBundleEncoderErrorCode,
  message: string,
): FeishuOAuthCredentialBundleEncoderError {
  return new FeishuOAuthCredentialBundleEncoderError(code, message)
}

function dataRecord(
  value: unknown,
  code: 'invalid_credential' | 'invalid_token_set',
): UnknownRecord {
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
    throw fail(code, 'The Feishu OAuth credential rotation input is invalid.')
  }
}

function exactKeys(
  record: UnknownRecord,
  expected: readonly string[],
  code: 'invalid_credential' | 'invalid_token_set',
): void {
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw fail(code, 'The Feishu OAuth credential rotation shape is invalid.')
  }
}

function text(
  value: unknown,
  maximum: number,
  code: 'invalid_credential' | 'invalid_token_set',
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail(code, 'The Feishu OAuth credential rotation value is invalid.')
  }
  return value
}

function timestamp(value: unknown, code: 'invalid_credential' | 'invalid_token_set'): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail(code, 'The Feishu OAuth credential rotation timestamp is invalid.')
  }
}

function secretText(
  value: unknown,
  maximum: number,
  code: 'invalid_credential' | 'invalid_token_set',
): string {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > maximum
  ) {
    throw fail(code, 'The Feishu OAuth credential rotation secret is invalid.')
  }
  try {
    return text(new TextDecoder('utf-8', { fatal: true }).decode(value), maximum, code)
  } catch (error) {
    if (error instanceof FeishuOAuthCredentialBundleEncoderError) throw error
    throw fail(code, 'The Feishu OAuth credential rotation secret is invalid.')
  }
}

function secretBytes(
  value: unknown,
  maximum: number,
  code: 'invalid_credential' | 'invalid_token_set',
): void {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > maximum
  ) {
    throw fail(code, 'The Feishu OAuth credential rotation secret is invalid.')
  }
}

function scopeList(
  value: unknown,
  code: 'invalid_credential' | 'invalid_token_set',
): readonly string[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
      throw fail(code, 'The Feishu OAuth credential scope list is invalid.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== value.length + 1 ||
      !Object.hasOwn(descriptors, 'length') ||
      Array.from({ length: value.length }, (_, index) => String(index)).some((index) => {
        const descriptor = descriptors[index]
        return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
      })
    ) {
      throw fail(code, 'The Feishu OAuth credential scope list is invalid.')
    }
    const scopes = Array.from({ length: value.length }, (_, index) => {
      const item = descriptors[String(index)]?.value
      const scope = text(item, 256, code)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(scope)) {
        throw fail(code, 'The Feishu OAuth credential scope list is invalid.')
      }
      return scope
    })
    if (
      new Set(scopes).size !== scopes.length ||
      !scopes.includes('offline_access') ||
      scopes.some((scope, index) => index > 0 && scopes[index - 1]! >= scope)
    ) {
      throw fail(code, 'The Feishu OAuth credential scope list is invalid.')
    }
    return scopes
  } catch (error) {
    if (error instanceof FeishuOAuthCredentialBundleEncoderError) throw error
    throw fail(code, 'The Feishu OAuth credential scope list is invalid.')
  }
}

function credentialRecord(value: unknown): Readonly<{
  appId: string
  principalId: string
  clientSecret: string
  obtainedAt: IsoTimestamp
  refreshToken: Uint8Array
}> {
  const record = dataRecord(value, 'invalid_credential')
  exactKeys(
    record,
    [
      'kind',
      'schemaVersion',
      'appId',
      'principalId',
      'clientSecret',
      'tokenType',
      'accessToken',
      'accessTokenStatus',
      'obtainedAt',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
      'scopes',
    ],
    'invalid_credential',
  )
  if (
    record.kind !== 'feishu_user_oauth_credential_bundle' ||
    record.schemaVersion !== FEISHU_CREDENTIAL_BUNDLE_VERSION ||
    record.tokenType !== 'Bearer' ||
    (record.accessTokenStatus !== 'usable' && record.accessTokenStatus !== 'refresh_required')
  ) {
    throw fail('invalid_credential', 'The Feishu OAuth credential version is invalid.')
  }
  const obtainedAt = timestamp(record.obtainedAt, 'invalid_credential')
  const accessTokenExpiresAt = timestamp(record.accessTokenExpiresAt, 'invalid_credential')
  const refreshTokenExpiresAt = timestamp(record.refreshTokenExpiresAt, 'invalid_credential')
  if (
    Date.parse(accessTokenExpiresAt) <= Date.parse(obtainedAt) ||
    Date.parse(refreshTokenExpiresAt) <= Date.parse(obtainedAt)
  ) {
    throw fail('invalid_credential', 'The Feishu OAuth credential lifetime is invalid.')
  }
  secretBytes(record.accessToken, FEISHU_OAUTH_TOKEN_MAX_LENGTH, 'invalid_credential')
  secretBytes(record.refreshToken, FEISHU_OAUTH_TOKEN_MAX_LENGTH, 'invalid_credential')
  scopeList(record.scopes, 'invalid_credential')
  return Object.freeze({
    appId: text(record.appId, 128, 'invalid_credential'),
    principalId: text(record.principalId, 128, 'invalid_credential'),
    clientSecret: secretText(record.clientSecret, 512, 'invalid_credential'),
    obtainedAt,
    refreshToken: record.refreshToken as Uint8Array,
  })
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number)
  }
  return difference === 0
}

function tokenSetRecord(value: unknown): Readonly<{
  accessToken: string
  obtainedAt: IsoTimestamp
  accessTokenExpiresAt: IsoTimestamp
  refreshToken: string
  refreshTokenBytes: Uint8Array
  refreshTokenExpiresAt: IsoTimestamp
  scopes: readonly string[]
}> {
  const record = dataRecord(value, 'invalid_token_set')
  exactKeys(
    record,
    [
      'tokenType',
      'accessToken',
      'obtainedAt',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
      'scopes',
    ],
    'invalid_token_set',
  )
  if (record.tokenType !== 'Bearer') {
    throw fail('invalid_token_set', 'The Feishu OAuth rotated token type is invalid.')
  }
  const obtainedAt = timestamp(record.obtainedAt, 'invalid_token_set')
  const accessTokenExpiresAt = timestamp(record.accessTokenExpiresAt, 'invalid_token_set')
  const refreshTokenExpiresAt = timestamp(record.refreshTokenExpiresAt, 'invalid_token_set')
  if (
    Date.parse(accessTokenExpiresAt) <= Date.parse(obtainedAt) ||
    Date.parse(refreshTokenExpiresAt) <= Date.parse(obtainedAt)
  ) {
    throw fail('invalid_token_set', 'The Feishu OAuth rotated token lifetime is invalid.')
  }
  return Object.freeze({
    accessToken: secretText(record.accessToken, FEISHU_OAUTH_TOKEN_MAX_LENGTH, 'invalid_token_set'),
    obtainedAt,
    accessTokenExpiresAt,
    refreshToken: secretText(
      record.refreshToken,
      FEISHU_OAUTH_TOKEN_MAX_LENGTH,
      'invalid_token_set',
    ),
    refreshTokenBytes: record.refreshToken as Uint8Array,
    refreshTokenExpiresAt,
    scopes: scopeList(record.scopes, 'invalid_token_set'),
  })
}

function encodedBundle(
  appId: string,
  principalId: string,
  clientSecret: string,
  tokenSet: ReturnType<typeof tokenSetRecord>,
): Uint8Array<ArrayBuffer> {
  const bundle = new TextEncoder().encode(
    JSON.stringify({
      kind: 'feishu_user_oauth_credential_bundle',
      schemaVersion: FEISHU_CREDENTIAL_BUNDLE_VERSION,
      appId,
      principalId,
      clientSecret,
      tokenType: 'Bearer',
      accessToken: tokenSet.accessToken,
      obtainedAt: tokenSet.obtainedAt,
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshToken: tokenSet.refreshToken,
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
      scopes: tokenSet.scopes,
    }),
  )
  if (bundle.byteLength === 0 || bundle.byteLength > FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES) {
    bundle.fill(0)
    throw fail('bundle_too_large', 'The Feishu OAuth credential bundle is too large.')
  }
  return bundle
}

/**
 * Encode one rotated OAuth token set into the exact version 1 Keychain bundle.
 * The encoded byte buffer is callback-scoped and cleared on every exit.
 */
export class FeishuOAuthCredentialBundleEncoder {
  async withEncodedBundle<TResult>(
    credentialValue: FeishuUserOAuthCredentialBundle,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
    use: (bundle: Uint8Array) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_consumer', 'The Feishu OAuth bundle consumer is invalid.')
    }
    const credential = credentialRecord(credentialValue)
    const tokenSet = tokenSetRecord(tokenSetValue)
    if (
      Date.parse(tokenSet.obtainedAt) <= Date.parse(credential.obtainedAt) ||
      equalBytes(credential.refreshToken, tokenSet.refreshTokenBytes)
    ) {
      throw fail('invalid_token_set', 'The Feishu OAuth rotated token chronology is invalid.')
    }
    const bundle = encodedBundle(
      credential.appId,
      credential.principalId,
      credential.clientSecret,
      tokenSet,
    )
    try {
      signal.throwIfAborted()
      const result = await use(bundle)
      signal.throwIfAborted()
      return result
    } finally {
      bundle.fill(0)
    }
  }

  /**
   * Encode the first principal-verified OAuth token set for the configured
   * User. A successful persistence callback remains authoritative if
   * cancellation arrives while that callback completes.
   */
  async withEncodedInitialBundle<TResult>(
    configurationValue: unknown,
    clientSecretValue: Uint8Array,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
    use: (bundle: Uint8Array) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_consumer', 'The Feishu OAuth bundle consumer is invalid.')
    }
    let configuration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail('invalid_credential', 'The Feishu OAuth identity configuration is invalid.')
    }
    if (configuration.user === undefined) {
      throw fail('invalid_credential', 'The Feishu OAuth User identity is not configured.')
    }
    const clientSecret = secretText(clientSecretValue, 512, 'invalid_credential')
    const tokenSet = tokenSetRecord(tokenSetValue)
    const bundle = encodedBundle(
      configuration.appId,
      configuration.user.principalId,
      clientSecret,
      tokenSet,
    )
    try {
      signal.throwIfAborted()
      return await use(bundle)
    } finally {
      bundle.fill(0)
    }
  }
}
