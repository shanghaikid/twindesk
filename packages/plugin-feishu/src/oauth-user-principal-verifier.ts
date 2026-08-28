import { parseFeishuIdentityConfiguration } from './identity-configuration.ts'
import { FEISHU_OAUTH_TOKEN_MAX_LENGTH } from './credential-bundle.ts'

export const FEISHU_OAUTH_USER_INFO_URL =
  'https://open.feishu.cn/open-apis/authen/v1/user_info' as const
export const FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES = 16 * 1024

export type FeishuOAuthUserPrincipalVerificationErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_response'
  | 'identity_mismatch'
  | 'unavailable'
  | 'reauthorization_required'
  | 'retry_later'

export type FeishuOAuthUserPrincipalVerificationRetryDisposition =
  'do_not_retry' | 'reauthorize' | 'retry_later'

export class FeishuOAuthUserPrincipalVerificationError extends Error {
  readonly code: FeishuOAuthUserPrincipalVerificationErrorCode
  readonly retryDisposition: FeishuOAuthUserPrincipalVerificationRetryDisposition

  constructor(code: FeishuOAuthUserPrincipalVerificationErrorCode, message: string) {
    super(message)
    this.name = 'FeishuOAuthUserPrincipalVerificationError'
    this.code = code
    this.retryDisposition =
      code === 'reauthorization_required'
        ? 'reauthorize'
        : code === 'retry_later'
          ? 'retry_later'
          : 'do_not_retry'
  }
}

export interface FeishuOAuthUserInfoRequest {
  readonly method: 'GET'
  readonly url: typeof FEISHU_OAUTH_USER_INFO_URL
  readonly accessToken: Uint8Array
  readonly maximumResponseBytes: typeof FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES
}

export interface FeishuOAuthUserInfoResponse {
  readonly openId: string
}

export interface FeishuOAuthUserInfoClient {
  get(
    request: FeishuOAuthUserInfoRequest,
    signal: AbortSignal,
  ): Promise<FeishuOAuthUserInfoResponse>
}

export interface FeishuOAuthUserPrincipalVerifierOptions {
  readonly client: FeishuOAuthUserInfoClient
}

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(
  code: FeishuOAuthUserPrincipalVerificationErrorCode,
  message: string,
): FeishuOAuthUserPrincipalVerificationError {
  return new FeishuOAuthUserPrincipalVerificationError(code, message)
}

function dataRecord(value: unknown, code: 'invalid_client' | 'invalid_response'): UnknownRecord {
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
      code,
      code === 'invalid_client'
        ? 'The Feishu OAuth user-info client is invalid.'
        : 'The Feishu OAuth user-info response is invalid.',
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
    throw fail('invalid_response', 'The Feishu OAuth user-info response is invalid.')
  }
}

function principal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw fail('invalid_response', 'The Feishu OAuth user-info principal is invalid.')
  }
  return value
}

function clientFromOptions(value: unknown): FeishuOAuthUserInfoClient {
  const options = dataRecord(value, 'invalid_client')
  const keys = Object.keys(options)
  if (keys.length !== 1 || keys[0] !== 'client') {
    throw fail('invalid_client', 'The Feishu OAuth user-info client is invalid.')
  }
  const client = options.client
  try {
    if ((typeof client !== 'object' && typeof client !== 'function') || client === null) {
      throw new TypeError()
    }
    let owner: object | null = client
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'get')
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return Object.freeze({
          get: descriptor.value.bind(client) as FeishuOAuthUserInfoClient['get'],
        })
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw fail('invalid_client', 'The Feishu OAuth user-info client is invalid.')
  }
}

function response(value: unknown): FeishuOAuthUserInfoResponse {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(record, ['openId'])
  return Object.freeze({ openId: principal(record.openId) })
}

/**
 * Verify that a freshly acquired User token belongs to the exact configured
 * Feishu open_id before any credential bundle may be persisted.
 */
export class FeishuOAuthUserPrincipalVerifier {
  readonly #client: FeishuOAuthUserInfoClient

  constructor(options: FeishuOAuthUserPrincipalVerifierOptions) {
    this.#client = clientFromOptions(options)
  }

  async withVerifiedPrincipal<TResult>(
    configurationValue: unknown,
    accessTokenValue: Uint8Array,
    signal: AbortSignal,
    use: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_request', 'The Feishu OAuth verified-principal consumer is invalid.')
    }
    let configuration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail('invalid_request', 'The Feishu OAuth identity configuration is invalid.')
    }
    if (configuration.user === undefined) {
      throw fail('invalid_request', 'The Feishu OAuth User identity is not configured.')
    }
    if (
      !(accessTokenValue instanceof Uint8Array) ||
      !(accessTokenValue.buffer instanceof ArrayBuffer) ||
      accessTokenValue.byteLength === 0 ||
      accessTokenValue.byteLength > FEISHU_OAUTH_TOKEN_MAX_LENGTH
    ) {
      throw fail('invalid_request', 'The Feishu OAuth access token is invalid.')
    }

    const accessToken = new Uint8Array(accessTokenValue)
    const request = Object.freeze({
      method: 'GET' as const,
      url: FEISHU_OAUTH_USER_INFO_URL,
      accessToken,
      maximumResponseBytes: FEISHU_OAUTH_USER_INFO_RESPONSE_MAX_BYTES,
    })
    try {
      let observed: FeishuOAuthUserInfoResponse
      try {
        observed = response(await this.#client.get(request, signal))
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        if (error instanceof FeishuOAuthUserPrincipalVerificationError) throw error
        throw fail('unavailable', 'The Feishu OAuth user identity could not be verified.')
      }
      signal.throwIfAborted()
      if (observed.openId !== configuration.user.principalId) {
        throw fail(
          'identity_mismatch',
          'The authorized Feishu User does not match the configured identity.',
        )
      }
      // Once the consumer reports success, its persistence result is
      // authoritative. Turning a completed write into AbortError would make
      // the initial credential state ambiguous and invite an unsafe retry.
      return await use()
    } finally {
      accessToken.fill(0)
    }
  }
}
