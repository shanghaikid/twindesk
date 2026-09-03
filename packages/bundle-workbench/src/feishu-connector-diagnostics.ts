import {
  FEISHU_USER_MESSAGE_STREAM,
  FeishuBotIdentityScopeHttpClient,
  FeishuBotKeychainScopeProbe,
  FeishuBotTenantTokenAcquirer,
  FeishuConnectorDiagnosticsService,
  FeishuDiagnosticsClientError,
  FeishuOperationScopeProbeClientError,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  requiredFeishuOperationScopes,
  type FeishuConnectorDiagnosticsClient,
  type FeishuIdentityConfiguration,
  type FeishuIdentityProbeRequest,
  type FeishuCursorProbeRequest,
  type FeishuOperationScopeProbeClient,
  type FeishuOperationScopeProbeRequest,
} from '@twindesk/plugin-feishu'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

import type { WorkbenchFeishuRuntimeStatus } from './feishu-runtime-supervisor.ts'

export type WorkbenchFeishuDiagnosticRecovery =
  'reauthorize' | 'grant_scope' | 'retry' | 'repair_configuration' | 'restart_host'

export interface WorkbenchFeishuConnectorDiagnosticsSnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly status: 'not_configured' | 'healthy' | 'degraded' | 'unavailable'
  readonly checkedAt: string | null
  readonly runtime: WorkbenchFeishuRuntimeStatus
  readonly identities: readonly Readonly<{
    identityType: 'bot' | 'user'
    status: 'ready' | 'attention_required' | 'unavailable'
    requiredScopes: readonly string[]
    missingScopes: readonly string[]
  }>[]
  readonly rateLimits: readonly Readonly<{
    identityType: 'bot' | 'user'
    status: 'available' | 'limited' | 'unknown'
    resetsAt?: string
  }>[]
  readonly cursors: readonly Readonly<{
    stream: string
    status: 'current' | 'stale' | 'future' | 'not_started' | 'unavailable'
    updatedAt?: string
    committedThrough?: string
  }>[]
  readonly issues: readonly Readonly<{
    code: string
    recovery: WorkbenchFeishuDiagnosticRecovery
  }>[]
}

export interface WorkbenchFeishuConnectorDiagnosticsPresentation {
  read(signal: AbortSignal): Promise<WorkbenchFeishuConnectorDiagnosticsSnapshot>
}

export interface WorkbenchFeishuConnectorDiagnosticsOptions {
  readonly identityStore: { read(): Promise<FeishuIdentityConfiguration | undefined> }
  readonly database: Pick<TwinDeskDatabase, 'getConnectorCursor'>
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly runtimeStatus?: () => WorkbenchFeishuRuntimeStatus
  /** Test boundary. Production composition constructs fixed Keychain and HTTP probes. */
  readonly createClient?: (
    configuration: FeishuIdentityConfiguration,
  ) => FeishuConnectorDiagnosticsClient
  readonly now?: () => number
}

type UnknownRecord = Readonly<Record<string, unknown>>

const DISABLED_RUNTIME: WorkbenchFeishuRuntimeStatus = Object.freeze({
  version: 1,
  state: 'disabled',
  reason: 'host_configuration_missing',
})
const NOT_CONFIGURED_RUNTIME: WorkbenchFeishuRuntimeStatus = Object.freeze({
  version: 1,
  state: 'disabled',
  reason: 'not_configured',
})

function dataRecord(value: unknown): UnknownRecord {
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
}

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(record)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new TypeError()
  }
}

