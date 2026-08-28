import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { parseIsoTimestamp } from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import {
  FeishuCredentialBundleParser,
  type FeishuUserOAuthCredentialBundle,
} from './credential-bundle.ts'
import { FeishuOAuthCredentialBundleEncoder } from './oauth-credential-bundle-encoder.ts'
import { FeishuOAuthV3RefreshError, FeishuOAuthV3TokenRefresher } from './oauth-v3-token-refresh.ts'
import {
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
} from './system-keychain.ts'

export const FEISHU_OAUTH_ROTATION_JOURNAL_VERSION = 2 as const
export const FEISHU_OAUTH_ROTATION_JOURNAL_LEGACY_VERSION = 1 as const
export const FEISHU_OAUTH_ROTATION_JOURNAL_MAX_BYTES = 1024 * 1024

export type FeishuOAuthRotationState =
  'reserved' | 'completed' | 'uncertain' | 'reauthorization_required' | 'reauthorized'

export interface FeishuOAuthRotationSnapshot {
  readonly kind: 'feishu_oauth_rotation_event'
  readonly schemaVersion:
    | typeof FEISHU_OAUTH_ROTATION_JOURNAL_LEGACY_VERSION
    | typeof FEISHU_OAUTH_ROTATION_JOURNAL_VERSION
  readonly sequence: number
  readonly state: FeishuOAuthRotationState
  readonly sourceObtainedAt: string
  readonly recordedAt: string
  readonly resultObtainedAt?: string
}

export type FeishuOAuthRotationErrorCode =
  | 'invalid_request'
  | 'invalid_store_path'
  | 'unsafe_file'
  | 'journal_too_large'
  | 'journal_unavailable'
  | 'rotation_pending'
  | 'rotation_uncertain'
  | 'reauthorization_required'
  | 'reauthorization_not_pending'

export class FeishuOAuthRotationError extends Error {
  readonly code: FeishuOAuthRotationErrorCode

  constructor(code: FeishuOAuthRotationErrorCode, message: string) {
    super(message)
    this.name = 'FeishuOAuthRotationError'
    this.code = code
  }
}

interface JournalState {
  loaded: boolean
  latest: FeishuOAuthRotationSnapshot | undefined
  activeSequence: number | undefined
  queue: Promise<void>
}

const JOURNAL_STATES = new Map<string, JournalState>()

function fail(code: FeishuOAuthRotationErrorCode, message: string): FeishuOAuthRotationError {
  return new FeishuOAuthRotationError(code, message)
}

function instant(value: unknown): string {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth rotation timestamp is invalid.')
  }
}

function parseEvent(value: unknown): FeishuOAuthRotationSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('unsafe_file', 'The Feishu OAuth rotation journal contains invalid data.')
  }
  const record = value as Record<string, unknown>
  const state = record.state
  const expected =
    state === 'completed' || state === 'reauthorized'
      ? [
          'kind',
          'schemaVersion',
          'sequence',
          'state',
          'sourceObtainedAt',
          'recordedAt',
          'resultObtainedAt',
        ]
      : ['kind', 'schemaVersion', 'sequence', 'state', 'sourceObtainedAt', 'recordedAt']
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    record.kind !== 'feishu_oauth_rotation_event' ||
    (record.schemaVersion !== FEISHU_OAUTH_ROTATION_JOURNAL_LEGACY_VERSION &&
      record.schemaVersion !== FEISHU_OAUTH_ROTATION_JOURNAL_VERSION) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) <= 0 ||
    !['reserved', 'completed', 'uncertain', 'reauthorization_required', 'reauthorized'].includes(
      state as string,
    ) ||
    (record.schemaVersion === FEISHU_OAUTH_ROTATION_JOURNAL_LEGACY_VERSION &&
      state === 'reauthorized')
  ) {
    throw fail('unsafe_file', 'The Feishu OAuth rotation journal contains invalid data.')
  }
  let sourceObtainedAt: string
  let recordedAt: string
  let resultObtainedAt: string | undefined
  try {
    sourceObtainedAt = instant(record.sourceObtainedAt)
    recordedAt = instant(record.recordedAt)
    resultObtainedAt =
      state === 'completed' || state === 'reauthorized'
        ? instant(record.resultObtainedAt)
        : undefined
  } catch {
    throw fail('unsafe_file', 'The Feishu OAuth rotation journal contains invalid data.')
  }
  if (
    Date.parse(recordedAt) < Date.parse(sourceObtainedAt) ||
    (resultObtainedAt !== undefined &&
      (Date.parse(resultObtainedAt) <= Date.parse(sourceObtainedAt) ||
        (record.schemaVersion === FEISHU_OAUTH_ROTATION_JOURNAL_VERSION &&
          Date.parse(recordedAt) < Date.parse(resultObtainedAt))))
  ) {
    throw fail('unsafe_file', 'The Feishu OAuth rotation journal contains invalid data.')
  }
  return Object.freeze({
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: record.schemaVersion as 1 | 2,
    sequence: record.sequence as number,
    state: state as FeishuOAuthRotationState,
    sourceObtainedAt,
    recordedAt,
    ...(resultObtainedAt === undefined ? {} : { resultObtainedAt }),
  })
}

