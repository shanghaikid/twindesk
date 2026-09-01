import {
  FeishuOAuthInitialCredentialPersister,
  FeishuOAuthInitialPersistenceError,
  type FeishuOAuthInitialPersistenceResult,
} from './oauth-initial-credential-persistence.ts'
import {
  FeishuOAuthRotationError,
  FeishuOAuthRotationJournal,
} from './oauth-rotation-coordinator.ts'
import type { FeishuOAuthV3TokenSet } from './oauth-v3-token-refresh.ts'

export type FeishuOAuthReauthorizationErrorCode =
  | 'invalid_request'
  | 'reauthorization_not_pending'
  | 'authorization_failed'
  | 'persistence_unavailable'
  | 'persistence_uncertain'
  | 'journal_unavailable'
  | 'journal_uncertain'

export type FeishuOAuthReauthorizationRecovery =
  'do_not_retry' | 'reauthorize' | 'reconcile_keychain' | 'reconcile_rotation'

export class FeishuOAuthReauthorizationError extends Error {
  readonly code: FeishuOAuthReauthorizationErrorCode
  readonly recovery: FeishuOAuthReauthorizationRecovery

  constructor(
    code: FeishuOAuthReauthorizationErrorCode,
    recovery: FeishuOAuthReauthorizationRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOAuthReauthorizationError'
    this.code = code
    this.recovery = recovery
  }
}

export interface FeishuOAuthReauthorizationCoordinatorOptions {
  readonly persister: FeishuOAuthInitialCredentialPersister
  readonly journal: FeishuOAuthRotationJournal
  readonly now?: () => number
}

export interface FeishuOAuthReauthorizationResult {
  readonly status: 'reauthorized'
  readonly obtainedAt: string
}

function fail(
  code: FeishuOAuthReauthorizationErrorCode,
  recovery: FeishuOAuthReauthorizationRecovery,
  message: string,
): FeishuOAuthReauthorizationError {
  return new FeishuOAuthReauthorizationError(code, recovery, message)
}

function options(value: unknown): Readonly<{
  persister: FeishuOAuthInitialCredentialPersister
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
      keys.length < 2 ||
      keys.length > 3 ||
      keys.some((key) => !['persister', 'journal', 'now'].includes(key)) ||
      !['persister', 'journal'].every((key) => Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const persister = descriptors.persister?.value
    const journal = descriptors.journal?.value
    const now = Object.hasOwn(descriptors, 'now') ? descriptors.now?.value : Date.now
    if (
      !(persister instanceof FeishuOAuthInitialCredentialPersister) ||
      !(journal instanceof FeishuOAuthRotationJournal) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ persister, journal, now })
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth reauthorization is invalid.')
  }
}

function observedAt(now: () => number): string {
  let value: number
  try {
    value = now()
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The reauthorization clock is invalid.')
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw fail('invalid_request', 'do_not_retry', 'The reauthorization clock is invalid.')
  }
  try {
    return new Date(value).toISOString()
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The reauthorization clock is invalid.')
  }
}

function mapPersistence(error: FeishuOAuthInitialPersistenceError): never {
  if (
    error.code === 'identity_mismatch' ||
    error.code === 'reauthorization_required' ||
    error.code === 'verification_unavailable'
  ) {
    throw fail(
      'authorization_failed',
      'reauthorize',
      'The replacement Feishu User authorization could not be verified.',
    )
  }
  if (error.code === 'persistence_uncertain') {
    throw fail(
      'persistence_uncertain',
      'reconcile_keychain',
      'The replacement Feishu credential write outcome is uncertain.',
    )
  }
  if (error.code === 'persistence_unavailable') {
    throw fail(
      'persistence_unavailable',
      'do_not_retry',
      'The replacement Feishu credential could not be persisted.',
    )
  }
  throw fail('invalid_request', 'do_not_retry', 'The replacement Feishu credential is invalid.')
}

