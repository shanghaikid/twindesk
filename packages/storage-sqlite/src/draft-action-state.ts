import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  applyActionProposalStateTransition,
  applyDraftStateTransition,
  parseActionProposal,
  parseActionProposalStateTransition,
  parseContentDigest,
  parseDraft,
  parseDraftStateTransition,
  type ActionProposal,
  type ActionProposalId,
  type ActionProposalStateTransition,
  type ContentDigest,
  type Draft,
  type DraftContent,
  type DraftId,
  type DraftStateTransition,
  type WorkItemId,
} from '@twindesk/domain'

export type DraftActionStateErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'missing_work_item'
  | 'missing_persona'
  | 'persona_mismatch'
  | 'missing_draft'
  | 'draft_conflict'
  | 'active_draft'
  | 'revision_conflict'
  | 'missing_proposal'
  | 'proposal_conflict'
  | 'target_mismatch'
  | 'digest_mismatch'
  | 'stale_state'
  | 'transition_conflict'
  | 'stored_record_invalid'
  | 'storage_error'

export class DraftActionStateError extends Error {
  readonly code: DraftActionStateErrorCode

  constructor(code: DraftActionStateErrorCode, message: string) {
    super(message)
    this.name = 'DraftActionStateError'
    this.code = code
  }
}

export interface DraftWriteResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly draft: Draft
}

export interface DraftTransitionWriteResult {
  readonly disposition: 'applied' | 'duplicate'
  readonly draft: Draft
}

export interface DraftRevisionWrite {
  readonly transition: DraftStateTransition
  readonly draft: Draft
}

export interface DraftRevisionWriteResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly source: Draft
  readonly draft: Draft
}

export interface ActionProposalWriteResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly proposal: ActionProposal
}

export interface ActionProposalTransitionWriteResult {
  readonly disposition: 'applied' | 'duplicate'
  readonly proposal: ActionProposal
}

interface DraftRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly work_item_id: unknown
  readonly persona_id: unknown
  readonly session_id: unknown
  readonly run_id: unknown
  readonly revision: unknown
  readonly state: unknown
  readonly media_type: unknown
  readonly content_text: unknown
  readonly rationale: unknown
  readonly created_at: unknown
  readonly updated_at: unknown
}

interface ProposalRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly work_item_id: unknown
  readonly draft_id: unknown
  readonly action_type: unknown
  readonly risk: unknown
  readonly identity_connector_id: unknown
  readonly identity_account_id: unknown
  readonly identity_type: unknown
  readonly identity_display_name: unknown
  readonly target_connector_id: unknown
  readonly target_account_id: unknown
  readonly target_object_type: unknown
  readonly target_external_id: unknown
  readonly target_source_timestamp: unknown
  readonly media_type: unknown
  readonly content_text: unknown
  readonly content_digest: unknown
  readonly idempotency_key: unknown
  readonly state: unknown
  readonly created_at: unknown
  readonly updated_at: unknown
}

interface TransitionRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly record_id: unknown
  readonly from_state: unknown
  readonly to_state: unknown
  readonly occurred_at: unknown
}

interface CreationStateRow {
  readonly initial_state: unknown
  readonly initial_updated_at: unknown
}

const DRAFT_COLUMNS = `kind, schema_version, id, work_item_id, persona_id, session_id,
  run_id, revision, state, media_type, content_text, rationale, created_at, updated_at`
const PROPOSAL_COLUMNS = `kind, schema_version, id, work_item_id, draft_id, action_type,
  risk, identity_connector_id, identity_account_id, identity_type, identity_display_name,
  target_connector_id, target_account_id, target_object_type, target_external_id,
  target_source_timestamp, media_type, content_text, content_digest, idempotency_key,
  state, created_at, updated_at`

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed operation error.
  }
}

