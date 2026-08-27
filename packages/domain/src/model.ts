/** First persisted TwinDesk business-record schema version. */
export const DOMAIN_SCHEMA_VERSION = 1 as const
export type DomainSchemaVersion = typeof DOMAIN_SCHEMA_VERSION

declare const domainBrand: unique symbol
type Brand<Value, Name extends string> = Value & { readonly [domainBrand]: Name }

export type IsoTimestamp = Brand<string, 'IsoTimestamp'>
export type ContentDigest = Brand<string, 'ContentDigest'>
export type ExternalEventId = Brand<string, 'ExternalEventId'>
export type WorkItemId = Brand<string, 'WorkItemId'>
export type WorkItemUserActionId = Brand<string, 'WorkItemUserActionId'>
export type ExternalThreadId = Brand<string, 'ExternalThreadId'>
export type DraftId = Brand<string, 'DraftId'>
export type DraftStateTransitionId = Brand<string, 'DraftStateTransitionId'>
export type ActionProposalId = Brand<string, 'ActionProposalId'>
export type ActionProposalStateTransitionId = Brand<string, 'ActionProposalStateTransitionId'>
export type ApprovalRecordId = Brand<string, 'ApprovalRecordId'>
export type ConnectorCursorId = Brand<string, 'ConnectorCursorId'>
export type AuditRecordId = Brand<string, 'AuditRecordId'>

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface ExternalReference {
  readonly connectorId: string
  readonly accountId: string
  readonly objectType: string
  readonly externalId: string
  readonly sourceTimestamp?: IsoTimestamp
}

export type ContextState =
  | { readonly status: 'complete' }
  | { readonly status: 'partial'; readonly missing: readonly string[] }

export interface ExternalEvent {
  readonly kind: 'external_event'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ExternalEventId
  readonly idempotencyKey: string
  readonly source: ExternalReference
  readonly eventType: string
  readonly occurredAt: IsoTimestamp
  readonly receivedAt: IsoTimestamp
  readonly context: ContextState
  readonly normalized: JsonObject
}

export interface ExternalThread {
  readonly kind: 'external_thread'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ExternalThreadId
  readonly subject: string
  readonly externalReferences: readonly ExternalReference[]
  readonly sourceEventIds: readonly ExternalEventId[]
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export type InboxState = 'needs_reply' | 'needs_review' | 'waiting' | 'done'

export interface WorkItem {
  readonly kind: 'work_item'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: WorkItemId
  readonly threadId: ExternalThreadId
  readonly sourceEventIds: readonly ExternalEventId[]
  readonly inboxState: InboxState
  readonly title: string
  readonly summary: string
  readonly attentionReason: string
  readonly selectedPersonaId?: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

interface WorkItemUserActionBase {
  readonly kind: 'work_item_user_action'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: WorkItemUserActionId
  readonly workItemId: WorkItemId
  readonly revision: number
  readonly occurredAt: IsoTimestamp
}

export type WorkItemUserAction =
  | (WorkItemUserActionBase & {
      readonly action: 'set_inbox_state'
      readonly inboxState: InboxState
    })
  | (WorkItemUserActionBase & {
      readonly action: 'select_persona'
      readonly personaId: string
    })
  | (WorkItemUserActionBase & {
      readonly action: 'clear_persona'
    })

export type DraftState = 'editing' | 'ready_for_review' | 'superseded' | 'cancelled'

export interface DraftContent {
  readonly mediaType: 'text/plain' | 'text/markdown'
  readonly text: string
}

export interface Draft {
  readonly kind: 'draft'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: DraftId
  readonly workItemId: WorkItemId
  readonly personaId: string
  readonly sessionId?: string
  readonly runId?: string
  readonly revision: number
  readonly state: DraftState
  readonly content: DraftContent
  readonly rationale?: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface DraftStateTransition {
  readonly kind: 'draft_state_transition'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: DraftStateTransitionId
  readonly draftId: DraftId
  readonly fromState: DraftState
  readonly toState: DraftState
  readonly occurredAt: IsoTimestamp
}

export type ActionRisk = 'write' | 'destructive'
export type ActionProposalState =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'uncertain'

export interface ActionIdentity {
  readonly connectorId: string
  readonly accountId: string
  readonly identityType: 'bot' | 'user'
  readonly displayName: string
}

export interface ActionProposal {
  readonly kind: 'action_proposal'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ActionProposalId
  readonly workItemId: WorkItemId
  readonly draftId?: DraftId
  readonly actionType: string
  readonly risk: ActionRisk
  readonly identity: ActionIdentity
  readonly target: ExternalReference
  readonly content: DraftContent
  readonly contentDigest: ContentDigest
  readonly idempotencyKey: string
  readonly state: ActionProposalState
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface ActionProposalStateTransition {
  readonly kind: 'action_proposal_state_transition'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ActionProposalStateTransitionId
  readonly proposalId: ActionProposalId
  readonly fromState: ActionProposalState
  readonly toState: ActionProposalState
  readonly occurredAt: IsoTimestamp
}

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface ApprovalRecord {
  readonly kind: 'approval_record'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ApprovalRecordId
  readonly proposalId: ActionProposalId
  readonly decision: ApprovalDecision
  readonly identityDigest: ContentDigest
  readonly targetDigest: ContentDigest
  readonly contentDigest: ContentDigest
  readonly requestedAt: IsoTimestamp
  readonly expiresAt: IsoTimestamp
  readonly decidedAt?: IsoTimestamp
  readonly responderUserId?: string
  readonly consumedAt?: IsoTimestamp
}

export interface ConnectorCursor {
  readonly kind: 'connector_cursor'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: ConnectorCursorId
  readonly connectorId: string
  readonly accountId: string
  readonly stream: string
  readonly position: string
  readonly committedThrough?: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export type AuditCategory =
  'ingestion' | 'routing' | 'run' | 'draft' | 'approval' | 'execution' | 'system'
export type AuditOutcome = 'pending' | 'success' | 'failure' | 'cancelled' | 'uncertain'

export interface AuditActor {
  readonly type: 'user' | 'system' | 'persona' | 'connector'
  readonly id?: string
}

export interface AuditReference {
  readonly kind: string
  readonly id: string
}

export interface AuditRecord {
  readonly kind: 'audit_record'
  readonly schemaVersion: DomainSchemaVersion
  readonly id: AuditRecordId
  readonly category: AuditCategory
  readonly outcome: AuditOutcome
  readonly actor: AuditActor
  readonly summary: string
  readonly references: readonly AuditReference[]
  readonly details: JsonObject
  readonly occurredAt: IsoTimestamp
}

export type DomainRecord =
  | ExternalEvent
  | ExternalThread
  | WorkItem
  | WorkItemUserAction
  | Draft
  | DraftStateTransition
  | ActionProposal
  | ActionProposalStateTransition
  | ApprovalRecord
  | ConnectorCursor
  | AuditRecord

export type DomainRecordKind = DomainRecord['kind']