/**
 * Replace a durably blocked User authorization, then append an explicit
 * `reauthorized` terminal event. The journal serializes the full callback so a
 * second same-Host replacement cannot reach principal verification or
 * Keychain persistence.
 */
export class FeishuOAuthReauthorizationCoordinator {
  readonly #persister: FeishuOAuthInitialCredentialPersister
  readonly #journal: FeishuOAuthRotationJournal
  readonly #now: () => number

  constructor(value: FeishuOAuthReauthorizationCoordinatorOptions) {
    const validated = options(value)
    this.#persister = validated.persister
    this.#journal = validated.journal
    this.#now = validated.now
  }

  async #restoreBlockedState(sequence: number): Promise<void> {
    try {
      const latest = await this.#journal.inspect()
      if (latest?.sequence !== sequence || latest.state !== 'reauthorization_reserved') {
        throw new TypeError()
      }
      await this.#journal.settle(sequence, 'reauthorization_required', observedAt(this.#now))
    } catch {
      throw fail(
        'journal_uncertain',
        'reconcile_rotation',
        'The Feishu OAuth reauthorization reservation requires reconciliation.',
      )
    }
  }

  async replace(
    configurationValue: unknown,
    clientSecretValue: Uint8Array,
    tokenSetValue: FeishuOAuthV3TokenSet,
    signal: AbortSignal,
  ): Promise<FeishuOAuthReauthorizationResult> {
    signal.throwIfAborted()
    let persisted: FeishuOAuthInitialPersistenceResult | undefined
    let reservedSequence: number | undefined
    try {
      const snapshot = await this.#journal.replaceAfterReauthorization(
        observedAt(this.#now),
        async (blocked) => {
          reservedSequence = blocked.sequence
          const recordedAt = observedAt(this.#now)
          if (Date.parse(recordedAt) < Date.parse(blocked.sourceObtainedAt)) {
            throw fail('invalid_request', 'do_not_retry', 'The reauthorization clock is invalid.')
          }
          persisted = await this.#persister.persistWithResult(
            configurationValue,
            clientSecretValue,
            tokenSetValue,
            signal,
            Object.freeze({
              mustBeNewerThan: blocked.sourceObtainedAt,
              mustNotBeNewerThan: recordedAt,
            }),
          )
          return Object.freeze({ recordedAt, resultObtainedAt: persisted.obtainedAt })
        },
      )
      return Object.freeze({ status: 'reauthorized', obtainedAt: snapshot.resultObtainedAt! })
    } catch (error) {
      if (persisted !== undefined) {
        throw fail(
          'journal_uncertain',
          'reconcile_rotation',
          'The replacement credential is durable but its rotation journal outcome is uncertain.',
        )
      }
      if (error instanceof FeishuOAuthReauthorizationError) {
        if (reservedSequence !== undefined) await this.#restoreBlockedState(reservedSequence)
        throw error
      }
      if (error instanceof FeishuOAuthInitialPersistenceError) {
        if (error.code !== 'persistence_uncertain' && reservedSequence !== undefined) {
          await this.#restoreBlockedState(reservedSequence)
        }
        mapPersistence(error)
      }
      if (error instanceof FeishuOAuthRotationError) {
        if (error.code === 'reauthorization_not_pending') {
          throw fail(
            'reauthorization_not_pending',
            'do_not_retry',
            'No Feishu OAuth reauthorization replacement is pending.',
          )
        }
        throw fail(
          'journal_unavailable',
          'do_not_retry',
          'The Feishu OAuth rotation journal is unavailable.',
        )
      }
      if (signal.aborted) {
        if (reservedSequence !== undefined) await this.#restoreBlockedState(reservedSequence)
        signal.throwIfAborted()
      }
      throw fail(
        'persistence_unavailable',
        'do_not_retry',
        'The replacement Feishu credential could not be persisted.',
      )
    }
  }
}