function parseStoredDraft(row: DraftRow): Draft {
  try {
    return parseDraft({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      workItemId: row.work_item_id,
      personaId: row.persona_id,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      revision: row.revision,
      state: row.state,
      content: { mediaType: row.media_type, text: row.content_text },
      ...(row.rationale === null ? {} : { rationale: row.rationale }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch {
    throw new DraftActionStateError('stored_record_invalid', 'A stored Draft is invalid.')
  }
}

function parseStoredProposal(row: ProposalRow): ActionProposal {
  try {
    return parseActionProposal({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      workItemId: row.work_item_id,
      ...(row.draft_id === null ? {} : { draftId: row.draft_id }),
      actionType: row.action_type,
      risk: row.risk,
      identity: {
        connectorId: row.identity_connector_id,
        accountId: row.identity_account_id,
        identityType: row.identity_type,
        displayName: row.identity_display_name,
      },
      target: {
        connectorId: row.target_connector_id,
        accountId: row.target_account_id,
        objectType: row.target_object_type,
        externalId: row.target_external_id,
        ...(row.target_source_timestamp === null
          ? {}
          : { sourceTimestamp: row.target_source_timestamp }),
      },
      content: { mediaType: row.media_type, text: row.content_text },
      contentDigest: row.content_digest,
      idempotencyKey: row.idempotency_key,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch {
    throw new DraftActionStateError('stored_record_invalid', 'A stored ActionProposal is invalid.')
  }
}

function sameDraft(left: Draft, right: Draft): boolean {
  return (
    left.id === right.id &&
    left.workItemId === right.workItemId &&
    left.personaId === right.personaId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.state === right.state &&
    left.content.mediaType === right.content.mediaType &&
    left.content.text === right.content.text &&
    left.rationale === right.rationale &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  )
}

function sameProposal(left: ActionProposal, right: ActionProposal): boolean {
  return (
    left.id === right.id &&
    left.workItemId === right.workItemId &&
    left.draftId === right.draftId &&
    left.actionType === right.actionType &&
    left.risk === right.risk &&
    left.identity.connectorId === right.identity.connectorId &&
    left.identity.accountId === right.identity.accountId &&
    left.identity.identityType === right.identity.identityType &&
    left.identity.displayName === right.identity.displayName &&
    left.target.connectorId === right.target.connectorId &&
    left.target.accountId === right.target.accountId &&
    left.target.objectType === right.target.objectType &&
    left.target.externalId === right.target.externalId &&
    left.target.sourceTimestamp === right.target.sourceTimestamp &&
    left.content.mediaType === right.content.mediaType &&
    left.content.text === right.content.text &&
    left.contentDigest === right.contentDigest &&
    left.idempotencyKey === right.idempotencyKey &&
    left.state === right.state &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  )
}

function sameDraftCreation(
  stored: Draft,
  creation: CreationStateRow | undefined,
  input: Draft,
): boolean {
  if (
    creation === undefined ||
    (creation.initial_state !== 'editing' &&
      creation.initial_state !== 'ready_for_review' &&
      creation.initial_state !== 'superseded' &&
      creation.initial_state !== 'cancelled') ||
    typeof creation.initial_updated_at !== 'string'
  ) {
    throw new DraftActionStateError(
      'stored_record_invalid',
      'A stored Draft creation record is invalid.',
    )
  }
  if (creation.initial_state === 'superseded' || creation.initial_state === 'cancelled') {
    return false
  }
  try {
    return sameDraft(
      parseDraft({
        ...stored,
        state: creation.initial_state,
        updatedAt: creation.initial_updated_at,
      }),
      input,
    )
  } catch {
    throw new DraftActionStateError(
      'stored_record_invalid',
      'A stored Draft creation record is invalid.',
    )
  }
}

function sameProposalCreation(
  stored: ActionProposal,
  creation: CreationStateRow | undefined,
  input: ActionProposal,
): boolean {
  const validStates = [
    'proposed',
    'awaiting_approval',
    'approved',
    'rejected',
    'cancelled',
    'executing',
    'succeeded',
    'failed',
    'uncertain',
  ]
  if (
    creation === undefined ||
    typeof creation.initial_state !== 'string' ||
    !validStates.includes(creation.initial_state) ||
    typeof creation.initial_updated_at !== 'string'
  ) {
    throw new DraftActionStateError(
      'stored_record_invalid',
      'A stored ActionProposal creation record is invalid.',
    )
  }
  if (creation.initial_state !== 'proposed') return false
  try {
    return sameProposal(
      parseActionProposal({
        ...stored,
        state: creation.initial_state,
        updatedAt: creation.initial_updated_at,
      }),
      input,
    )
  } catch {
    throw new DraftActionStateError(
      'stored_record_invalid',
      'A stored ActionProposal creation record is invalid.',
    )
  }
}

function sameDraftTransition(row: TransitionRow, value: DraftStateTransition): boolean {
  return (
    row.kind === value.kind &&
    row.schema_version === value.schemaVersion &&
    row.id === value.id &&
    row.record_id === value.draftId &&
    row.from_state === value.fromState &&
    row.to_state === value.toState &&
    row.occurred_at === value.occurredAt
  )
}

function sameProposalTransition(row: TransitionRow, value: ActionProposalStateTransition): boolean {
  return (
    row.kind === value.kind &&
    row.schema_version === value.schemaVersion &&
    row.id === value.id &&
    row.record_id === value.proposalId &&
    row.from_state === value.fromState &&
    row.to_state === value.toState &&
    row.occurred_at === value.occurredAt
  )
}

/** Digest exact media type and text as canonical UTF-8 JSON for proposal binding. */
export function computeDraftContentDigest(content: DraftContent): ContentDigest {
  if (typeof content !== 'object' || content === null) {
    throw new DraftActionStateError('invalid_request', 'Draft content is invalid.')
  }
  const prototype = Object.getPrototypeOf(content)
  const descriptors = Object.getOwnPropertyDescriptors(content)
  const keys = Reflect.ownKeys(descriptors)
  const mediaType = descriptors.mediaType
  const text = descriptors.text
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 ||
    keys.some((key) => typeof key !== 'string') ||
    mediaType === undefined ||
    text === undefined ||
    !Object.hasOwn(mediaType, 'value') ||
    !Object.hasOwn(text, 'value') ||
    (mediaType.value !== 'text/plain' && mediaType.value !== 'text/markdown') ||
    typeof text.value !== 'string' ||
    text.value.trim().length === 0
  ) {
    throw new DraftActionStateError('invalid_request', 'Draft content is invalid.')
  }
  const canonical = JSON.stringify({ mediaType: mediaType.value, text: text.value })
  return parseContentDigest(
    `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  )
}

export function readDraft(database: DatabaseSync, id: DraftId): Draft | undefined {
  const row = database.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as
    DraftRow | undefined
  return row === undefined ? undefined : parseStoredDraft(row)
}

export function readDraftByWorkItemRevision(
  database: DatabaseSync,
  workItemId: WorkItemId,
  revision: number,
): Draft | undefined {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new DraftActionStateError('invalid_request', 'The Draft revision is invalid.')
  }
  const row = database
    .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE work_item_id = ? AND revision = ?`)
    .get(workItemId, revision) as DraftRow | undefined
  return row === undefined ? undefined : parseStoredDraft(row)
}

export function readActionProposal(
  database: DatabaseSync,
  id: ActionProposalId,
): ActionProposal | undefined {
  const row = database
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM action_proposals WHERE id = ?`)
    .get(id) as ProposalRow | undefined
  return row === undefined ? undefined : parseStoredProposal(row)
}

export function createDraft(database: DatabaseSync, input: Draft): DraftWriteResult {
  const draft = parseDraft(input)
  if (draft.state !== 'editing' && draft.state !== 'ready_for_review') {
    throw new DraftActionStateError('invalid_request', 'A new Draft must be active.')
  }
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new DraftActionStateError('storage_error', 'The Draft transaction could not start.')
  }
  try {
    const existing = database
      .prepare(
        `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ? OR (work_item_id = ? AND revision = ?)`,
      )
      .all(draft.id, draft.workItemId, draft.revision) as unknown as DraftRow[]
    if (existing.length > 0) {
      const stored = existing.length === 1 ? parseStoredDraft(existing[0] as DraftRow) : undefined
      const creation =
        stored === undefined
          ? undefined
          : (database
              .prepare(
                `SELECT initial_state, initial_updated_at
                 FROM draft_creation_records WHERE draft_id = ?`,
              )
              .get(stored.id) as CreationStateRow | undefined)
      const duplicate = stored !== undefined && sameDraftCreation(stored, creation, draft)
      if (!duplicate)
        throw new DraftActionStateError('draft_conflict', 'The Draft identity conflicts.')
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', draft: stored })
    }
    const workItem = database
      .prepare(`SELECT selected_persona_id, updated_at FROM work_items WHERE id = ?`)
      .get(draft.workItemId) as
      { readonly selected_persona_id: unknown; readonly updated_at: unknown } | undefined
    if (workItem === undefined) {
      throw new DraftActionStateError('missing_work_item', 'The Draft Work Item is missing.')
    }
    if (workItem.selected_persona_id === null) {
      throw new DraftActionStateError('missing_persona', 'The Work Item has no selected Persona.')
    }
    if (workItem.selected_persona_id !== draft.personaId) {
      throw new DraftActionStateError('persona_mismatch', 'The Draft Persona does not match.')
    }
    if (
      typeof workItem.updated_at !== 'string' ||
      Date.parse(draft.createdAt) < Date.parse(workItem.updated_at)
    ) {
      throw new DraftActionStateError('invalid_request', 'The Draft chronology is invalid.')
    }
    const previous = database
      .prepare(
        `SELECT revision, state FROM drafts WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(draft.workItemId) as { readonly revision: unknown; readonly state: unknown } | undefined
    const expectedRevision = previous === undefined ? 1 : Number(previous.revision) + 1
    if (draft.revision !== expectedRevision) {
      throw new DraftActionStateError('revision_conflict', 'The Draft revision is not next.')
    }
    if (previous?.state === 'editing' || previous?.state === 'ready_for_review') {
      throw new DraftActionStateError('active_draft', 'The previous Draft is still active.')
    }
    const inserted = database
      .prepare(
        `INSERT INTO drafts (
           kind, schema_version, id, work_item_id, persona_id, session_id, run_id,
           revision, state, media_type, content_text, rationale, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.kind,
        draft.schemaVersion,
        draft.id,
        draft.workItemId,
        draft.personaId,
        draft.sessionId ?? null,
        draft.runId ?? null,
        draft.revision,
        draft.state,
        draft.content.mediaType,
        draft.content.text,
        draft.rationale ?? null,
        draft.createdAt,
        draft.updatedAt,
      )
    if (inserted.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The Draft was not stored.')
    }
    const creationInserted = database
      .prepare(
        `INSERT INTO draft_creation_records
           (kind, schema_version, draft_id, initial_state, initial_updated_at)
         VALUES ('draft_creation_record', 1, ?, ?, ?)`,
      )
      .run(draft.id, draft.state, draft.updatedAt)
    if (creationInserted.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The Draft creation was not stored.')
    }
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', draft })
  } catch (error) {
    rollback(database)
    if (error instanceof DraftActionStateError) throw error
    throw new DraftActionStateError('storage_error', 'The Draft could not be stored.')
  }
}

export function transitionDraft(
  database: DatabaseSync,
  input: DraftStateTransition,
): DraftTransitionWriteResult {
  const transition = parseDraftStateTransition(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new DraftActionStateError('storage_error', 'The Draft transition could not start.')
  }
  try {
    const existing = database
      .prepare(
        `SELECT kind, schema_version, id, draft_id AS record_id, from_state, to_state, occurred_at
         FROM draft_state_transitions WHERE id = ?`,
      )
      .get(transition.id) as TransitionRow | undefined
    if (existing !== undefined) {
      if (!sameDraftTransition(existing, transition)) {
        throw new DraftActionStateError('transition_conflict', 'The transition identity conflicts.')
      }
      const draft = readDraft(database, transition.draftId)
      if (draft === undefined)
        throw new DraftActionStateError('missing_draft', 'The Draft is missing.')
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', draft })
    }
    const draft = readDraft(database, transition.draftId)
    if (draft === undefined)
      throw new DraftActionStateError('missing_draft', 'The Draft is missing.')
    let updated: Draft
    try {
      updated = applyDraftStateTransition(draft, transition)
    } catch {
      throw new DraftActionStateError('stale_state', 'The Draft transition is stale or invalid.')
    }
    const transitionInserted = database
      .prepare(
        `INSERT INTO draft_state_transitions
           (kind, schema_version, id, draft_id, from_state, to_state, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.kind,
        transition.schemaVersion,
        transition.id,
        transition.draftId,
        transition.fromState,
        transition.toState,
        transition.occurredAt,
      )
    if (transitionInserted.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The Draft transition was not stored.')
    }
    const updatedRow = database
      .prepare(`UPDATE drafts SET state = ?, updated_at = ? WHERE id = ?`)
      .run(updated.state, updated.updatedAt, updated.id)
    if (updatedRow.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The Draft was not updated.')
    }
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'applied', draft: updated })
  } catch (error) {
    rollback(database)
    if (error instanceof DraftActionStateError) throw error
    throw new DraftActionStateError('storage_error', 'The Draft transition could not be stored.')
  }
}

function revisionWriteAt(value: DraftRevisionWrite): DraftRevisionWrite {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 2 ||
      !Object.hasOwn(descriptors, 'transition') ||
      !Object.hasOwn(descriptors, 'draft') ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const transition = parseDraftStateTransition(descriptors.transition?.value)
    const draft = parseDraft(descriptors.draft?.value)
    if (
      transition.toState !== 'superseded' ||
      (draft.state !== 'editing' && draft.state !== 'ready_for_review') ||
      draft.createdAt !== transition.occurredAt ||
      draft.updatedAt !== transition.occurredAt
    ) {
      throw new TypeError()
    }
    return Object.freeze({ transition, draft })
  } catch {
    throw new DraftActionStateError('invalid_request', 'The Draft revision request is invalid.')
  }
}

/** Supersede one active Draft and create its next revision atomically. */
export function reviseDraft(
  database: DatabaseSync,
  input: DraftRevisionWrite,
): DraftRevisionWriteResult {
  const { transition, draft } = revisionWriteAt(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new DraftActionStateError('storage_error', 'The Draft revision could not start.')
  }
  try {
    const source = readDraft(database, transition.draftId)
    if (source === undefined) {
      throw new DraftActionStateError('missing_draft', 'The source Draft is missing.')
    }
    if (
      draft.workItemId !== source.workItemId ||
      draft.personaId !== source.personaId ||
      draft.revision !== source.revision + 1
    ) {
      throw new DraftActionStateError('revision_conflict', 'The Draft revision is not next.')
    }
    const existingTransition = database
      .prepare(
        `SELECT kind, schema_version, id, draft_id AS record_id, from_state, to_state, occurred_at
         FROM draft_state_transitions WHERE id = ?`,
      )
      .get(transition.id) as TransitionRow | undefined
    const existingDraftRows = database
      .prepare(
        `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ? OR (work_item_id = ? AND revision = ?)`,
      )
      .all(draft.id, draft.workItemId, draft.revision) as unknown as DraftRow[]
    if (existingTransition !== undefined || existingDraftRows.length > 0) {
      const storedDraft =
        existingDraftRows.length === 1
          ? parseStoredDraft(existingDraftRows[0] as DraftRow)
          : undefined
      const creation =
        storedDraft === undefined
          ? undefined
          : (database
              .prepare(
                `SELECT initial_state, initial_updated_at
                 FROM draft_creation_records WHERE draft_id = ?`,
              )
              .get(storedDraft.id) as CreationStateRow | undefined)
      if (
        existingTransition === undefined ||
        storedDraft === undefined ||
        !sameDraftTransition(existingTransition, transition) ||
        !sameDraftCreation(storedDraft, creation, draft) ||
        source.state !== 'superseded'
      ) {
        throw new DraftActionStateError('draft_conflict', 'The Draft revision conflicts.')
      }
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', source, draft: storedDraft })
    }
    if (source.state !== transition.fromState) {
      throw new DraftActionStateError('stale_state', 'The source Draft state is stale.')
    }
    let superseded: Draft
    try {
      superseded = applyDraftStateTransition(source, transition)
    } catch {
      throw new DraftActionStateError('stale_state', 'The source Draft state is stale.')
    }
    const latest = database
      .prepare(`SELECT id FROM drafts WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(source.workItemId) as { readonly id: unknown } | undefined
    if (latest?.id !== source.id) {
      throw new DraftActionStateError('revision_conflict', 'The Draft revision is not next.')
    }
    const workItem = database
      .prepare(`SELECT selected_persona_id, updated_at FROM work_items WHERE id = ?`)
      .get(draft.workItemId) as
      { readonly selected_persona_id: unknown; readonly updated_at: unknown } | undefined
    if (workItem === undefined) {
      throw new DraftActionStateError('missing_work_item', 'The Draft Work Item is missing.')
    }
    if (workItem.selected_persona_id !== draft.personaId) {
      throw new DraftActionStateError('persona_mismatch', 'The Draft Persona does not match.')
    }
    if (
      typeof workItem.updated_at !== 'string' ||
      Date.parse(draft.createdAt) < Date.parse(workItem.updated_at)
    ) {
      throw new DraftActionStateError('invalid_request', 'The Draft chronology is invalid.')
    }
    const transitionInserted = database
      .prepare(
        `INSERT INTO draft_state_transitions
           (kind, schema_version, id, draft_id, from_state, to_state, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.kind,
        transition.schemaVersion,
        transition.id,
        transition.draftId,
        transition.fromState,
        transition.toState,
        transition.occurredAt,
      )
    const sourceUpdated = database
      .prepare(`UPDATE drafts SET state = ?, updated_at = ? WHERE id = ?`)
      .run(superseded.state, superseded.updatedAt, superseded.id)
    const draftInserted = database
      .prepare(
        `INSERT INTO drafts (
           kind, schema_version, id, work_item_id, persona_id, session_id, run_id,
           revision, state, media_type, content_text, rationale, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.kind,
        draft.schemaVersion,
        draft.id,
        draft.workItemId,
        draft.personaId,
        draft.sessionId ?? null,
        draft.runId ?? null,
        draft.revision,
        draft.state,
        draft.content.mediaType,
        draft.content.text,
        draft.rationale ?? null,
        draft.createdAt,
        draft.updatedAt,
      )
    const creationInserted = database
      .prepare(
        `INSERT INTO draft_creation_records
           (kind, schema_version, draft_id, initial_state, initial_updated_at)
         VALUES ('draft_creation_record', 1, ?, ?, ?)`,
      )
      .run(draft.id, draft.state, draft.updatedAt)
    if (
      transitionInserted.changes !== 1 ||
      sourceUpdated.changes !== 1 ||
      draftInserted.changes !== 1 ||
      creationInserted.changes !== 1
    ) {
      throw new DraftActionStateError('storage_error', 'The Draft revision was not stored.')
    }
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', source: superseded, draft })
  } catch (error) {
    rollback(database)
    if (error instanceof DraftActionStateError) throw error
    throw new DraftActionStateError('storage_error', 'The Draft revision could not be stored.')
  }
}

export function createActionProposal(
  database: DatabaseSync,
  input: ActionProposal,
): ActionProposalWriteResult {
  const proposal = parseActionProposal(input)
  if (proposal.state !== 'proposed') {
    throw new DraftActionStateError('invalid_request', 'A new ActionProposal must be proposed.')
  }
  if (computeDraftContentDigest(proposal.content) !== proposal.contentDigest) {
    throw new DraftActionStateError(
      'digest_mismatch',
      'The proposal content digest does not match.',
    )
  }
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new DraftActionStateError('storage_error', 'The proposal transaction could not start.')
  }
  try {
    const existing = database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM action_proposals WHERE id = ? OR idempotency_key = ?`,
      )
      .all(proposal.id, proposal.idempotencyKey) as unknown as ProposalRow[]
    if (existing.length > 0) {
      const stored =
        existing.length === 1 ? parseStoredProposal(existing[0] as ProposalRow) : undefined
      const creation =
        stored === undefined
          ? undefined
          : (database
              .prepare(
                `SELECT initial_state, initial_updated_at
                 FROM action_proposal_creation_records WHERE proposal_id = ?`,
              )
              .get(stored.id) as CreationStateRow | undefined)
      const duplicate = stored !== undefined && sameProposalCreation(stored, creation, proposal)
      if (!duplicate) {
        throw new DraftActionStateError('proposal_conflict', 'The proposal identity conflicts.')
      }
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', proposal: stored })
    }
    const workItem = database
      .prepare(`SELECT thread_id, updated_at FROM work_items WHERE id = ?`)
      .get(proposal.workItemId) as
      { readonly thread_id: unknown; readonly updated_at: unknown } | undefined
    if (workItem === undefined) {
      throw new DraftActionStateError('missing_work_item', 'The proposal Work Item is missing.')
    }
    if (
      typeof workItem.updated_at !== 'string' ||
      Date.parse(proposal.createdAt) < Date.parse(workItem.updated_at)
    ) {
      throw new DraftActionStateError('invalid_request', 'The proposal chronology is invalid.')
    }
    if (proposal.draftId !== undefined) {
      const draft = readDraft(database, proposal.draftId)
      if (draft === undefined) {
        throw new DraftActionStateError('missing_draft', 'The proposal Draft is missing.')
      }
      if (
        draft.workItemId !== proposal.workItemId ||
        draft.state !== 'ready_for_review' ||
        draft.content.mediaType !== proposal.content.mediaType ||
        draft.content.text !== proposal.content.text ||
        Date.parse(proposal.createdAt) < Date.parse(draft.updatedAt) ||
        Date.parse(draft.updatedAt) < Date.parse(workItem.updated_at)
      ) {
        throw new DraftActionStateError('draft_conflict', 'The proposal does not match its Draft.')
      }
    }
    if (typeof workItem.thread_id !== 'string') {
      throw new DraftActionStateError('stored_record_invalid', 'The Work Item is invalid.')
    }
    const target = database
      .prepare(
        `SELECT 1 AS matched
         FROM thread_external_references
         WHERE thread_id = ?
           AND connector_id = ?
           AND account_id = ?
           AND object_type = ?
           AND external_id = ?
           AND (
             (source_timestamp IS NULL AND ? IS NULL) OR
             source_timestamp = ?
           )
         LIMIT 1`,
      )
      .get(
        workItem.thread_id,
        proposal.target.connectorId,
        proposal.target.accountId,
        proposal.target.objectType,
        proposal.target.externalId,
        proposal.target.sourceTimestamp ?? null,
        proposal.target.sourceTimestamp ?? null,
      ) as { readonly matched: unknown } | undefined
    if (target?.matched !== 1) {
      throw new DraftActionStateError(
        'target_mismatch',
        'The proposal target does not belong to its Work Item.',
      )
    }
    const inserted = database
      .prepare(
        `INSERT INTO action_proposals (
           kind, schema_version, id, work_item_id, draft_id, action_type, risk,
           identity_connector_id, identity_account_id, identity_type, identity_display_name,
           target_connector_id, target_account_id, target_object_type, target_external_id,
           target_source_timestamp, media_type, content_text, content_digest, idempotency_key,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.kind,
        proposal.schemaVersion,
        proposal.id,
        proposal.workItemId,
        proposal.draftId ?? null,
        proposal.actionType,
        proposal.risk,
        proposal.identity.connectorId,
        proposal.identity.accountId,
        proposal.identity.identityType,
        proposal.identity.displayName,
        proposal.target.connectorId,
        proposal.target.accountId,
        proposal.target.objectType,
        proposal.target.externalId,
        proposal.target.sourceTimestamp ?? null,
        proposal.content.mediaType,
        proposal.content.text,
        proposal.contentDigest,
        proposal.idempotencyKey,
        proposal.state,
        proposal.createdAt,
        proposal.updatedAt,
      )
    if (inserted.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The ActionProposal was not stored.')
    }
    const creationInserted = database
      .prepare(
        `INSERT INTO action_proposal_creation_records
           (kind, schema_version, proposal_id, initial_state, initial_updated_at)
         VALUES ('action_proposal_creation_record', 1, ?, ?, ?)`,
      )
      .run(proposal.id, proposal.state, proposal.updatedAt)
    if (creationInserted.changes !== 1) {
      throw new DraftActionStateError(
        'storage_error',
        'The ActionProposal creation was not stored.',
      )
    }
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', proposal })
  } catch (error) {
    rollback(database)
    if (error instanceof DraftActionStateError) throw error
    throw new DraftActionStateError('storage_error', 'The ActionProposal could not be stored.')
  }
}

export function transitionActionProposal(
  database: DatabaseSync,
  input: ActionProposalStateTransition,
): ActionProposalTransitionWriteResult {
  const transition = parseActionProposalStateTransition(input)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new DraftActionStateError('storage_error', 'The proposal transition could not start.')
  }
  try {
    const existing = database
      .prepare(
        `SELECT kind, schema_version, id, proposal_id AS record_id, from_state, to_state, occurred_at
         FROM action_proposal_state_transitions WHERE id = ?`,
      )
      .get(transition.id) as TransitionRow | undefined
    if (existing !== undefined) {
      if (!sameProposalTransition(existing, transition)) {
        throw new DraftActionStateError('transition_conflict', 'The transition identity conflicts.')
      }
      const proposal = readActionProposal(database, transition.proposalId)
      if (proposal === undefined) {
        throw new DraftActionStateError('missing_proposal', 'The ActionProposal is missing.')
      }
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', proposal })
    }
    const proposal = readActionProposal(database, transition.proposalId)
    if (proposal === undefined) {
      throw new DraftActionStateError('missing_proposal', 'The ActionProposal is missing.')
    }
    let updated: ActionProposal
    try {
      updated = applyActionProposalStateTransition(proposal, transition)
    } catch {
      throw new DraftActionStateError('stale_state', 'The proposal transition is stale or invalid.')
    }
    const transitionInserted = database
      .prepare(
        `INSERT INTO action_proposal_state_transitions
           (kind, schema_version, id, proposal_id, from_state, to_state, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.kind,
        transition.schemaVersion,
        transition.id,
        transition.proposalId,
        transition.fromState,
        transition.toState,
        transition.occurredAt,
      )
    if (transitionInserted.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The proposal transition was not stored.')
    }
    const updatedRow = database
      .prepare(`UPDATE action_proposals SET state = ?, updated_at = ? WHERE id = ?`)
      .run(updated.state, updated.updatedAt, updated.id)
    if (updatedRow.changes !== 1) {
      throw new DraftActionStateError('storage_error', 'The ActionProposal was not updated.')
    }
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'applied', proposal: updated })
  } catch (error) {
    rollback(database)
    if (error instanceof DraftActionStateError) throw error
    throw new DraftActionStateError('storage_error', 'The proposal transition could not be stored.')
  }
}