function validateTransition(
  previous: FeishuOAuthRotationSnapshot | undefined,
  next: FeishuOAuthRotationSnapshot,
): void {
  if (previous === undefined) {
    if (next.sequence !== 1 || next.state !== 'reserved') throw new TypeError()
    return
  }
  if (previous.state === 'completed' || previous.state === 'reauthorized') {
    if (next.sequence !== previous.sequence + 1 || next.state !== 'reserved') throw new TypeError()
    if (Date.parse(next.sourceObtainedAt) < Date.parse(previous.resultObtainedAt as string)) {
      throw new TypeError()
    }
    return
  }
  const allowed =
    previous.state === 'reserved'
      ? ['completed', 'uncertain', 'reauthorization_required']
      : previous.state === 'uncertain'
        ? ['completed']
        : previous.state === 'reauthorization_required'
          ? ['reauthorized']
          : []
  if (
    next.sequence !== previous.sequence ||
    next.sourceObtainedAt !== previous.sourceObtainedAt ||
    !allowed.includes(next.state)
  ) {
    throw new TypeError()
  }
}

function journalPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw fail('invalid_store_path', 'The Feishu OAuth rotation journal path is invalid.')
  }
  return resolve(value)
}

function sharedState(filePath: string): JournalState {
  const existing = JOURNAL_STATES.get(filePath)
  if (existing !== undefined) return existing
  const created: JournalState = {
    loaded: false,
    latest: undefined,
    activeSequence: undefined,
    queue: Promise.resolve(),
  }
  JOURNAL_STATES.set(filePath, created)
  return created
}

/**
 * Append-only, secret-free refresh-rotation evidence. Instances using the same
 * path serialize operations inside one Host process.
 */
export class FeishuOAuthRotationJournal {
  readonly #filePath: string
  readonly #state: JournalState

  constructor(filePath: string) {
    this.#filePath = journalPath(filePath)
    this.#state = sharedState(this.#filePath)
  }

