import { execFile } from 'node:child_process'

import { parseSecretReference, type SecretReference } from '@twindesk/domain'

export const FEISHU_SYSTEM_KEYCHAIN_SERVICE = 'com.twindesk.feishu' as const
export const FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES = 64 * 1024

export type FeishuSystemKeychainErrorCode =
  | 'invalid_reference'
  | 'invalid_consumer'
  | 'unsupported_store'
  | 'unsupported_purpose'
  | 'unsupported_platform'
  | 'not_found'
  | 'cancelled'
  | 'secret_empty'
  | 'secret_too_large'
  | 'unavailable'

export class FeishuSystemKeychainError extends Error {
  readonly code: FeishuSystemKeychainErrorCode

  constructor(code: FeishuSystemKeychainErrorCode, message: string) {
    super(message)
    this.name = 'FeishuSystemKeychainError'
    this.code = code
  }
}

export interface FeishuKeychainCommandRequest {
  readonly executable: '/usr/bin/security'
  readonly arguments: readonly [
    'find-generic-password',
    '-s',
    typeof FEISHU_SYSTEM_KEYCHAIN_SERVICE,
    '-a',
    string,
    '-w',
  ]
  readonly maximumOutputBytes: typeof FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES
}

export interface FeishuKeychainCommandRunner {
  run(request: FeishuKeychainCommandRequest, signal: AbortSignal): Promise<Uint8Array>
}

export interface FeishuSystemKeychainOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: FeishuKeychainCommandRunner
}

function fail(code: FeishuSystemKeychainErrorCode, message: string): FeishuSystemKeychainError {
  return new FeishuSystemKeychainError(code, message)
}

function commandErrorCode(error: unknown, signal: AbortSignal): FeishuSystemKeychainErrorCode {
  if (signal.aborted) return 'cancelled'
  try {
    if (error instanceof FeishuSystemKeychainError) return error.code
    if (typeof error === 'object' && error !== null) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')
      if (code !== undefined && Object.hasOwn(code, 'value')) {
        if (code.value === 44) return 'not_found'
        if (code.value === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'secret_too_large'
      }
    }
  } catch {
    return 'unavailable'
  }
  return 'unavailable'
}

function commandError(code: FeishuSystemKeychainErrorCode): FeishuSystemKeychainError {
  switch (code) {
    case 'cancelled':
      return fail(code, 'The Feishu Keychain lookup was cancelled.')
    case 'not_found':
      return fail(code, 'The Feishu credential is not present in the system Keychain.')
    case 'secret_too_large':
      return fail(code, 'The Feishu Keychain credential is too large.')
    default:
      return fail('unavailable', 'The Feishu credential is unavailable from the system Keychain.')
  }
}

class MacOsSecurityCommandRunner implements FeishuKeychainCommandRunner {
  run(request: FeishuKeychainCommandRequest, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      execFile(
        request.executable,
        request.arguments,
        {
          encoding: null,
          maxBuffer: request.maximumOutputBytes + 1,
          signal,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error !== null) {
            if (stdout instanceof Uint8Array) stdout.fill(0)
            reject(commandError(commandErrorCode(error, signal)))
            return
          }
          resolve(stdout)
        },
      )
    })
  }
}

function parseFeishuKeychainReference(value: unknown): SecretReference {
  let reference: SecretReference
  try {
    reference = parseSecretReference(value)
  } catch {
    throw fail('invalid_reference', 'The Feishu Keychain reference is invalid.')
  }
  if (reference.store !== 'system_keychain') {
    throw fail('unsupported_store', 'The Feishu credential is not stored in the system Keychain.')
  }
  if (reference.purpose !== 'connector_app_credential' && reference.purpose !== 'connector_oauth') {
    throw fail('unsupported_purpose', 'The Feishu Keychain reference purpose is unsupported.')
  }
  return reference
}

/**
 * Resolve one Feishu SecretReference through the macOS generic-password
 * Keychain. The callback receives the only working byte buffer; it is zeroed
 * immediately after the callback settles.
 */
export class FeishuSystemKeychainSecretResolver {
  readonly #platform: NodeJS.Platform
  readonly #runner: FeishuKeychainCommandRunner

  constructor(options: FeishuSystemKeychainOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#runner = options.runner ?? new MacOsSecurityCommandRunner()
  }

  async withSecret<TResult>(
    referenceValue: unknown,
    signal: AbortSignal,
    use: (secret: Uint8Array) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    signal.throwIfAborted()
    if (typeof use !== 'function') {
      throw fail('invalid_consumer', 'The Feishu Keychain secret consumer is invalid.')
    }
    const reference = parseFeishuKeychainReference(referenceValue)
    if (this.#platform !== 'darwin') {
      throw fail('unsupported_platform', 'The system Keychain adapter requires macOS.')
    }
    const request = Object.freeze({
      executable: '/usr/bin/security' as const,
      arguments: Object.freeze([
        'find-generic-password',
        '-s',
        FEISHU_SYSTEM_KEYCHAIN_SERVICE,
        '-a',
        reference.id,
        '-w',
      ]) as FeishuKeychainCommandRequest['arguments'],
      maximumOutputBytes: FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES,
    })
    let secret: Uint8Array
    try {
      const output = await this.#runner.run(request, signal)
      if (!(output instanceof Uint8Array)) {
        throw fail('unavailable', 'The Feishu credential is unavailable from the system Keychain.')
      }
      secret = output
    } catch (error) {
      throw commandError(commandErrorCode(error, signal))
    }
    try {
      signal.throwIfAborted()
      if (secret.byteLength === 0) {
        throw fail('secret_empty', 'The Feishu Keychain credential is empty.')
      }
      if (secret.byteLength > FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES) {
        throw fail('secret_too_large', 'The Feishu Keychain credential is too large.')
      }
      return await use(secret)
    } finally {
      secret.fill(0)
    }
  }
}
