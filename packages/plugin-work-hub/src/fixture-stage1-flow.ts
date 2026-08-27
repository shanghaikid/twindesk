import {
  parseAuditRecord,
  parseDraft,
  type Draft,
  type DraftContent,
  type DraftId,
  type WorkItemId,
} from '@twindesk/domain'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

import {
  findBuiltInPersonaConfiguration,
  mapPersonaConfigurationToPreset,
  type BuiltInPersonaId,
} from './persona-presets.ts'

export interface FixtureStage1DraftItem {
  readonly workItemId: string
  readonly draftId: string
  readonly personaId: BuiltInPersonaId
  readonly personaLabel: string
  readonly presetId: string
  readonly autonomy: 'draft_only'
  readonly authorityEffect: 'none'
  readonly externalWritesAvailable: false
  readonly state: 'ready_for_review'
  readonly content: DraftContent
  readonly rationale: string
  readonly updatedAt: string
}

export interface FixtureStage1FlowSnapshot {
  readonly version: 1
  readonly fixture: true
  readonly complete: boolean
  readonly items: readonly FixtureStage1DraftItem[]
}

export type FixtureStage1FlowErrorCode = 'missing_work_item' | 'persona_mismatch' | 'draft_mismatch'

export class FixtureStage1FlowError extends Error {
  readonly code: FixtureStage1FlowErrorCode

  constructor(code: FixtureStage1FlowErrorCode, message: string) {
    super(message)
    this.name = 'FixtureStage1FlowError'
    this.code = code
  }
}

interface FixtureStage1Definition {
  readonly suffix: string
  readonly workItemId: WorkItemId
  readonly eventId: string
  readonly draftId: DraftId
  readonly personaId: BuiltInPersonaId
  readonly createdAt: string
  readonly content: DraftContent
  readonly rationale: string
}

const FLOW_DEFINITIONS: readonly FixtureStage1Definition[] = Object.freeze([
  Object.freeze({
    suffix: 'release-risk-question',
    workItemId: 'fixture-work-item-release-risk-question' as WorkItemId,
    eventId: 'fixture-event-release-risk-question',
    draftId: 'fixture-draft-release-risk-question' as DraftId,
    personaId: 'communication',
    createdAt: '2026-08-26T09:16:00Z',
    content: Object.freeze({
      mediaType: 'text/markdown',
      text: 'I’m checking the staged rollout risks now and will share a confirmed go/no-go update this afternoon.',
    }),
    rationale:
      'The Communication Persona acknowledges the question without inventing an unverified release decision.',
  }),
  Object.freeze({
    suffix: 'deployment-update-review',
    workItemId: 'fixture-work-item-deployment-update-review' as WorkItemId,
    eventId: 'fixture-event-deployment-update-review',
    draftId: 'fixture-draft-deployment-update-review' as DraftId,
    personaId: 'technical-lead',
    createdAt: '2026-08-26T08:41:00Z',
    content: Object.freeze({
      mediaType: 'text/markdown',
      text: 'Recommendation: hold the deployment update until the unresolved dependency claim is verified. Context is partial because linked issue details are unavailable.',
    }),
    rationale:
      'The Technical Lead Persona preserves the partial-context warning and proposes a reversible next step.',
  }),
])

function definitionPersona(definition: FixtureStage1Definition) {
  const configuration = findBuiltInPersonaConfiguration(definition.personaId)
  if (configuration === undefined) {
    throw new FixtureStage1FlowError('persona_mismatch', 'A fixture Persona is not installed.')
  }
  return mapPersonaConfigurationToPreset(configuration)
}

function assertWorkItemPersona(
  database: TwinDeskDatabase,
  definition: FixtureStage1Definition,
): void {
  const workItem = database.getWorkItem(definition.workItemId)
  if (workItem === undefined) {
    throw new FixtureStage1FlowError('missing_work_item', 'A fixture Work Item is not durable.')
  }
  if (workItem.selectedPersonaId !== definition.personaId) {
    throw new FixtureStage1FlowError(
      'persona_mismatch',
      'The fixture Work Item does not have its expected Persona.',
    )
  }
}