function runtimeStatusAt(value: unknown): WorkbenchFeishuRuntimeStatus {
  const record = dataRecord(value)
  if (record.version !== 1 || typeof record.state !== 'string') throw new TypeError()
  if (record.state === 'disabled') {
    exactKeys(record, ['version', 'state', 'reason'])
    if (record.reason !== 'not_configured' && record.reason !== 'host_configuration_missing') {
      throw new TypeError()
    }
    return Object.freeze({ version: 1, state: 'disabled', reason: record.reason })
  }
  if (record.state === 'starting' || record.state === 'running' || record.state === 'stopped') {
    exactKeys(record, ['version', 'state'])
    return Object.freeze({ version: 1, state: record.state })
  }
  if (record.state !== 'attention_required') throw new TypeError()
  exactKeys(record, ['version', 'state', 'recovery'])
  if (
    record.recovery !== 'reauthorize' &&
    record.recovery !== 'grant_scope' &&
    record.recovery !== 'repair_configuration' &&
    record.recovery !== 'restart_host'
  ) {
    throw new TypeError()
  }
  return Object.freeze({
    version: 1,
    state: 'attention_required',
    recovery: record.recovery,
  })
}

function parseScopeObservation(
  value: unknown,
  request: FeishuOperationScopeProbeRequest,
): readonly string[] {
  const record = dataRecord(value)
  exactKeys(record, [
    'kind',
    'schemaVersion',
    'accountId',
    'appId',
    'identityType',
    'principalId',
    'operation',
    'authorization',
    'grantedScopes',
    'observedAt',
  ])
  if (
    record.kind !== 'feishu_operation_scope_probe_result' ||
    record.schemaVersion !== 1 ||
    record.accountId !== request.accountId ||
    record.appId !== request.appId ||
    record.identityType !== request.identityType ||
    record.principalId !== request.principalId ||
    record.operation !== request.operation ||
    record.authorization !== 'authorized' ||
    !Array.isArray(record.grantedScopes) ||
    typeof record.observedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.observedAt) ||
    !Number.isFinite(Date.parse(record.observedAt))
  ) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.grantedScopes)
  if (
    Object.getPrototypeOf(record.grantedScopes) !== Array.prototype ||
    Object.getOwnPropertySymbols(record.grantedScopes).length !== 0 ||
    Object.keys(descriptors).length !== record.grantedScopes.length + 1 ||
    !Object.hasOwn(descriptors, 'length') ||
    record.grantedScopes.length > 512
  ) {
    throw new TypeError()
  }
  const scopes = Array.from({ length: record.grantedScopes.length }, (_, index) => {
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
  if (new Set(scopes).size !== scopes.length) throw new TypeError()
  return Object.freeze(scopes.toSorted())
}

function mapProbeError(error: unknown): FeishuDiagnosticsClientError {
  if (!(error instanceof FeishuOperationScopeProbeClientError)) {
    return new FeishuDiagnosticsClientError('unknown')
  }
  switch (error.code) {
    case 'not_authorized':
    case 'refresh_required':
      return new FeishuDiagnosticsClientError('not_authorized')
    case 'rate_limited':
      return new FeishuDiagnosticsClientError('rate_limited')
    case 'network':
      return new FeishuDiagnosticsClientError('network')
    case 'invalid_response':
      return new FeishuDiagnosticsClientError('invalid_response')
    case 'unavailable':
    case 'unknown':
    default:
      return new FeishuDiagnosticsClientError('unknown')
  }
}

function scopeRequest(
  request: FeishuIdentityProbeRequest,
  operation: 'bot_reply' | 'user_reply' | 'user_message_discovery',
): FeishuOperationScopeProbeRequest {
  return Object.freeze({
    kind: 'feishu_operation_scope_probe_request',
    schemaVersion: 1,
    accountId: request.accountId,
    appId: request.appId,
    identityType: request.identityType,
    principalId: request.principalId,
    credentialReference: request.credentialReference,
    operation,
    requiredScopes: requiredFeishuOperationScopes(operation),
  })
}

async function inspectScopes(
  probe: FeishuOperationScopeProbeClient,
  request: FeishuIdentityProbeRequest,
  operations: readonly ('bot_reply' | 'user_reply' | 'user_message_discovery')[],
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const observations = await Promise.all(
      operations.map(async (operation) => {
        const operationRequest = scopeRequest(request, operation)
        return parseScopeObservation(
          await probe.inspectCurrentScopes(operationRequest, signal),
          operationRequest,
        )
      }),
    )
    signal.throwIfAborted()
    const requiredScopes = Object.freeze(
      [
        ...new Set(operations.flatMap((operation) => requiredFeishuOperationScopes(operation))),
      ].sort(),
    )
    const grantedScopes = Object.freeze([...new Set(observations.flat())].sort())
    return Object.freeze({
      kind: 'feishu_identity_probe_result',
      schemaVersion: 1,
      accountId: request.accountId,
      appId: request.appId,
      identityType: request.identityType,
      principalId: request.principalId,
      authorization: 'authorized',
      requiredScopes,
      grantedScopes,
      rateLimit: Object.freeze({ status: 'unknown' }),
    })
  } catch (error) {
    signal.throwIfAborted()
    throw mapProbeError(error)
  }
}

