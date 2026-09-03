import type { Stats } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthAuthorizationConfigurationStore,
  FeishuOAuthRotationJournal,
} from '@twindesk/plugin-feishu'

export const WORKBENCH_LOCAL_DATA_PATHS_VERSION = 3 as const

export type WorkbenchLocalDataPathErrorCode =
  'invalid_options' | 'unsupported_platform' | 'unsafe_path' | 'io_error'

export class WorkbenchLocalDataPathError extends Error {
  readonly code: WorkbenchLocalDataPathErrorCode

  constructor(code: WorkbenchLocalDataPathErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchLocalDataPathError'
    this.code = code
  }
}

export interface WorkbenchLocalDataPathOptions {
  readonly platform?: NodeJS.Platform
  readonly homeDirectory?: string
}

export interface WorkbenchLocalDataPaths {
  readonly kind: 'workbench_local_data_paths'
  readonly schemaVersion: typeof WORKBENCH_LOCAL_DATA_PATHS_VERSION
  readonly platform: 'darwin'
  readonly rootDirectory: string
  readonly feishuSettingsDirectory: string
  readonly feishuStateDirectory: string
  readonly feishuIdentityConfiguration: string
  readonly feishuOAuthAuthorizationConfiguration: string
  readonly feishuOAuthRotationJournal: string
  readonly feishuBotEventReceipts: string
}

export interface WorkbenchFeishuSettingsStores {
  readonly paths: WorkbenchLocalDataPaths
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly authorizationStore: FeishuOAuthAuthorizationConfigurationStore
  readonly rotationJournal: FeishuOAuthRotationJournal
}

type UnknownRecord = Readonly<Record<string, unknown>>
const PRIVATE_DIRECTORY_MODE = 0o700
const EFFECTIVE_USER_ID = typeof process.getuid === 'function' ? process.getuid() : undefined

interface DirectoryIdentity {
  readonly path: string
  readonly device: number
  readonly inode: number
  readonly requirePrivate: boolean
}

function fail(code: WorkbenchLocalDataPathErrorCode, message: string): WorkbenchLocalDataPathError {
  return new WorkbenchLocalDataPathError(code, message)
}

function invalid(): WorkbenchLocalDataPathError {
  return fail('invalid_options', 'The Workbench local data path options are invalid.')
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (value === undefined) value = {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !['platform', 'homeDirectory'].includes(key)) ||
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

function homePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    dirname(value) === value
  ) {
    throw invalid()
  }
  return value
}

/** Resolve the fixed macOS product-data paths without touching the filesystem. */
export function resolveWorkbenchLocalDataPaths(
  optionsValue: WorkbenchLocalDataPathOptions = {},
): WorkbenchLocalDataPaths {
  const options = dataRecord(optionsValue)
  const platform = options.platform ?? process.platform
  if (typeof platform !== 'string') throw invalid()
  if (platform !== 'darwin') {
    throw fail(
      'unsupported_platform',
      'Workbench local data paths are not defined for this platform.',
    )
  }
  const homeDirectory = homePath(options.homeDirectory ?? homedir())
  const rootDirectory = join(homeDirectory, 'Library', 'Application Support', 'TwinDesk')
  const feishuSettingsDirectory = join(rootDirectory, 'settings', 'connectors', 'feishu')
  const feishuStateDirectory = join(rootDirectory, 'state', 'connectors', 'feishu')
  return Object.freeze({
    kind: 'workbench_local_data_paths',
    schemaVersion: WORKBENCH_LOCAL_DATA_PATHS_VERSION,
    platform: 'darwin',
    rootDirectory,
    feishuSettingsDirectory,
    feishuStateDirectory,
    feishuIdentityConfiguration: join(feishuSettingsDirectory, 'identity.v1.json'),
    feishuOAuthAuthorizationConfiguration: join(
      feishuSettingsDirectory,
      'oauth-authorization.v1.json',
    ),
    feishuOAuthRotationJournal: join(feishuStateDirectory, 'oauth-rotation.jsonl'),
    feishuBotEventReceipts: join(feishuStateDirectory, 'bot-event-receipts.jsonl'),
  })
}

function assertSafeDirectory(
  path: string,
  requirePrivate: boolean,
  stats: Stats,
): DirectoryIdentity {
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (EFFECTIVE_USER_ID !== undefined && stats.uid !== EFFECTIVE_USER_ID) ||
    (requirePrivate && (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw fail('unsafe_path', 'The Workbench local data path is unsafe.')
  }
  return Object.freeze({ path, device: stats.dev, inode: stats.ino, requirePrivate })
}

async function ensureDirectory(path: string, requirePrivate: boolean): Promise<DirectoryIdentity> {
  try {
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error
      }
    }
    const stats = await lstat(path)
    return assertSafeDirectory(path, requirePrivate, stats)
  } catch (error) {
    if (error instanceof WorkbenchLocalDataPathError) throw error
    throw fail('io_error', 'The Workbench local data directory could not be prepared.')
  }
}

async function assertDirectoryUnchanged(identity: DirectoryIdentity): Promise<void> {
  try {
    const stats = await lstat(identity.path)
    const current = assertSafeDirectory(identity.path, identity.requirePrivate, stats)
    if (current.device !== identity.device || current.inode !== identity.inode) {
      throw fail('unsafe_path', 'The Workbench local data path changed during preparation.')
    }
  } catch (error) {
    if (error instanceof WorkbenchLocalDataPathError) throw error
    throw fail('io_error', 'The Workbench local data directory could not be verified.')
  }
}

/** Prepare private fixed directories and construct non-secret Feishu Settings and state stores. */
export async function openWorkbenchFeishuSettingsStores(
  optionsValue: WorkbenchLocalDataPathOptions = {},
): Promise<WorkbenchFeishuSettingsStores> {
  const paths = resolveWorkbenchLocalDataPaths(optionsValue)
  const homeDirectory = dirname(dirname(dirname(paths.rootDirectory)))
  const rootSegments = ['Library', 'Application Support', 'TwinDesk']
  let current = homeDirectory
  const directories = [await ensureDirectory(current, false)]
  for (const [index, segment] of rootSegments.entries()) {
    current = join(current, segment)
    directories.push(await ensureDirectory(current, index >= 2))
  }
  if (current !== paths.rootDirectory) {
    throw fail('unsafe_path', 'The Workbench local data path is unsafe.')
  }
  let settingsDirectory = current
  for (const segment of ['settings', 'connectors', 'feishu']) {
    settingsDirectory = join(settingsDirectory, segment)
    directories.push(await ensureDirectory(settingsDirectory, true))
  }
  let stateDirectory = current
  for (const segment of ['state', 'connectors', 'feishu']) {
    stateDirectory = join(stateDirectory, segment)
    directories.push(await ensureDirectory(stateDirectory, true))
  }
  if (
    settingsDirectory !== paths.feishuSettingsDirectory ||
    stateDirectory !== paths.feishuStateDirectory
  ) {
    throw fail('unsafe_path', 'The Workbench local data path is unsafe.')
  }
  for (const directory of directories) await assertDirectoryUnchanged(directory)
  return Object.freeze({
    paths,
    identityStore: new FeishuIdentityConfigurationStore(paths.feishuIdentityConfiguration),
    authorizationStore: new FeishuOAuthAuthorizationConfigurationStore(
      paths.feishuOAuthAuthorizationConfiguration,
    ),
    rotationJournal: new FeishuOAuthRotationJournal(paths.feishuOAuthRotationJournal),
  })
}
