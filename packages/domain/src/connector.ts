import type {
  ActionIdentity,
  ActionProposal,
  ActionProposalId,
  ApprovalRecord,
  ConnectorCursor,
  DraftContent,
  DraftId,
  ExternalEvent,
  ExternalReference,
  IsoTimestamp,
  JsonObject,
  WorkItemId,
} from './model.ts'

/** First public TwinDesk Connector protocol version. */
export const CONNECTOR_CONTRACT_VERSION = 1 as const
export type ConnectorContractVersion = typeof CONNECTOR_CONTRACT_VERSION

export type ConnectorCapability = 'sync' | 'context' | 'propose' | 'execute' | 'health'

export interface ConnectorDescriptor {
  readonly contractVersion: ConnectorContractVersion
  readonly id: string
  readonly displayName: string
  readonly capabilities: readonly ConnectorCapability[]
}

export interface ConnectorSyncRequest {
  readonly accountId: string
  readonly stream: string
  readonly cursor?: ConnectorCursor
  readonly limit: number
}

/**
 * A Connector returns a candidate cursor but never persists it. Work Hub may
 * commit the cursor only after every event in this batch is durably stored.
 */
export interface ConnectorSyncBatch {
  readonly events: readonly ExternalEvent[]
  readonly candidateCursor?: ConnectorCursor
  readonly hasMore: boolean
  readonly observedAt: IsoTimestamp
  readonly issues: readonly ConnectorIssue[]
}

export interface ConnectorContextRequest {
  readonly reference: ExternalReference
  readonly purpose: string
  readonly maxItems: number
  readonly before?: IsoTimestamp
}

export interface ConnectorContextItem {
  readonly source: ExternalReference
  readonly title?: string
  readonly content: JsonObject
  readonly observedAt: IsoTimestamp
}

export interface ConnectorIssue {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type ContextAvailability =
  | { readonly status: 'complete' }
  | { readonly status: 'partial'; readonly missing: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason: string; readonly retryable: boolean }

export interface ConnectorContextBundle {
  readonly availability: ContextAvailability
  readonly items: readonly ConnectorContextItem[]
  readonly issues: readonly ConnectorIssue[]
  readonly observedAt: IsoTimestamp
}

export interface ConnectorActionRequest {
  readonly workItemId: WorkItemId
  readonly draftId?: DraftId
  readonly actionType: string
  readonly identity: ActionIdentity
  readonly target: ExternalReference
  readonly content: DraftContent
}

declare const approvedActionBrand: unique symbol

/**
 * Opaque execution input created only by the future Work Hub policy path.
 * Connectors cannot turn an ActionProposal into this value themselves.
 */
export interface ApprovedAction {
  readonly [approvedActionBrand]: true
  readonly proposal: ActionProposal
  readonly approval: ApprovalRecord & {
    readonly decision: 'approved'
    readonly consumedAt?: never
  }
  readonly executionAttemptId: string
}

interface ActionReceiptBase {
  readonly proposalId: ActionProposalId
  readonly connectorId: string
  readonly accountId: string
  readonly idempotencyKey: string
  readonly attemptedAt: IsoTimestamp
}

export type ActionReceipt =
  | (ActionReceiptBase & {
      readonly outcome: 'succeeded'
      readonly externalReference: ExternalReference
    })
  | (ActionReceiptBase & {
      readonly outcome: 'failed'
      readonly error: ConnectorIssue
      readonly retryDisposition: 'do_not_retry' | 'retry_same_key'
    })
  | (ActionReceiptBase & {
      readonly outcome: 'uncertain'
      readonly error: ConnectorIssue
      readonly retryDisposition: 'reconcile_first'
    })

export type ConnectorHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'not_configured'

export interface ConnectorIdentityHealth {
  readonly accountId: string
  readonly identityType: 'bot' | 'user'
  readonly displayName: string
  readonly requiredScopes: readonly string[]
  readonly grantedScopes: readonly string[]
  readonly missingScopes: readonly string[]
}

export interface ConnectorHealth {
  readonly connectorId: string
  readonly status: ConnectorHealthStatus
  readonly checkedAt: IsoTimestamp
  readonly identities: readonly ConnectorIdentityHealth[]
  readonly issues: readonly ConnectorIssue[]
}

export type ConnectorOperation =
  'start' | 'stop' | 'sync' | 'context' | 'propose' | 'execute' | 'health'
export type ConnectorFailureCode =
  | 'not_configured'
  | 'not_authorized'
  | 'scope_missing'
  | 'rate_limited'
  | 'network'
  | 'invalid_response'
  | 'cancelled'
  | 'unsupported'
  | 'conflict'
  | 'unknown'

/** Typed operational failure that never serializes Connector payloads. */
export class ConnectorOperationError extends Error {
  readonly connectorId: string
  readonly operation: ConnectorOperation
  readonly code: ConnectorFailureCode
  readonly retryable: boolean