function createProductionClient(
  configuration: FeishuIdentityConfiguration,
  database: Pick<TwinDeskDatabase, 'getConnectorCursor'>,
): FeishuConnectorDiagnosticsClient {
  const resolver = new FeishuSystemKeychainSecretResolver()
  const botProbe =
    configuration.bot === undefined
      ? undefined
      : new FeishuBotKeychainScopeProbe({
          configuration,
          resolver,
          tokenAcquirer: new FeishuBotTenantTokenAcquirer(),
          scopeClient: new FeishuBotIdentityScopeHttpClient(),
        })
  const userProbe =
    configuration.user === undefined
      ? undefined
      : new FeishuUserCredentialScopeProbe({ configuration, resolver })
  return Object.freeze({
    inspectIdentity(request: FeishuIdentityProbeRequest, signal: AbortSignal) {
      if (request.identityType === 'bot' && botProbe !== undefined) {
        return inspectScopes(botProbe, request, ['bot_reply'], signal)
      }
      if (request.identityType === 'user' && userProbe !== undefined) {
        return inspectScopes(userProbe, request, ['user_message_discovery', 'user_reply'], signal)
      }
      return Promise.reject(new FeishuDiagnosticsClientError('invalid_response'))
    },
    readCursors(request: FeishuCursorProbeRequest, signal: AbortSignal) {
      signal.throwIfAborted()
      try {
        const cursors = request.streams.flatMap((stream) => {
          const cursor = database.getConnectorCursor({
            connectorId: request.connectorId,
            accountId: request.accountId,
            stream,
          })
          return cursor === undefined ? [] : [cursor]
        })
        signal.throwIfAborted()
        return Promise.resolve(
          Object.freeze({
            kind: 'feishu_cursor_probe_result',
            schemaVersion: 1,
            connectorId: request.connectorId,
            accountId: request.accountId,
            cursors: Object.freeze(cursors),
          }),
        )
      } catch {
        throw new FeishuDiagnosticsClientError('storage_unavailable')
      }
    },
  })
}

function recoveryFor(code: string): WorkbenchFeishuDiagnosticRecovery {
  if (code === 'user_identity_not_authorized') {
    return 'reauthorize'
  }
  if (code.endsWith('_scope_missing')) return 'grant_scope'
  if (code.endsWith('_invalid_response') || code === 'cursor_in_future') {
    return 'repair_configuration'
  }
  if (code.startsWith('bot_identity_not_authorized')) return 'repair_configuration'
  if (code.startsWith('cursor_') || code.endsWith('_network') || code.endsWith('_rate_limited')) {
    return 'retry'
  }
  return 'restart_host'
}

function diagnosticRequiredScopes(identityType: 'bot' | 'user'): readonly string[] {
  return identityType === 'bot'
    ? requiredFeishuOperationScopes('bot_reply')
    : Object.freeze(
        [
          ...new Set([
            ...requiredFeishuOperationScopes('user_message_discovery'),
            ...requiredFeishuOperationScopes('user_reply'),
          ]),
        ].sort(),
      )
}

function identityStatus(
  identityType: 'bot' | 'user',
  issueCodes: readonly string[],
): 'ready' | 'attention_required' | 'unavailable' {
  const prefix = `${identityType}_identity_`
  const identityIssue = issueCodes.find((code) => code.startsWith(prefix))
  if (identityIssue !== undefined) {
    return identityIssue.endsWith('_not_authorized') ? 'attention_required' : 'unavailable'
  }
  return issueCodes.some(
    (code) => code === `${identityType}_scope_missing` || code === `${identityType}_rate_limited`,
  )
    ? 'attention_required'
    : 'ready'
}

