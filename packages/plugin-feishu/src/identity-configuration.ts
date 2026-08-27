import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { parseSecretReference, type ActionIdentity, type SecretReference } from '@twindesk/domain'

export const FEISHU_IDENTITY_CONFIGURATION_VERSION = 1 as const
export const FEISHU_CONNECTOR_ID = 'feishu' as const

export type FeishuIdentityConfigurationErrorCode =
  | 'invalid_configuration'
  | 'credential_mismatch'
  | 'identity_conflict'
  | 'identity_not_configured'
  | 'invalid_store_path'
  | 'configuration_too_large'
  | 'unsafe_file'
  | 'io_error'

export class FeishuIdentityConfigurationError extends Error {
  readonly code: FeishuIdentityConfigurationErrorCode

  constructor(code: FeishuIdentityConfigurationErrorCode, message: string) {
    super(message)
    this.name = 'FeishuIdentityConfigurationError'
    this.code = code
  }
}

interface FeishuIdentityBase {
  readonly displayName: string
  readonly principalId: string
  readonly credentialReference: SecretReference
}

export interface FeishuBotIdentity extends FeishuIdentityBase {
  readonly identityType: 'bot'
  readonly credentialReference: SecretReference & {
    readonly purpose: 'connector_app_credential'
  }
}

export interface FeishuUserIdentity extends FeishuIdentityBase {
  readonly identityType: 'user'
  readonly credentialReference: SecretReference & {
    readonly purpose: 'connector_oauth'
  }
}

/**
 * Versioned, non-secret configuration for one Feishu application connection.
 * Bot and User identities remain separate even when they share an application.
 */
export interface FeishuIdentityConfiguration {
  readonly kind: 'feishu_identity_configuration'
  readonly schemaVersion: typeof FEISHU_IDENTITY_CONFIGURATION_VERSION
  readonly connectorId: typeof FEISHU_CONNECTOR_ID
  readonly accountId: string
  readonly appId: string
  readonly bot?: FeishuBotIdentity
  readonly user?: FeishuUserIdentity
}

type UnknownRecord = Readonly<Record<string, unknown>>

const MAX_CONFIGURATION_BYTES = 64 * 1024

function fail(
  code: FeishuIdentityConfigurationErrorCode,
  message: string,
): FeishuIdentityConfigurationError {
  return new FeishuIdentityConfigurationError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail('invalid_configuration', 'The Feishu identity configuration must be an object.')
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail('invalid_configuration', 'The Feishu identity configuration must be plain data.')
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw fail('invalid_configuration', 'The Feishu identity configuration has unknown fields.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Object.values(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value')) {
        throw fail('invalid_configuration', 'The Feishu identity configuration must contain data.')
      }
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof FeishuIdentityConfigurationError) throw error
    throw fail('invalid_configuration', 'The Feishu identity configuration is invalid.')
  }
}

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const expectedSet = new Set(expected)
  if (Object.keys(record).some((key) => !expectedSet.has(key))) {
    throw fail('invalid_configuration', 'The Feishu identity configuration has unknown fields.')
  }
}

function requiredString(value: unknown, pattern: RegExp, message: string, maxLength = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw fail('invalid_configuration', message)
  }
  return value
}

function displayName(value: unknown): string {
  return requiredString(
    value,
    /^[^\u0000-\u001f\u007f]+$/u,
    'A Feishu identity display name is invalid.',
  )
}

function parseIdentity(value: unknown, identityType: 'bot'): FeishuBotIdentity
function parseIdentity(value: unknown, identityType: 'user'): FeishuUserIdentity
function parseIdentity(
  value: unknown,
  identityType: 'bot' | 'user',
): FeishuBotIdentity | FeishuUserIdentity {
  const record = dataRecord(value)
  exactKeys(record, ['identityType', 'displayName', 'principalId', 'credentialReference'])
  if (record.identityType !== identityType) {
    throw fail('identity_conflict', 'A Feishu identity is stored in the wrong identity slot.')
  }
  let credentialReference: SecretReference
  try {
    credentialReference = parseSecretReference(record.credentialReference)
  } catch {
    throw fail('credential_mismatch', 'A Feishu credential reference is invalid.')
  }
  const requiredPurpose = identityType === 'bot' ? 'connector_app_credential' : 'connector_oauth'
  if (credentialReference.purpose !== requiredPurpose) {
    throw fail('credential_mismatch', 'A Feishu identity has an incompatible credential reference.')
  }
  const base = {
    identityType,
    displayName: displayName(record.displayName),
    principalId: requiredString(
      record.principalId,
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
      'A Feishu identity principal is invalid.',
    ),
    credentialReference,
  }
  return identityType === 'bot'
    ? Object.freeze(base as FeishuBotIdentity)
    : Object.freeze(base as FeishuUserIdentity)
}