  constructor(options: {
    readonly connectorId: string
    readonly operation: ConnectorOperation
    readonly code: ConnectorFailureCode
    readonly retryable: boolean
    readonly message: string
  }) {
    super(options.message)
    this.name = 'ConnectorOperationError'
    this.connectorId = options.connectorId
    this.operation = options.operation
    this.code = options.code
    this.retryable = options.retryable
  }
}

/**
 * Product-owned boundary implemented by long-lived, formally installed Host
 * plugins. Every operation must observe cancellation and return only normalized
 * TwinDesk values.
 */
export interface Connector {
  readonly descriptor: ConnectorDescriptor

  /** Idempotently start polling, event subscriptions, and other owned resources. */
  start(signal: AbortSignal): Promise<void>

  /**
   * Stop accepting new work, flush already durable progress, and release every
   * owned resource. Calling stop more than once must be safe.
   */
  stop(signal: AbortSignal): Promise<void>

  sync(request: ConnectorSyncRequest, signal: AbortSignal): Promise<ConnectorSyncBatch>
  getContext(request: ConnectorContextRequest, signal: AbortSignal): Promise<ConnectorContextBundle>

  /** Build a preview-only proposal. This method must have no external side effect. */
  propose(request: ConnectorActionRequest, signal: AbortSignal): Promise<ActionProposal>

  /** Execute only an opaque, exact approved action and preserve its idempotency key. */
  execute(action: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt>

  health(signal: AbortSignal): Promise<ConnectorHealth>
}

const connectorMethods = [
  'start',
  'stop',
  'sync',
  'getContext',
  'propose',
  'execute',
  'health',
] as const
const connectorCapabilities: readonly ConnectorCapability[] = [
  'sync',
  'context',
  'propose',
  'execute',
  'health',
]

/** Boundary error for a malformed formally installed Connector plugin. */
export class ConnectorContractError extends TypeError {
  readonly path: string

  constructor(path: string, expectation: string) {
    super(`${path} ${expectation}`)
    this.name = 'ConnectorContractError'
    this.path = path
  }
}

function contractFailure(path: string, expectation: string): never {
  throw new ConnectorContractError(path, expectation)
}

function nonEmptyContractString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    return contractFailure(path, 'must be a non-empty trimmed string')
  }
  return value
}

/**
 * Validate the runtime face before a Host registry accepts a Connector. This
 * verifies protocol identity and callable operations, not remote credentials.
 */
export function validateConnector(value: unknown): Connector {
  if (typeof value !== 'object' || value === null) {
    return contractFailure('connector', 'must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.descriptor !== 'object' || candidate.descriptor === null) {
    return contractFailure('connector.descriptor', 'must be an object')
  }
  const descriptor = candidate.descriptor as Record<string, unknown>
  const descriptorKeys = new Set(['contractVersion', 'id', 'displayName', 'capabilities'])
  for (const key of Object.keys(descriptor)) {
    if (!descriptorKeys.has(key)) {
      contractFailure(`connector.descriptor.${key}`, 'is not supported by this contract version')
    }
  }
  if (descriptor.contractVersion !== CONNECTOR_CONTRACT_VERSION) {
    contractFailure(
      'connector.descriptor.contractVersion',
      `must equal ${CONNECTOR_CONTRACT_VERSION}`,
    )
  }
  nonEmptyContractString(descriptor.id, 'connector.descriptor.id')
  nonEmptyContractString(descriptor.displayName, 'connector.descriptor.displayName')
  if (!Array.isArray(descriptor.capabilities)) {
    contractFailure('connector.descriptor.capabilities', 'must be an array')
  }
  const seenCapabilities = new Set<string>()
  for (const [index, capability] of descriptor.capabilities.entries()) {
    if (
      typeof capability !== 'string' ||
      !connectorCapabilities.includes(capability as ConnectorCapability)
    ) {
      contractFailure(
        `connector.descriptor.capabilities[${index}]`,
        'is not a supported capability',
      )
    }
    if (seenCapabilities.has(capability)) {
      contractFailure('connector.descriptor.capabilities', 'must not contain duplicates')
    }
    seenCapabilities.add(capability)
  }
  if (!seenCapabilities.has('health')) {
    contractFailure('connector.descriptor.capabilities', 'must include health')
  }
  for (const method of connectorMethods) {
    if (typeof candidate[method] !== 'function') {
      contractFailure(`connector.${method}`, 'must be a function')
    }
  }
  return value as Connector
}
