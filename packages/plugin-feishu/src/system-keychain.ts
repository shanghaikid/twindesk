import { execFile, spawn } from 'node:child_process'

import { parseSecretReference, type SecretReference } from '@twindesk/domain'

export const FEISHU_SYSTEM_KEYCHAIN_SERVICE = 'com.twindesk.feishu' as const
export const FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES = 64 * 1024
export const FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES = 8 * 1024
const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

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
  | 'write_uncertain'
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

export interface FeishuKeychainReplaceCommandRequest {
  readonly executable: '/usr/bin/security'
  readonly arguments: readonly [
    'add-generic-password',
    '-U',
    '-s',
    typeof FEISHU_SYSTEM_KEYCHAIN_SERVICE,
    '-a',
    string,
    '-w',
  ]
  readonly maximumDiagnosticBytes: typeof FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES
}

export interface FeishuKeychainReplaceCommandRunner {
  replace(
    request: FeishuKeychainReplaceCommandRequest,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>
}

export interface FeishuSystemKeychainSecretReplacerOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: FeishuKeychainReplaceCommandRunner
}

export interface FeishuKeychainInstallCommandRequest {
  readonly executable: '/usr/bin/security'
  readonly arguments: readonly [
    'add-generic-password',
    '-s',
    typeof FEISHU_SYSTEM_KEYCHAIN_SERVICE,
    '-a',
    string,
    '-w',
  ]
  readonly maximumDiagnosticBytes: typeof FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES
}

export interface FeishuKeychainInstallCommandRunner {
  install(
    request: FeishuKeychainInstallCommandRequest,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>
}

export interface FeishuSystemKeychainSecretInstallerOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: FeishuKeychainInstallCommandRunner
}

type KeychainOptions = Readonly<Record<string, unknown>>

function fail(code: FeishuSystemKeychainErrorCode, message: string): FeishuSystemKeychainError {
  return new FeishuSystemKeychainError(code, message)
}

function readOptions(value: unknown): KeychainOptions {
  if (value === undefined) return Object.freeze({})
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => key !== 'platform' && key !== 'runner') ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
      ),
    )
  } catch {
    throw fail('unavailable', 'The Feishu Keychain adapter configuration is invalid.')
  }
}

function configuredPlatform(options: KeychainOptions): NodeJS.Platform {
  const platform = Object.hasOwn(options, 'platform') ? options.platform : process.platform
  if (typeof platform !== 'string' || platform.length === 0) {
    throw fail('unavailable', 'The Feishu Keychain adapter configuration is invalid.')
  }
  return platform as NodeJS.Platform
}

function configuredRunner<TMethod extends (...arguments_: never[]) => unknown>(
  options: KeychainOptions,
  methodName: 'run' | 'replace' | 'install',
  fallback: () => object,
): object & Record<typeof methodName, TMethod> {
  if (!Object.hasOwn(options, 'runner')) {
    return fallback() as object & Record<typeof methodName, TMethod>
  }
  const runner = options.runner
  try {
    if ((typeof runner !== 'object' && typeof runner !== 'function') || runner === null) {
      throw new TypeError()
    }
    let owner: object | null = runner
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, methodName)
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new TypeError()
        }
        return Object.freeze({
          [methodName]: descriptor.value.bind(runner) as TMethod,
        }) as object & Record<typeof methodName, TMethod>
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    throw new TypeError()
  } catch {
    throw fail('unavailable', 'The Feishu Keychain adapter configuration is invalid.')
  }
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

class MacOsSecurityReplaceCommandRunner implements FeishuKeychainReplaceCommandRunner {
  replace(
    request: FeishuKeychainReplaceCommandRequest,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let diagnosticBytes = 0
      const child = spawn(request.executable, request.arguments, {
        signal,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (error === undefined) resolve()
        else reject(error)
      }
      child.stderr?.on('data', (chunk: unknown) => {
        if (chunk instanceof Uint8Array) {
          diagnosticBytes += chunk.byteLength
          chunk.fill(0)
        } else {
          diagnosticBytes = request.maximumDiagnosticBytes + 1
        }
        if (diagnosticBytes > request.maximumDiagnosticBytes) child.kill()
      })
      child.once('error', finish)
      child.once('close', (code, childSignal) => {
        if (
          code === 0 &&
          childSignal === null &&
          diagnosticBytes <= request.maximumDiagnosticBytes
        ) {
          finish()
          return
        }
        finish(new Error('The Keychain update did not complete successfully.'))
      })
      child.stdin?.once('error', finish)
      child.stdin?.write(secret)
      child.stdin?.end(new Uint8Array([0x0a]))
    })
  }
}

