import { parseIsoTimestamp } from '@twindesk/domain'

import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'
import {
  FeishuOAuthCredentialBundleEncoder,
  FeishuOAuthCredentialBundleEncoderError,
} from './oauth-credential-bundle-encoder.ts'
import {
  FeishuOAuthUserPrincipalVerificationError,
  type FeishuOAuthUserPrincipalVerifier,
} from './oauth-user-principal-verifier.ts'
import { parseFeishuIdentityConfiguration } from './identity-configuration.ts'
import {
  FeishuSystemKeychainError,
  type FeishuSystemKeychainSecretReplacer,
} from './system-keychain.ts'
import {
  FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS,
  type FeishuOAuthV3TokenSet,
} from './oauth-v3-token-refresh.ts'

export type FeishuOAuthInitialPersistenceErrorCode =
  | 'invalid_request'
  | 'identity_mismatch'
  | 'reauthorization_required'
  | 'verification_unavailable'
  | 'persistence_unavailable'
  | 'persistence_uncertain'

export type FeishuOAuthInitialPersistenceRecovery =
  'do_not_retry' | 'reauthorize' | 'reconcile_keychain'

export class FeishuOAuthInitialPersistenceError extends Error {
  readonly code: FeishuOAuthInitialPersistenceErrorCode
  readonly recovery: FeishuOAuthInitialPersistenceRecovery

  constructor(
    code: FeishuOAuthInitialPersistenceErrorCode,
    recovery: FeishuOAuthInitialPersistenceRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOAuthInitialPersistenceError'
    this.code = code
    this.recovery = recovery
  }
}

export interface FeishuOAuthInitialCredentialPersisterOptions {
  readonly verifier: FeishuOAuthUserPrincipalVerifier
  readonly replacer: FeishuSystemKeychainSecretReplacer
  readonly encoder?: FeishuOAuthCredentialBundleEncoder
}

export interface FeishuOAuthInitialPersistenceResult {
  readonly status: 'persisted'
  readonly obtainedAt: string
}

export interface FeishuOAuthInitialPersistenceChronology {
  readonly mustBeNewerThan: string
  readonly mustNotBeNewerThan: string
}

type UnknownRecord = Readonly<Record<string, unknown>>
const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

function fail(
  code: FeishuOAuthInitialPersistenceErrorCode,
  recovery: FeishuOAuthInitialPersistenceRecovery,
  message: string,
): FeishuOAuthInitialPersistenceError {
  return new FeishuOAuthInitialPersistenceError(code, recovery, message)
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
    throw fail(
      'invalid_request',
      'do_not_retry',
      'The Feishu OAuth initial-persistence request is invalid.',
    )
  }
}

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(record)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw fail(
      'invalid_request',
      'do_not_retry',
      'The Feishu OAuth initial-persistence request is invalid.',
    )
  }
}

function method<TMethod extends (...arguments_: never[]) => unknown>(
  value: unknown,
  name: string,
): TMethod {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      throw new TypeError()
    }
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return descriptor.value.bind(value) as TMethod
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw fail(
      'invalid_request',
      'do_not_retry',
      'The Feishu OAuth initial-persistence adapter is invalid.',
    )
  }
}

function readOptions(value: unknown): Readonly<{
  verify: FeishuOAuthUserPrincipalVerifier['withVerifiedPrincipal']
  encode: FeishuOAuthCredentialBundleEncoder['withEncodedInitialBundle']
  replace: FeishuSystemKeychainSecretReplacer['replace']
}> {
  const record = dataRecord(value)
  const expected = Object.hasOwn(record, 'encoder')
    ? ['verifier', 'replacer', 'encoder']
    : ['verifier', 'replacer']
  exactKeys(record, expected)
  const encoder = Object.hasOwn(record, 'encoder')
    ? record.encoder
    : new FeishuOAuthCredentialBundleEncoder()
  return Object.freeze({
    verify: method<FeishuOAuthUserPrincipalVerifier['withVerifiedPrincipal']>(
      record.verifier,
      'withVerifiedPrincipal',
    ),
    encode: method<FeishuOAuthCredentialBundleEncoder['withEncodedInitialBundle']>(
      encoder,
      'withEncodedInitialBundle',
    ),
    replace: method<FeishuSystemKeychainSecretReplacer['replace']>(record.replacer, 'replace'),
  })
}

function copySecretBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > FEISHU_OAUTH_TOKEN_MAX_LENGTH
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial token set is invalid.')
  }
  const copy = new Uint8Array(value.byteLength)
  for (let index = 0; index < value.byteLength; index += 1) copy[index] = value[index] as number
  return copy
}