/** Compose live credential/scope probes with the durable cursor and minimized runtime state. */
export function createWorkbenchFeishuConnectorDiagnostics(
  options: WorkbenchFeishuConnectorDiagnosticsOptions,
): WorkbenchFeishuConnectorDiagnosticsPresentation {
  const leaseManager = options.leaseManager ?? new FeishuRuntimeLeaseManager()
  const runtimeStatus = options.runtimeStatus ?? (() => DISABLED_RUNTIME)
  const now = options.now ?? Date.now
  return Object.freeze({
    async read(signal: AbortSignal) {
      signal.throwIfAborted()
      const configuration = await options.identityStore.read()
      signal.throwIfAborted()
      if (configuration === undefined) {
        return Object.freeze({
          version: 1,
          connectorId: 'feishu',
          status: 'not_configured',
          checkedAt: null,
          runtime: NOT_CONFIGURED_RUNTIME,
          identities: Object.freeze([]),
          rateLimits: Object.freeze([]),
          cursors: Object.freeze([]),
          issues: Object.freeze([]),
        })
      }
      const diagnostics = await leaseManager.withLease(configuration, signal, async (lease) => {
        lease.assertHeld()
        const client =
          options.createClient?.(configuration) ??
          createProductionClient(configuration, options.database)
        const result = await new FeishuConnectorDiagnosticsService(configuration, client, {
          now,
          streams: [FEISHU_USER_MESSAGE_STREAM],
        }).diagnose(signal)
        signal.throwIfAborted()
        lease.assertHeld()
        return result
      })
      const issueCodes = diagnostics.health.issues.map((issue) => issue.code)
      const observedRuntime = runtimeStatusAt(runtimeStatus())
      const runtime =
        configuration.user === undefined &&
        observedRuntime.state === 'disabled' &&
        observedRuntime.reason === 'host_configuration_missing'
          ? NOT_CONFIGURED_RUNTIME
          : observedRuntime
      const runtimeIssue =
        runtime.state === 'attention_required'
          ? Object.freeze({ code: 'polling_stopped', recovery: runtime.recovery })
          : runtime.state === 'disabled' && runtime.reason === 'host_configuration_missing'
            ? Object.freeze({
                code: 'polling_disabled',
                recovery: 'repair_configuration' as const,
              })
            : runtime.state === 'stopped'
              ? Object.freeze({ code: 'polling_stopped', recovery: 'restart_host' as const })
              : undefined
      const issues = Object.freeze([
        ...diagnostics.health.issues.map((issue) =>
          Object.freeze({
            code: issue.code,
            recovery: recoveryFor(issue.code),
          }),
        ),
        ...(runtimeIssue === undefined ? [] : [runtimeIssue]),
      ])
      const status =
        diagnostics.health.status === 'unavailable'
          ? 'unavailable'
          : issues.length === 0
            ? 'healthy'
            : 'degraded'
      return Object.freeze({
        version: 1,
        connectorId: 'feishu',
        status,
        checkedAt: diagnostics.health.checkedAt,
        runtime,
        identities: Object.freeze(
          diagnostics.health.identities.map((identity) =>
            Object.freeze({
              identityType: identity.identityType,
              status: identityStatus(identity.identityType, issueCodes),
              requiredScopes: diagnosticRequiredScopes(identity.identityType),
              missingScopes: identity.missingScopes,
            }),
          ),
        ),
        rateLimits: Object.freeze(
          diagnostics.rateLimits.map((rate) =>
            Object.freeze({
              identityType: rate.identityType,
              status: rate.status,
              ...('resetsAt' in rate ? { resetsAt: rate.resetsAt } : {}),
            }),
          ),
        ),
        cursors: diagnostics.cursors,
        issues,
      })
    },
  })
}