class MacOsSecurityInstallCommandRunner implements FeishuKeychainInstallCommandRunner {
  install(
    request: FeishuKeychainInstallCommandRequest,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let diagnosticBytes = 0
      const child = spawn(request.executable, request.arguments, {
        signal,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (error === undefined) resolve()
        else reject(error)
      }
      child.stderr?.on('data', (chunk: unknown) => {
        if (chunk instanceof Uint8Array) {
          diagnosticBytes += chunk.byteLength
          chunk.fill(0)
        } else {
          diagnosticBytes = request.maximumDiagnosticBytes + 1
        }
        if (diagnosticBytes > request.maximumDiagnosticBytes) child.kill()
      })
      child.once('error', finish)
      child.once('close', (code, childSignal) => {
        if (
          code === 0 &&
          childSignal === null &&
          diagnosticBytes <= request.maximumDiagnosticBytes
        ) {
          finish()
          return
        }
        finish(new Error('The Keychain installation did not complete successfully.'))
      })
      child.stdin?.once('error', finish)
      child.stdin?.write(secret)
      child.stdin?.end(new Uint8Array([0x0a]))
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
  if (
    reference.purpose !== 'connector_app_credential' &&
    reference.purpose !== 'connector_oauth' &&
    reference.purpose !== 'connector_api_key'
  ) {
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

  constructor(options?: FeishuSystemKeychainOptions) {
    const validated = readOptions(options)
    this.#platform = configuredPlatform(validated)
    this.#runner = configuredRunner<FeishuKeychainCommandRunner['run']>(
      validated,
      'run',
      () => new MacOsSecurityCommandRunner(),
    )
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
      zeroBytes(secret)
    }
  }
}

/**
 * Atomically replace one existing Feishu generic-password value through the
 * macOS Keychain. Secret bytes are sent through stdin, never process arguments,
 * and are cleared after the command settles. Any post-start failure is
 * deliberately classified as uncertain because the Keychain update may have
 * taken effect before process observation failed.
 */
export class FeishuSystemKeychainSecretReplacer {
  readonly #platform: NodeJS.Platform
  readonly #runner: FeishuKeychainReplaceCommandRunner

  constructor(options?: FeishuSystemKeychainSecretReplacerOptions) {
    const validated = readOptions(options)
    this.#platform = configuredPlatform(validated)
    this.#runner = configuredRunner<FeishuKeychainReplaceCommandRunner['replace']>(
      validated,
      'replace',
      () => new MacOsSecurityReplaceCommandRunner(),
    )
  }

  async replace(referenceValue: unknown, secret: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!(secret instanceof Uint8Array)) {
      throw fail('secret_empty', 'The replacement Feishu credential is empty.')
    }
    try {
      signal.throwIfAborted()
      const reference = parseFeishuKeychainReference(referenceValue)
      if (reference.purpose !== 'connector_oauth') {
        throw fail('unsupported_purpose', 'Only a Feishu OAuth credential can be rotated.')
      }
      if (secret.byteLength === 0) {
        throw fail('secret_empty', 'The replacement Feishu credential is empty.')
      }
      if (secret.byteLength > FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES) {
        throw fail('secret_too_large', 'The replacement Feishu credential is too large.')
      }
      if (this.#platform !== 'darwin') {
        throw fail('unsupported_platform', 'The system Keychain adapter requires macOS.')
      }
      const request = Object.freeze({
        executable: '/usr/bin/security' as const,
        arguments: Object.freeze([
          'add-generic-password',
          '-U',
          '-s',
          FEISHU_SYSTEM_KEYCHAIN_SERVICE,
          '-a',
          reference.id,
          '-w',
        ]) as FeishuKeychainReplaceCommandRequest['arguments'],
        maximumDiagnosticBytes: FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
      })
      try {
        await this.#runner.replace(request, secret, signal)
        signal.throwIfAborted()
      } catch {
        throw fail(
          'write_uncertain',
          'The Feishu Keychain update outcome is uncertain and requires reconciliation.',
        )
      }
    } finally {
      zeroBytes(secret)
    }
  }
}

/**
 * Create one Bot application-credential Keychain item without update mode.
 * Secret bytes travel through stdin and are cleared on every exit. Any
 * post-start failure is uncertain and must never be retried automatically.
 */
export class FeishuSystemKeychainSecretInstaller {
  readonly #platform: NodeJS.Platform
  readonly #runner: FeishuKeychainInstallCommandRunner

  constructor(options?: FeishuSystemKeychainSecretInstallerOptions) {
    const validated = readOptions(options)
    this.#platform = configuredPlatform(validated)
    this.#runner = configuredRunner<FeishuKeychainInstallCommandRunner['install']>(
      validated,
      'install',
      () => new MacOsSecurityInstallCommandRunner(),
    )
  }

  async install(referenceValue: unknown, secret: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!(secret instanceof Uint8Array)) {
      throw fail('secret_empty', 'The Feishu credential to install is empty.')
    }
    try {
      if (!(signal instanceof AbortSignal)) {
        throw fail('unavailable', 'The Feishu Keychain installation request is invalid.')
      }
      signal.throwIfAborted()
      const reference = parseFeishuKeychainReference(referenceValue)
      if (reference.purpose !== 'connector_app_credential') {
        throw fail(
          'unsupported_purpose',
          'Only a Feishu Bot application credential can be installed.',
        )
      }
      if (secret.byteLength === 0) {
        throw fail('secret_empty', 'The Feishu credential to install is empty.')
      }
      if (secret.byteLength > FEISHU_SYSTEM_KEYCHAIN_SECRET_MAX_BYTES) {
        throw fail('secret_too_large', 'The Feishu Keychain credential is too large.')
      }
      if (this.#platform !== 'darwin') {
        throw fail('unsupported_platform', 'The system Keychain adapter requires macOS.')
      }
      const request = Object.freeze({
        executable: '/usr/bin/security' as const,
        arguments: Object.freeze([
          'add-generic-password',
          '-s',
          FEISHU_SYSTEM_KEYCHAIN_SERVICE,
          '-a',
          reference.id,
          '-w',
        ]) as FeishuKeychainInstallCommandRequest['arguments'],
        maximumDiagnosticBytes: FEISHU_SYSTEM_KEYCHAIN_DIAGNOSTIC_MAX_BYTES,
      })
      try {
        await this.#runner.install(request, secret, signal)
        signal.throwIfAborted()
      } catch {
        throw fail(
          'write_uncertain',
          'The Feishu Keychain installation outcome is uncertain and requires inspection.',
        )
      }
    } finally {
      zeroBytes(secret)
    }
  }
}