function tokenScopes(value: unknown): readonly string[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== value.length + 1 ||
      !Object.hasOwn(descriptors, 'length')
    ) {
      throw new TypeError()
    }
    const scopes = Array.from({ length: value.length }, (_, index) => {
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
    if (
      new Set(scopes).size !== scopes.length ||
      !scopes.includes('offline_access') ||
      scopes.some((scope, index) => index > 0 && scopes[index - 1]! >= scope)
    ) {
      throw new TypeError()
    }
    return Object.freeze(scopes)
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial token set is invalid.')
  }
}

function tokenSetSnapshot(value: unknown): FeishuOAuthV3TokenSet {
  const record = dataRecord(value)
  exactKeys(record, [
    'tokenType',
    'accessToken',
    'obtainedAt',
    'accessTokenExpiresAt',
    'refreshToken',
    'refreshTokenExpiresAt',
    'scopes',
  ])
  if (record.tokenType !== 'Bearer') {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial token set is invalid.')
  }
  let obtainedAt
  let accessTokenExpiresAt
  let refreshTokenExpiresAt
  try {
    obtainedAt = parseIsoTimestamp(record.obtainedAt)
    accessTokenExpiresAt = parseIsoTimestamp(record.accessTokenExpiresAt)
    refreshTokenExpiresAt = parseIsoTimestamp(record.refreshTokenExpiresAt)
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial token set is invalid.')
  }
  const obtainedAtMilliseconds = Date.parse(obtainedAt)
  const maximumLifetimeMilliseconds = FEISHU_OAUTH_V3_MAX_LIFETIME_SECONDS * 1000
  const accessLifetimeMilliseconds = Date.parse(accessTokenExpiresAt) - obtainedAtMilliseconds
  const refreshLifetimeMilliseconds = Date.parse(refreshTokenExpiresAt) - obtainedAtMilliseconds
  if (
    accessLifetimeMilliseconds <= 0 ||
    accessLifetimeMilliseconds > maximumLifetimeMilliseconds ||
    refreshLifetimeMilliseconds <= 0 ||
    refreshLifetimeMilliseconds > maximumLifetimeMilliseconds
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial token set is invalid.')
  }
  const accessToken = copySecretBytes(record.accessToken)
  let refreshToken: Uint8Array<ArrayBuffer> | undefined
  try {
    refreshToken = copySecretBytes(record.refreshToken)
    return Object.freeze({
      tokenType: 'Bearer',
      accessToken,
      obtainedAt,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      scopes: tokenScopes(record.scopes),
    })
  } catch (error) {
    zeroBytes(accessToken)
    if (refreshToken !== undefined) zeroBytes(refreshToken)
    throw error
  }
}

function clientSecret(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength === 0 ||
    value.byteLength > 512
  ) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth client secret is invalid.')
  }
  const copy = new Uint8Array(value.byteLength)
  for (let index = 0; index < value.byteLength; index += 1) {
    copy[index] = value[index] as number
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(copy)
    if (
      text.length === 0 ||
      text.length > 512 ||
      text.trim() !== text ||
      /[\u0000-\u001f\u007f]/u.test(text)
    ) {
      throw new TypeError()
    }
  } catch {
    zeroBytes(copy)
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth client secret is invalid.')
  }
  return copy
}

function mapVerification(error: FeishuOAuthUserPrincipalVerificationError): never {
  if (error.code === 'identity_mismatch') {
    throw fail(
      'identity_mismatch',
      'reauthorize',
      'The authorized Feishu User does not match the configured identity.',
    )
  }
  if (error.code === 'reauthorization_required') {
    throw fail(
      'reauthorization_required',
      'reauthorize',
      'The Feishu User authorization must be renewed.',
    )
  }
  if (
    error.code === 'invalid_response' ||
    error.code === 'unavailable' ||
    error.code === 'retry_later'
  ) {
    throw fail(
      'verification_unavailable',
      'reauthorize',
      'The transient Feishu User credential could not be verified.',
    )
  }
  throw fail(
    'invalid_request',
    'do_not_retry',
    'The Feishu OAuth initial-persistence verification failed.',
  )
}

function mapPersistence(error: unknown): never {
  if (error instanceof FeishuOAuthCredentialBundleEncoderError) {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth initial credential is invalid.')
  }
  if (error instanceof FeishuSystemKeychainError) {
    if (error.code === 'write_uncertain') {
      throw fail(
        'persistence_uncertain',
        'reconcile_keychain',
        'The initial Feishu Keychain write outcome is uncertain.',
      )
    }
    throw fail(
      'persistence_unavailable',
      'do_not_retry',
      'The initial Feishu credential could not be persisted.',
    )
  }
  throw fail(
    'persistence_unavailable',
    'do_not_retry',
    'The initial Feishu credential could not be persisted.',
  )
}

/**
 * Persist a freshly exchanged User credential only after the access token's
 * application-scoped open_id matches the configured User principal.
 */
