import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'

import { parseFeishuIdentityConfiguration } from './identity-configuration.ts'

// This namespace is a cross-version safety identity. Never change it without
// also acquiring the endpoint derived by every previously released build.
const LEASE_NAMESPACE = 'twindesk:feishu-runtime-owner'
const LEASE_PORT_START = 43_000
const LEASE_PORT_COUNT = 1_000

export type FeishuRuntimeLeaseErrorCode =
  'invalid_request' | 'lease_unavailable' | 'lease_lost' | 'io_error' | 'cancelled'

export type FeishuRuntimeLeaseRecovery =
  'do_not_retry' | 'retry_after_owner_exit' | 'stop_connector'

export class FeishuRuntimeLeaseError extends Error {
  readonly code: FeishuRuntimeLeaseErrorCode
  readonly recovery: FeishuRuntimeLeaseRecovery

  constructor(
    code: FeishuRuntimeLeaseErrorCode,
    recovery: FeishuRuntimeLeaseRecovery,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuRuntimeLeaseError'
    this.code = code
    this.recovery = recovery
  }
}

export interface FeishuRuntimeLease {
  /** Check immediately before starting polling, refresh, or an external write. */
  assertHeld(): void
}

type LeaseAddress = Readonly<{ host: string; port: number }>

function fail(
  code: FeishuRuntimeLeaseErrorCode,
  recovery: FeishuRuntimeLeaseRecovery,
  message: string,
): FeishuRuntimeLeaseError {
  return new FeishuRuntimeLeaseError(code, recovery, message)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined
}

function cancelled(): FeishuRuntimeLeaseError {
  return fail('cancelled', 'stop_connector', 'The Feishu runtime lease request was cancelled.')
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

function leaseAddress(): LeaseAddress {
  const digest = createHash('sha256').update(LEASE_NAMESPACE).digest()
  const portBits = ((digest[0] as number) << 8) | (digest[1] as number)
  return Object.freeze({
    host: '127.0.0.1',
    port: LEASE_PORT_START + (portBits % LEASE_PORT_COUNT),
  })
}

class OwnedFeishuRuntimeLease implements FeishuRuntimeLease {
  readonly #server: Server
  #active = true

  constructor(server: Server) {
    this.#server = server
    server.on('error', () => {
      this.#active = false
    })
  }

  assertHeld(): void {
    if (!this.#active || !this.#server.listening) {
      throw fail('lease_lost', 'stop_connector', 'The Feishu runtime lease is no longer held.')
    }
  }

  async release(): Promise<void> {
    this.#active = false
    if (!this.#server.listening) return
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}

async function acquire(
  address: LeaseAddress,
  signal: AbortSignal,
): Promise<OwnedFeishuRuntimeLease> {
  throwIfCancelled(signal)
  const server = createServer((socket) => socket.destroy())
  const owned = await new Promise<OwnedFeishuRuntimeLease>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      server.removeListener('error', onError)
      server.removeListener('listening', onListening)
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const onAbort = (): void => {
      finish(() => reject(cancelled()))
      server.close(() => undefined)
    }
    const onError = (error: Error): void => {
      finish(() => {
        if (errorCode(error) === 'EADDRINUSE') {
          reject(
            fail(
              'lease_unavailable',
              'retry_after_owner_exit',
              'The Feishu runtime lease endpoint is already in use.',
            ),
          )
        } else {
          reject(fail('io_error', 'do_not_retry', 'The Feishu runtime lease could not start.'))
        }
      })
    }
    const onListening = (): void => finish(() => resolve(new OwnedFeishuRuntimeLease(server)))

    signal.addEventListener('abort', onAbort, { once: true })
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: address.host, port: address.port, exclusive: true })
  })
  if (signal.aborted) {
    await owned.release()
    throw cancelled()
  }
  return owned
}

/**
 * Hold the one kernel-backed loopback lease for every Feishu Connector in this
 * Host for the complete callback lifetime. A single process may own multiple
 * configured Feishu accounts under this lease. The lease never grants
 * authority; callers must still run normal identity, policy, approval, scope,
 * and idempotency checks.
 */
export class FeishuRuntimeLeaseManager {
  async withLease<TResult>(
    configurationValue: unknown,
    signal: AbortSignal,
    use: (lease: FeishuRuntimeLease) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    throwIfCancelled(signal)
    if (typeof use !== 'function') {
      throw fail('invalid_request', 'do_not_retry', 'The Feishu runtime lease consumer is invalid.')
    }
    try {
      parseFeishuIdentityConfiguration(configurationValue)
    } catch {
      throw fail(
        'invalid_request',
        'do_not_retry',
        'The Feishu runtime lease identity configuration is invalid.',
      )
    }
    const owned = await acquire(leaseAddress(), signal)
    try {
      throwIfCancelled(signal)
      owned.assertHeld()
      return await use(owned)
    } finally {
      await owned.release()
    }
  }
}
