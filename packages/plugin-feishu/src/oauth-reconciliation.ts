import { FeishuCredentialBundleError, FeishuCredentialBundleParser } from './credential-bundle.ts'
import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'
import {
  FeishuOAuthRotationError,
  FeishuOAuthRotationJournal,
  type FeishuOAuthRotationSnapshot,
} from './oauth-rotation-coordinator.ts'
import { FeishuSystemKeychainError, FeishuSystemKeychainSecretResolver } from './system-keychain.ts'

export type FeishuOAuthReconciliationErrorCode =
  | 'invalid_request'
  | 'reconciliation_not_pending'
  | 'reconciliation_active'
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'journal_unavailable'
  | 'journal_changed'

export type FeishuOAuthReconciliationRecovery =
  'do_not_retry' | 'repair_keychain' | 'retry_after_current_operation'

export class FeishuOAuthReconciliationError extends Error {
  readonly code: FeishuOAuthReconciliationErrorCode
  readonly recovery: FeishuOAuthReconciliationRecovery

  constructor(
    code: FeishuOAuthReconciliationErrorCode,
    recovery: FeishuOAuthReconciliationRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuOAuthReconciliationError'
    this.code = code
    this.recovery = recovery
  }
}

export type FeishuOAuthReconciliationResult =
  | Readonly<{ status: 'reconciled'; resolution: 'rotation' | 'reauthorization' }>
  | Readonly<{ status: 'still_required' }>

export interface FeishuOAuthReconcilerOptions {
  readonly resolver: FeishuSystemKeychainSecretResolver
  readonly journal: FeishuOAuthRotationJournal
  readonly now?: () => number
}

function fail(
  code: FeishuOAuthReconciliationErrorCode,
  recovery: FeishuOAuthReconciliationRecovery,
  message: string,
): FeishuOAuthReconciliationError {
  return new FeishuOAuthReconciliationError(code, recovery, message)
}

function readOptions(value: unknown): Readonly<Required<FeishuOAuthReconcilerOptions>> {
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
      keys.some((key) => !['resolver', 'journal', 'now'].includes(key)) ||
      !['resolver', 'journal'].every((key) => Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const resolver = descriptors.resolver?.value
    const journal = descriptors.journal?.value
    const now = descriptors.now?.value ?? Date.now
    if (
      !(resolver instanceof FeishuSystemKeychainSecretResolver) ||
      !(journal instanceof FeishuOAuthRotationJournal) ||
      typeof now !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ resolver, journal, now })
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The Feishu OAuth reconciliation is invalid.')
  }
}

function observedAt(now: () => number): string {
  try {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new TypeError()
    }
    return new Date(value).toISOString()
  } catch {
    throw fail('invalid_request', 'do_not_retry', 'The reconciliation clock is invalid.')
  }
}

type PendingSnapshot = FeishuOAuthRotationSnapshot &
  Readonly<{ state: 'reserved' | 'uncertain' | 'reauthorization_reserved' }>

function pending(snapshot: FeishuOAuthRotationSnapshot | undefined): snapshot is PendingSnapshot {
  return (
    snapshot?.state === 'reserved' ||
    snapshot?.state === 'uncertain' ||
    snapshot?.state === 'reauthorization_reserved'
  )
}

/**
 * Reconcile only local Keychain evidence against one unresolved journal event.
 * This class owns neither a refresh transport nor a Keychain replacer.
 */
export class FeishuOAuthReconciler {
  readonly #resolver: FeishuSystemKeychainSecretResolver
  readonly #journal: FeishuOAuthRotationJournal
  readonly #now: () => number
  readonly #parser: FeishuCredentialBundleParser

  constructor(value: FeishuOAuthReconcilerOptions) {
    const options = readOptions(value)
    this.#resolver = options.resolver
    this.#journal = options.journal
    this.#now = options.now
    this.#parser = new FeishuCredentialBundleParser({ now: options.now })
  }

  async reconcile(
    configurationValue: unknown,
    signal: AbortSignal,
  ): Promise<FeishuOAuthReconciliationResult> {
    signal.throwIfAborted()
    let configuration: FeishuIdentityConfiguration
    try {
      configuration = parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail('invalid_request', 'do_not_retry', 'The reconciliation identity is invalid.')
    }
    if (configuration.user === undefined) {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu User identity is not configured.')
    }
    let expected: FeishuOAuthRotationSnapshot | undefined
    try {
      expected = await this.#journal.inspect()
    } catch {
      throw fail('journal_unavailable', 'do_not_retry', 'The rotation journal is unavailable.')
    }
    if (!pending(expected)) {
      throw fail(
        'reconciliation_not_pending',
        'do_not_retry',
        'No Feishu OAuth reconciliation is pending.',
      )
    }
    if (expected.state === 'reserved' && this.#journal.isActiveReservation(expected.sequence)) {
      throw fail(
        'reconciliation_active',
        'retry_after_current_operation',
        'The Feishu OAuth operation is still active.',
      )
    }

    try {
      return await this.#resolver.withSecret(
        configuration.user.credentialReference,
        signal,
        (bundle) =>
          this.#parser.withUserCredentialEvidence(
            configuration,
            bundle,
            signal,
            async (evidence) => {
              if (
                evidence.refreshTokenStatus === 'expired' ||
                Date.parse(evidence.obtainedAt) <= Date.parse(expected.sourceObtainedAt)
              ) {
                return Object.freeze({ status: 'still_required' as const })
              }
              let latest: FeishuOAuthRotationSnapshot | undefined
              try {
                latest = await this.#journal.inspect()
              } catch {
                throw fail(
                  'journal_unavailable',
                  'do_not_retry',
                  'The rotation journal is unavailable.',
                )
              }
              if (
                latest?.sequence !== expected.sequence ||
                latest.state !== expected.state ||
                latest.sourceObtainedAt !== expected.sourceObtainedAt
              ) {
                throw fail(
                  'journal_changed',
                  'retry_after_current_operation',
                  'The rotation journal changed during reconciliation.',
                )
              }
              const reauthorization = latest.state === 'reauthorization_reserved'
              try {
                await this.#journal.settle(
                  latest.sequence,
                  reauthorization ? 'reauthorized' : 'completed',
                  observedAt(this.#now),
                  evidence.obtainedAt,
                )
              } catch {
                throw fail(
                  'journal_unavailable',
                  'do_not_retry',
                  'The reconciliation result could not be committed.',
                )
              }
              return Object.freeze({
                status: 'reconciled' as const,
                resolution: reauthorization ? ('reauthorization' as const) : ('rotation' as const),
              })
            },
          ),
      )
    } catch (error) {
      if (error instanceof FeishuOAuthReconciliationError) throw error
      if (signal.aborted) signal.throwIfAborted()
      if (error instanceof FeishuCredentialBundleError) {
        throw fail(
          'credential_invalid',
          'repair_keychain',
          'The configured Feishu credential is invalid.',
        )
      }
      if (error instanceof FeishuSystemKeychainError) {
        throw fail(
          'credential_unavailable',
          'repair_keychain',
          'The configured Feishu credential is unavailable.',
        )
      }
      if (error instanceof FeishuOAuthRotationError) {
        throw fail('journal_unavailable', 'do_not_retry', 'The rotation journal is unavailable.')
      }
      throw fail('credential_unavailable', 'repair_keychain', 'The credential check failed.')
    }
  }
}