export class FeishuOAuthInitialCredentialPersister {
  readonly #verify: FeishuOAuthUserPrincipalVerifier['withVerifiedPrincipal']
  readonly #encode: FeishuOAuthCredentialBundleEncoder['withEncodedInitialBundle']
  readonly #replace: FeishuSystemKeychainSecretReplacer['replace']

  constructor(options: FeishuOAuthInitialCredentialPersisterOptions) {
    const validated = readOptions(options)
    this.#verify = validated.verify
    this.#encode = validated.encode
    this.#replace = validated.replace
  }

  async persist(
    configurationValue: unknown,
    clientSecretValue: Uint8Array,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#persistWithResult(configurationValue, clientSecretValue, tokenSetValue, signal)
  }

  persistWithResult(
    configurationValue: unknown,
    clientSecretValue: Uint8Array,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
    chronologyValue?: FeishuOAuthInitialPersistenceChronology,
  ): Promise<FeishuOAuthInitialPersistenceResult> {
    return this.#persistWithResult(
      configurationValue,
      clientSecretValue,
      tokenSetValue,
      signal,
      chronologyValue,
    )
  }

  async #persistWithResult(
    configurationValue: unknown,
    clientSecretValue: Uint8Array,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
    chronologyValue?: FeishuOAuthInitialPersistenceChronology,
  ): Promise<FeishuOAuthInitialPersistenceResult> {
    signal.throwIfAborted()
    let configuration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail(
        'invalid_request',
        'do_not_retry',
        'The Feishu OAuth identity configuration is invalid.',
      )
    }
    if (configuration.user === undefined) {
      throw fail(
        'invalid_request',
        'do_not_retry',
        'The Feishu OAuth User identity is not configured.',
      )
    }
    let mustBeNewerThan: string | undefined
    let mustNotBeNewerThan: string | undefined
    if (chronologyValue !== undefined) {
      try {
        const chronology = dataRecord(chronologyValue)
        exactKeys(chronology, ['mustBeNewerThan', 'mustNotBeNewerThan'])
        mustBeNewerThan = parseIsoTimestamp(chronology.mustBeNewerThan)
        mustNotBeNewerThan = parseIsoTimestamp(chronology.mustNotBeNewerThan)
        if (Date.parse(mustNotBeNewerThan) < Date.parse(mustBeNewerThan)) throw new TypeError()
      } catch {
        throw fail(
          'invalid_request',
          'do_not_retry',
          'The Feishu OAuth replacement chronology is invalid.',
        )
      }
    }
    const clientSecretCopy = clientSecret(clientSecretValue)
    let tokenSet: FeishuOAuthV3TokenSet | undefined
    try {
      const ownedTokenSet = tokenSetSnapshot(tokenSetValue)
      tokenSet = ownedTokenSet
      if (mustBeNewerThan !== undefined) {
        if (Date.parse(ownedTokenSet.obtainedAt) <= Date.parse(mustBeNewerThan)) {
          throw fail(
            'invalid_request',
            'do_not_retry',
            'The Feishu OAuth replacement credential is not newer.',
          )
        }
      }
      if (
        mustNotBeNewerThan !== undefined &&
        Date.parse(ownedTokenSet.obtainedAt) > Date.parse(mustNotBeNewerThan)
      ) {
        throw fail(
          'invalid_request',
          'do_not_retry',
          'The Feishu OAuth replacement credential is from the future.',
        )
      }
      return await this.#verify(configuration, ownedTokenSet.accessToken, signal, async () => {
        try {
          await this.#encode(configuration, clientSecretCopy, ownedTokenSet, signal, (bundle) =>
            this.#replace(configuration.user!.credentialReference, bundle, signal),
          )
        } catch (error) {
          if (
            error instanceof FeishuOAuthCredentialBundleEncoderError ||
            error instanceof FeishuSystemKeychainError
          ) {
            mapPersistence(error)
          }
          if (signal.aborted) signal.throwIfAborted()
          mapPersistence(error)
        }
        return Object.freeze({ status: 'persisted', obtainedAt: ownedTokenSet.obtainedAt })
      })
    } catch (error) {
      if (error instanceof FeishuOAuthInitialPersistenceError) throw error
      if (error instanceof FeishuOAuthUserPrincipalVerificationError) mapVerification(error)
      if (signal.aborted) signal.throwIfAborted()
      throw fail(
        'verification_unavailable',
        'reauthorize',
        'The transient Feishu User credential could not be verified.',
      )
    } finally {
      zeroBytes(clientSecretCopy)
      if (tokenSet !== undefined) {
        zeroBytes(tokenSet.accessToken)
        zeroBytes(tokenSet.refreshToken)
      }
    }
  }
}