/** Validate and deeply freeze the persisted, non-secret identity configuration. */
export function parseFeishuIdentityConfiguration(value: unknown): FeishuIdentityConfiguration {
  const record = dataRecord(value)
  exactKeys(record, ['kind', 'schemaVersion', 'connectorId', 'accountId', 'appId', 'bot', 'user'])
  if (
    record.kind !== 'feishu_identity_configuration' ||
    record.schemaVersion !== FEISHU_IDENTITY_CONFIGURATION_VERSION ||
    record.connectorId !== FEISHU_CONNECTOR_ID
  ) {
    throw fail('invalid_configuration', 'The Feishu identity configuration version is invalid.')
  }
  const bot = record.bot === undefined ? undefined : parseIdentity(record.bot, 'bot')
  const user = record.user === undefined ? undefined : parseIdentity(record.user, 'user')
  if (bot === undefined && user === undefined) {
    throw fail('invalid_configuration', 'At least one Feishu identity must be configured.')
  }
  if (bot?.credentialReference.id === user?.credentialReference.id) {
    throw fail('identity_conflict', 'Bot and User identities require separate credentials.')
  }
  return Object.freeze({
    kind: 'feishu_identity_configuration',
    schemaVersion: FEISHU_IDENTITY_CONFIGURATION_VERSION,
    connectorId: FEISHU_CONNECTOR_ID,
    accountId: requiredString(
      record.accountId,
      /^[a-z0-9][a-z0-9._:-]*$/u,
      'The Feishu account identity is invalid.',
    ),
    appId: requiredString(
      record.appId,
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
      'The Feishu application identity is invalid.',
    ),
    ...(bot === undefined ? {} : { bot }),
    ...(user === undefined ? {} : { user }),
  })
}

/** Project a configured principal into the credential-free action identity boundary. */
export function toFeishuActionIdentity(
  value: unknown,
  identityType: 'bot' | 'user',
): ActionIdentity {
  if (identityType !== 'bot' && identityType !== 'user') {
    throw fail('invalid_configuration', 'The Feishu identity type is invalid.')
  }
  const configuration = parseFeishuIdentityConfiguration(value)
  const identity = configuration[identityType]
  if (identity === undefined) {
    throw fail('identity_not_configured', 'The requested Feishu identity is not configured.')
  }
  return Object.freeze({
    connectorId: FEISHU_CONNECTOR_ID,
    accountId: configuration.accountId,
    identityType,
    displayName: identity.displayName,
  })
}

function storePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw fail('invalid_store_path', 'The Feishu identity store path is invalid.')
  }
  return value
}

async function existingFileIsSafe(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw fail('unsafe_file', 'The Feishu identity store is not a regular file.')
    }
    if (stats.size > MAX_CONFIGURATION_BYTES) {
      throw fail('configuration_too_large', 'The Feishu identity configuration is too large.')
    }
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export class FeishuIdentityConfigurationStore {
  readonly #filePath: string

  constructor(filePath: string) {
    this.#filePath = storePath(filePath)
  }

  async read(): Promise<FeishuIdentityConfiguration | undefined> {
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
          throw fail('unsafe_file', 'The Feishu identity store is not a regular file.')
        }
        throw error
      }
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw fail('unsafe_file', 'The Feishu identity store is not a regular file.')
      }
      if (stats.size > MAX_CONFIGURATION_BYTES) {
        throw fail('configuration_too_large', 'The Feishu identity configuration is too large.')
      }
      const document = await handle.readFile()
      let value: unknown
      try {
        value = JSON.parse(document.toString('utf8')) as unknown
      } catch {
        throw fail('invalid_configuration', 'The Feishu identity configuration is invalid JSON.')
      }
      return parseFeishuIdentityConfiguration(value)
    } catch (error) {
      if (error instanceof FeishuIdentityConfigurationError) throw error
      throw fail('io_error', 'The Feishu identity configuration could not be read.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async write(value: unknown): Promise<FeishuIdentityConfiguration> {
    const configuration = parseFeishuIdentityConfiguration(value)
    const document = `${JSON.stringify(configuration, null, 2)}\n`
    if (Buffer.byteLength(document) > MAX_CONFIGURATION_BYTES) {
      throw fail('configuration_too_large', 'The Feishu identity configuration is too large.')
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
      return configuration
    } catch (error) {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
      if (error instanceof FeishuIdentityConfigurationError) throw error
      throw fail('io_error', 'The Feishu identity configuration could not be stored.')
    }
  }
}