  #serialize<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#state.queue.then(operation, operation)
    this.#state.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #load(): Promise<void> {
    if (this.#state.loaded) return
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      try {
        handle = await open(this.#filePath, constants.O_RDWR | constants.O_NOFOLLOW)
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null
            ? Object.getOwnPropertyDescriptor(error, 'code')?.value
            : undefined
        if (code === 'ENOENT') {
          this.#state.loaded = true
          return
        }
        if (code === 'ELOOP') {
          throw fail('unsafe_file', 'The Feishu OAuth rotation journal is not a regular file.')
        }
        throw error
      }
      const stats = await handle.stat()
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw fail('unsafe_file', 'The Feishu OAuth rotation journal is not a private file.')
      }
      if (stats.size > FEISHU_OAUTH_ROTATION_JOURNAL_MAX_BYTES) {
        throw fail('journal_too_large', 'The Feishu OAuth rotation journal is too large.')
      }
      let document = await handle.readFile()
      if (document.length > 0 && document.at(-1) !== 0x0a) {
        const lastLineEnd = document.lastIndexOf(0x0a)
        const repairedLength = lastLineEnd < 0 ? 0 : lastLineEnd + 1
        await handle.truncate(repairedLength)
        await handle.sync()
        document = document.subarray(0, repairedLength)
      }
      const lines = document.toString('utf8').split('\n')
      lines.pop()
      let latest: FeishuOAuthRotationSnapshot | undefined
      for (const line of lines) {
        if (line.length === 0) throw new TypeError()
        const event = parseEvent(JSON.parse(line) as unknown)
        validateTransition(latest, event)
        latest = event
      }
      this.#state.latest = latest
      this.#state.loaded = true
    } catch (error) {
      if (error instanceof FeishuOAuthRotationError) throw error
      throw fail('journal_unavailable', 'The Feishu OAuth rotation journal could not be read.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #append(event: FeishuOAuthRotationSnapshot): Promise<void> {
    const line = `${JSON.stringify(event)}\n`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 })
      handle = await open(
        this.#filePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      const stats = await handle.stat()
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw fail('unsafe_file', 'The Feishu OAuth rotation journal is not a private file.')
      }
      if (stats.size + Buffer.byteLength(line) > FEISHU_OAUTH_ROTATION_JOURNAL_MAX_BYTES) {
        throw fail('journal_too_large', 'The Feishu OAuth rotation journal is too large.')
      }
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } catch (error) {
      if (error instanceof FeishuOAuthRotationError) throw error
      throw fail('journal_unavailable', 'The Feishu OAuth rotation event could not be committed.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  inspect(): Promise<FeishuOAuthRotationSnapshot | undefined> {
    return this.#serialize(async () => {
      await this.#load()
      return this.#state.latest
    })
  }

  isActiveReservation(sequence: number): boolean {
    return this.#state.activeSequence === sequence
  }

  reserve(
    sourceObtainedAtValue: string,
    recordedAtValue: string,
  ): Promise<FeishuOAuthRotationSnapshot> {
    return this.#serialize(async () => {
      await this.#load()
      const sourceObtainedAt = instant(sourceObtainedAtValue)
      const recordedAt = instant(recordedAtValue)
      if (Date.parse(recordedAt) < Date.parse(sourceObtainedAt)) {
        throw fail('invalid_request', 'The Feishu OAuth rotation chronology is invalid.')
      }
      const latest = this.#state.latest
      if (latest !== undefined && latest.state !== 'completed' && latest.state !== 'reauthorized') {
        throw fail('rotation_pending', 'A Feishu OAuth rotation already requires reconciliation.')
      }
      const event = parseEvent({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: FEISHU_OAUTH_ROTATION_JOURNAL_VERSION,
        sequence: (latest?.sequence ?? 0) + 1,
        state: 'reserved',
        sourceObtainedAt,
        recordedAt,
      })
      try {
        validateTransition(latest, event)
      } catch {
        throw fail('invalid_request', 'The Feishu OAuth rotation chronology is invalid.')
      }
      await this.#append(event)
      this.#state.latest = event
      this.#state.activeSequence = event.sequence
      return event
    })
  }

  settle(
    sequence: number,
    state: Exclude<FeishuOAuthRotationState, 'reserved'>,
    recordedAtValue: string,
    resultObtainedAtValue?: string,
  ): Promise<FeishuOAuthRotationSnapshot> {
    return this.#serialize(async () => {
      await this.#load()
      const latest = this.#state.latest
      if (
        latest === undefined ||
        latest.state === 'completed' ||
        latest.state === 'reauthorized' ||
        latest.sequence !== sequence ||
        (state === 'completed' || state === 'reauthorized') !==
          (resultObtainedAtValue !== undefined)
      ) {
        throw fail('invalid_request', 'The Feishu OAuth rotation settlement is invalid.')
      }
      const event = parseEvent({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: FEISHU_OAUTH_ROTATION_JOURNAL_VERSION,
        sequence,
        state,
        sourceObtainedAt: latest.sourceObtainedAt,
        recordedAt: instant(recordedAtValue),
        ...(resultObtainedAtValue === undefined
          ? {}
          : { resultObtainedAt: instant(resultObtainedAtValue) }),
      })
      try {
        validateTransition(latest, event)
      } catch {
        throw fail('invalid_request', 'The Feishu OAuth rotation settlement is invalid.')
      }
      await this.#append(event)
      this.#state.latest = event
      this.#state.activeSequence = undefined
      return event
    })
  }

  replaceAfterReauthorization(
    replace: (
      blocked: FeishuOAuthRotationSnapshot,
    ) => Promise<Readonly<{ recordedAt: string; resultObtainedAt: string }>>,
  ): Promise<FeishuOAuthRotationSnapshot> {
    if (typeof replace !== 'function') {
      throw fail('invalid_request', 'The Feishu OAuth reauthorization replacement is invalid.')
    }
    return this.#serialize(async () => {
      await this.#load()
      const latest = this.#state.latest
      if (latest?.state !== 'reauthorization_required') {
        throw fail(
          'reauthorization_not_pending',
          'No Feishu OAuth reauthorization replacement is pending.',
        )
      }
      const replacementValue = await replace(latest)
      let replacement: Readonly<{ recordedAt: string; resultObtainedAt: string }>
      try {
        if (
          typeof replacementValue !== 'object' ||
          replacementValue === null ||
          Array.isArray(replacementValue)
        ) {
          throw new TypeError()
        }
        const prototype = Object.getPrototypeOf(replacementValue) as unknown
        const descriptors = Object.getOwnPropertyDescriptors(replacementValue)
        if (
          (prototype !== Object.prototype && prototype !== null) ||
          Object.getOwnPropertySymbols(replacementValue).length !== 0 ||
          Object.keys(descriptors).length !== 2 ||
          !['recordedAt', 'resultObtainedAt'].every((key) => Object.hasOwn(descriptors, key)) ||
          Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
        ) {
          throw new TypeError()
        }
        replacement = Object.freeze({
          recordedAt: instant(descriptors.recordedAt?.value),
          resultObtainedAt: instant(descriptors.resultObtainedAt?.value),
        })
      } catch (error) {
        if (error instanceof FeishuOAuthRotationError) throw error
        throw fail('invalid_request', 'The Feishu OAuth reauthorization evidence is invalid.')
      }
      const event = parseEvent({
        kind: 'feishu_oauth_rotation_event',
        schemaVersion: FEISHU_OAUTH_ROTATION_JOURNAL_VERSION,
        sequence: latest.sequence,
        state: 'reauthorized',
        sourceObtainedAt: latest.sourceObtainedAt,
        recordedAt: replacement.recordedAt,
        resultObtainedAt: replacement.resultObtainedAt,
      })
      try {
        validateTransition(latest, event)
      } catch {
        throw fail('invalid_request', 'The Feishu OAuth reauthorization chronology is invalid.')
      }
      await this.#append(event)
      this.#state.latest = event
      this.#state.activeSequence = undefined
      return event
    })
  }
}

