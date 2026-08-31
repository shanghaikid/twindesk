import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'

export const FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION = 1 as const

export type FeishuOAuthAuthorizationConfigurationErrorCode =
  | 'invalid_configuration'
  | 'invalid_store_path'
  | 'configuration_too_large'
  | 'unsafe_file'
  | 'io_error'

export class FeishuOAuthAuthorizationConfigurationError extends Error {
  readonly code: FeishuOAuthAuthorizationConfigurationErrorCode

  constructor(code: FeishuOAuthAuthorizationConfigurationErrorCode, message: string) {
    super(message)
    this.name = 'FeishuOAuthAuthorizationConfigurationError'
    this.code = code
  }
}

export interface FeishuOAuthAuthorizationConfiguration {
  readonly kind: 'feishu_oauth_authorization_configuration'
  readonly schemaVersion: typeof FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION_VERSION
  readonly connectorId: 'feishu'
  readonly appId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
}

type UnknownRecord = Readonly<Record<string, unknown>>
const MAX_CONFIGURATION_BYTES = 64 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function fail(
  code: FeishuOAuthAuthorizationConfigurationErrorCode,
  message: string,
): FeishuOAuthAuthorizationConfigurationError {
  return new FeishuOAuthAuthorizationConfigurationError(code, message)
}

function invalid(): FeishuOAuthAuthorizationConfigurationError {
  return fail('invalid_configuration', 'The Feishu OAuth authorization configuration is invalid.')
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

function storePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw fail('invalid_store_path', 'The Feishu OAuth authorization store path is invalid.')
  }
  return value
}

async function existingFileIsSafe(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw fail('unsafe_file', 'The Feishu OAuth authorization store is not a regular file.')
    }
    if (stats.size > MAX_CONFIGURATION_BYTES) {
      throw fail(
        'configuration_too_large',
        'The Feishu OAuth authorization configuration is too large.',
      )
    }
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function readBoundedConfiguration(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const document = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1)
  let bytesRead = 0
  try {
    while (bytesRead < document.byteLength) {
      const result = await handle.read(
        document,
        bytesRead,
        document.byteLength - bytesRead,
        bytesRead,
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_CONFIGURATION_BYTES) {
      throw fail(
        'configuration_too_large',
        'The Feishu OAuth authorization configuration is too large.',
      )
    }
    try {
      return UTF8_DECODER.decode(document.subarray(0, bytesRead))
    } catch {
      throw invalid()
    }
  } finally {
    document.fill(0)
  }
}

/** Persist only the versioned, non-secret Feishu OAuth authorization settings. */
export class FeishuOAuthAuthorizationConfigurationStore {
  readonly #filePath: string

  constructor(filePath: string) {
    this.#filePath = storePath(filePath)
  }

  async read(): Promise<FeishuOAuthAuthorizationConfiguration | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      try {
        handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return undefined
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ELOOP'
        ) {
          throw fail('unsafe_file', 'The Feishu OAuth authorization store is not a regular file.')
        }
        throw error
      }
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw fail('unsafe_file', 'The Feishu OAuth authorization store is not a regular file.')
      }
      if (stats.size > MAX_CONFIGURATION_BYTES) {
        throw fail(
          'configuration_too_large',
          'The Feishu OAuth authorization configuration is too large.',
        )
      }
      const document = await readBoundedConfiguration(handle)
      let value: unknown
      try {
        value = JSON.parse(document) as unknown
      } catch {
        throw invalid()
      }
      return parseFeishuOAuthAuthorizationConfiguration(value)
    } catch (error) {
      if (error instanceof FeishuOAuthAuthorizationConfigurationError) throw error
      throw fail('io_error', 'The Feishu OAuth authorization configuration could not be read.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async write(value: unknown): Promise<FeishuOAuthAuthorizationConfiguration> {
    const configuration = parseFeishuOAuthAuthorizationConfiguration(value)
    const document = `${JSON.stringify(configuration, null, 2)}\n`
    if (Buffer.byteLength(document) > MAX_CONFIGURATION_BYTES) {
      throw fail(
        'configuration_too_large',
        'The Feishu OAuth authorization configuration is too large.',
      )
    }

    const parent = dirname(this.#filePath)
    const temporaryPath = join(
      parent,
      `.${basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let temporaryExists = false
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await existingFileIsSafe(this.#filePath)
      const handle = await open(temporaryPath, 'wx', 0o600)
      temporaryExists = true
      try {
        await handle.writeFile(document, { encoding: 'utf8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.#filePath)
      temporaryExists = false
      const directoryHandle = await open(parent, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
      return configuration
    } catch (error) {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
      if (error instanceof FeishuOAuthAuthorizationConfigurationError) throw error
      throw fail('io_error', 'The Feishu OAuth authorization configuration could not be stored.')
    }
  }
}