function draftFor(definition: FixtureStage1Definition) {
  return parseDraft({
    kind: 'draft',
    schemaVersion: 1,
    id: definition.draftId,
    workItemId: definition.workItemId,
    personaId: definition.personaId,
    revision: 1,
    state: 'ready_for_review',
    content: definition.content,
    rationale: definition.rationale,
    createdAt: definition.createdAt,
    updatedAt: definition.createdAt,
  })
}

function assertDraftMatches(draft: Draft, definition: FixtureStage1Definition): void {
  if (
    draft.workItemId !== definition.workItemId ||
    draft.personaId !== definition.personaId ||
    draft.revision !== 1 ||
    draft.state !== 'ready_for_review' ||
    draft.content.mediaType !== definition.content.mediaType ||
    draft.content.text !== definition.content.text ||
    draft.rationale !== definition.rationale ||
    draft.createdAt !== definition.createdAt ||
    draft.updatedAt !== definition.createdAt
  ) {
    throw new FixtureStage1FlowError(
      'draft_mismatch',
      'A durable fixture Draft does not match its versioned definition.',
    )
  }
}

function auditFor(definition: FixtureStage1Definition) {
  const mapping = definitionPersona(definition)
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: `fixture-audit-draft-${definition.suffix}`,
    category: 'draft',
    outcome: 'success',
    actor: { type: 'persona', id: definition.personaId },
    summary: `Synthetic ${mapping.configuration.name} fixture draft is ready for review.`,
    references: [
      { kind: 'work_item', id: definition.workItemId },
      { kind: 'external_event', id: definition.eventId },
      { kind: 'draft', id: definition.draftId },
    ],
    details: {
      fixture: true,
      roadmapStage: 1,
      presetId: mapping.presetId,
      autonomy: mapping.configuration.autonomy,
      authorityEffect: mapping.authorityEffect,
      externalWritesAvailable: mapping.externalWritesAvailable,
    },
    occurredAt: definition.createdAt,
  })
}

/**
 * Idempotently complete the deterministic Stage 1 fixture path. No model call,
 * approval, Connector execution, or external side effect occurs.
 */
export function completeFixtureStage1Flow(database: TwinDeskDatabase): FixtureStage1FlowSnapshot {
  const missingDraftIds = new Set<DraftId>()
  for (const definition of FLOW_DEFINITIONS) {
    definitionPersona(definition)
    const existing = database.getDraft(definition.draftId)
    if (existing === undefined) {
      assertWorkItemPersona(database, definition)
      missingDraftIds.add(definition.draftId)
    } else assertDraftMatches(existing, definition)
  }
  for (const definition of FLOW_DEFINITIONS) {
    if (missingDraftIds.has(definition.draftId)) {
      database.createDraft(draftFor(definition))
    }
  }
  database.appendAuditRecords(FLOW_DEFINITIONS.map(auditFor))
  return readFixtureStage1Flow(database)
}

/** Read the durable fixture Draft projection without creating missing records. */
export function readFixtureStage1Flow(database: TwinDeskDatabase): FixtureStage1FlowSnapshot {
  const items = FLOW_DEFINITIONS.flatMap((definition) => {
    const draft = database.getDraft(definition.draftId)
    if (draft === undefined) return []
    assertDraftMatches(draft, definition)
    const mapping = definitionPersona(definition)
    return [
      Object.freeze({
        workItemId: definition.workItemId,
        draftId: definition.draftId,
        personaId: definition.personaId,
        personaLabel: mapping.configuration.name,
        presetId: mapping.presetId,
        autonomy: mapping.configuration.autonomy,
        authorityEffect: mapping.authorityEffect,
        externalWritesAvailable: mapping.externalWritesAvailable,
        state: 'ready_for_review' as const,
        content: Object.freeze({ ...draft.content }),
        rationale: definition.rationale,
        updatedAt: draft.updatedAt,
      }),
    ]
  })
  return Object.freeze({
    version: 1,
    fixture: true,
    complete: items.length === FLOW_DEFINITIONS.length,
    items: Object.freeze(items),
  })
}