export interface FeishuOAuthRotationCoordinatorOptions {
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly refresher: FeishuOAuthV3TokenRefresher
  readonly replacer: FeishuSystemKeychainSecretReplacer
  readonly journal: FeishuOAuthRotationJournal
  readonly now?: () => number
}

export interface FeishuOAuthRotationResult {
  readonly status: 'not_required' | 'rotated' | 'recovered' | 'reauthorized'
  readonly obtainedAt: string
}

function coordinatorOptions(value: unknown): Readonly<{
  resolver: FeishuSystemKeychainSecretResolver
  refresher: FeishuOAuthV3TokenRefresher
  replacer: FeishuSystemKeychainSecretReplacer
  journal: FeishuOAuthRotationJournal
  now: () => number
}> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => !['resolver', 'refresher', 'replacer', 'journal', 'now'].includes(key)) ||
      ['resolver', 'refresher', 'replacer', 'journal'].some(
        (key) => !Object.hasOwn(descriptors, key),
      ) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const resolver = descriptors.resolver?.value
    const refresher = descriptors.refresher?.value
    const replacer = descriptors.replacer?.value
    const journal = descriptors.journal?.value
    const now = Object.hasOwn(descriptors, 'now') ? descriptors.now?.value : Date.now
    if (
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(refresher instanceof FeishuOAuthV3TokenRefresher) ||
      !(replacer instanceof FeishuSystemKeychainSecretReplacer) ||
      !(journal instanceof FeishuOAuthRotationJournal) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ resolver, refresher, replacer, journal, now })
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth rotation coordinator is invalid.')
  }
}

function observedAt(now: () => number): string {
  let value: number
  try {
    value = now()
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth rotation clock is invalid.')
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw fail('invalid_request', 'The Feishu OAuth rotation clock is invalid.')
  }
  try {
    return parseIsoTimestamp(new Date(value).toISOString())
  } catch {
    throw fail('invalid_request', 'The Feishu OAuth rotation clock is invalid.')
  }
}

/**
 * Single-Host refresh coordinator. Durable reservation precedes the remote
 * call, and any unproven post-reservation outcome blocks reuse of the old token.
 */
export class FeishuOAuthRotationCoordinator {
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #refresher: FeishuOAuthV3TokenRefresher
  readonly #replacer: FeishuSystemKeychainSecretReplacer
  readonly #journal: FeishuOAuthRotationJournal
  readonly #now: () => number
  readonly #parser: FeishuCredentialBundleParser
  readonly #encoder = new FeishuOAuthCredentialBundleEncoder()

  constructor(options: FeishuOAuthRotationCoordinatorOptions) {
    const validated = coordinatorOptions(options)
    this.#resolver = validated.resolver
    this.#refresher = validated.refresher
    this.#replacer = validated.replacer
    this.#journal = validated.journal
    this.#now = validated.now
    this.#parser = new FeishuCredentialBundleParser({ now: this.#now })
  }

  async refreshIfNeeded(
    configurationValue: unknown,
    signal: AbortSignal,
  ): Promise<FeishuOAuthRotationResult> {
    signal.throwIfAborted()
    let configuration: FeishuIdentityConfiguration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail('invalid_request', 'The Feishu OAuth rotation configuration is invalid.')
    }
    const user = configuration.user
    if (user === undefined) {
      throw fail('invalid_request', 'The Feishu OAuth User identity is not configured.')
    }
    const pending = await this.#journal.inspect()
    return this.#resolver.withSecret(user.credentialReference, signal, (bundle) =>
      this.#parser.withCredential(configuration, 'user', bundle, signal, async (value) => {
        if (value.kind !== 'feishu_user_oauth_credential_bundle') {
          throw fail('invalid_request', 'The Feishu OAuth credential identity is invalid.')
        }
        return this.#withCredential(configuration, value, pending, signal)
      }),
    )
  }

  async #withCredential(
    configuration: FeishuIdentityConfiguration,
    credential: FeishuUserOAuthCredentialBundle,
    latest: FeishuOAuthRotationSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<FeishuOAuthRotationResult> {
    if (latest !== undefined && latest.state !== 'completed' && latest.state !== 'reauthorized') {
      if (latest.state === 'reserved' && this.#journal.isActiveReservation(latest.sequence)) {
        throw fail('rotation_pending', 'A Feishu OAuth rotation is already in progress.')
      }
      if (Date.parse(credential.obtainedAt) > Date.parse(latest.sourceObtainedAt)) {
        const reauthorized = latest.state === 'reauthorization_required'
        await this.#journal.settle(
          latest.sequence,
          reauthorized ? 'reauthorized' : 'completed',
          observedAt(this.#now),
          credential.obtainedAt,
        )
        return Object.freeze({
          status: reauthorized ? 'reauthorized' : 'recovered',
          obtainedAt: credential.obtainedAt,
        })
      }
      if (latest.state === 'reserved') {
        await this.#journal.settle(latest.sequence, 'uncertain', observedAt(this.#now))
      }
      throw fail(
        latest.state === 'reauthorization_required'
          ? 'reauthorization_required'
          : 'rotation_uncertain',
        latest.state === 'reauthorization_required'
          ? 'The Feishu User authorization must be renewed.'
          : 'The Feishu OAuth rotation outcome requires Keychain reconciliation.',
      )
    }
    if (
      latest?.resultObtainedAt !== undefined &&
      Date.parse(credential.obtainedAt) < Date.parse(latest.resultObtainedAt)
    ) {
      throw fail('rotation_uncertain', 'The Feishu OAuth credential state has regressed.')
    }
    if (credential.accessTokenStatus === 'usable') {
      return Object.freeze({ status: 'not_required', obtainedAt: credential.obtainedAt })
    }

    const reservation = await this.#journal.reserve(credential.obtainedAt, observedAt(this.#now))
    let resultObtainedAt: string
    try {
      resultObtainedAt = await this.#refresher.refresh(
        {
          clientId: credential.appId,
          clientSecret: credential.clientSecret,
          refreshToken: credential.refreshToken,
        },
        signal,
        (tokenSet) =>
          this.#encoder.withEncodedBundle(credential, tokenSet, signal, (encoded) =>
            this.#replacer
              .replace(configuration.user!.credentialReference, encoded, signal)
              .then(() => tokenSet.obtainedAt),
          ),
      )
    } catch (error) {
      const reauthorization =
        error instanceof FeishuOAuthV3RefreshError && error.code === 'reauthorization_required'
      await this.#journal.settle(
        reservation.sequence,
        reauthorization ? 'reauthorization_required' : 'uncertain',
        observedAt(this.#now),
      )
      if (signal.aborted) signal.throwIfAborted()
      throw fail(
        reauthorization ? 'reauthorization_required' : 'rotation_uncertain',
        reauthorization
          ? 'The Feishu User authorization must be renewed.'
          : 'The Feishu OAuth rotation outcome requires Keychain reconciliation.',
      )
    }
    try {
      await this.#journal.settle(
        reservation.sequence,
        'completed',
        observedAt(this.#now),
        resultObtainedAt,
      )
    } catch {
      throw fail(
        'rotation_uncertain',
        'The Feishu OAuth rotation outcome requires Keychain reconciliation.',
      )
    }
    return Object.freeze({ status: 'rotated', obtainedAt: resultObtainedAt })
  }
}
