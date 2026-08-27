import {
  parseExternalEvent,
  parseExternalThread,
  parseAuditRecord,
  parseWorkItem,
  type AuditCategory,
  type AuditOutcome,
  type AuditRecord,
  type ExternalEvent,
  type ExternalThread,
  type InboxState,
  type WorkItem,
} from '@twindesk/domain'
import { openTwinDeskDatabase, type TwinDeskDatabase } from '@twindesk/storage-sqlite'

import { findBuiltInPersonaConfiguration } from './persona-presets.ts'

export const FIXTURE_INBOX_STATES = Object.freeze([
  'needs_reply',
  'needs_review',
  'waiting',
  'done',
] as const)

export interface FixtureInboxSource {
  readonly label: string
  readonly objectType: string
}

export interface FixtureInboxContext {
  readonly status: 'complete' | 'partial'
  readonly missing: readonly string[]
}

export interface FixtureInboxItem {
  readonly id: string
  readonly inboxState: InboxState
  readonly title: string
  readonly summary: string
  readonly attentionReason: string
  readonly personaId?: string
  readonly personaLabel?: string
  readonly source: FixtureInboxSource
  readonly context: FixtureInboxContext
  readonly sourceCount: number
  readonly updatedAt: string
}

export interface FixtureInboxSnapshot {
  readonly version: 1
  readonly fixture: true
  readonly counts: Readonly<Record<InboxState, number>>
  readonly items: readonly FixtureInboxItem[]
}

export interface FixtureInboxService {
  read(state?: InboxState): FixtureInboxSnapshot
  readAudit(): FixtureAuditSnapshot
  close(): void
}

export interface FixtureAuditItem {
  readonly category: AuditCategory
  readonly outcome: AuditOutcome
  readonly actorType: AuditRecord['actor']['type']
  readonly actorLabel: string
  readonly summary: string
  readonly referenceKinds: readonly AuditRecord['references'][number]['kind'][]
  readonly occurredAt: string
}

export interface FixtureAuditSnapshot {
  readonly version: 1
  readonly fixture: true
  readonly items: readonly FixtureAuditItem[]
}

export interface FixtureInboxServiceOptions {
  /** Seed presentation-safe synthetic Audit records for the product Web shell. */
  readonly includeAudit?: boolean
}

interface FixtureDefinition {
  readonly suffix: string
  readonly timestamp: string
  readonly inboxState: InboxState
  readonly title: string
  readonly subject: string
  readonly summary: string
  readonly attentionReason: string
  readonly personaId?: string
  readonly context: FixtureInboxContext
}

interface FixtureRecords {
  readonly event: ExternalEvent
  readonly thread: ExternalThread
  readonly workItem: WorkItem
}

const DEFINITIONS: readonly FixtureDefinition[] = Object.freeze([
  {
    suffix: 'release-risk-question',
    timestamp: '2026-08-26T09:15:00Z',
    inboxState: 'needs_reply',
    title: 'Reply to a release-risk question',
    subject: 'Release readiness follow-up',
    summary: 'A teammate asks whether the staged rollout can proceed this afternoon.',
    attentionReason: 'A direct question is waiting for a response.',
    personaId: 'communication',
    context: { status: 'complete', missing: [] },
  },
  {
    suffix: 'deployment-update-review',
    timestamp: '2026-08-26T08:40:00Z',
    inboxState: 'needs_review',
    title: 'Review a deployment update',
    subject: 'Synthetic deployment update',
    summary: 'A draft technical update contains an unresolved dependency claim.',
    attentionReason: 'Technical evidence should be checked before the update is used.',
    personaId: 'technical-lead',
    context: { status: 'partial', missing: ['Linked issue details'] },
  },
  {
    suffix: 'project-owner-wait',
    timestamp: '2026-08-26T07:50:00Z',
    inboxState: 'waiting',
    title: 'Waiting for the project owner',
    subject: 'Rollout ownership confirmation',
    summary:
      'The next step is blocked until a synthetic project owner confirms the rollout window.',
    attentionReason: 'No action is required until the expected response arrives.',
    context: { status: 'complete', missing: [] },
  },
  {
    suffix: 'weekly-status-complete',
    timestamp: '2026-08-25T16:30:00Z',
    inboxState: 'done',
    title: 'Weekly status review completed',
    subject: 'Synthetic weekly status',
    summary: 'The synthetic status item was reviewed and requires no further action.',
    attentionReason: 'The local fixture workflow is complete.',
    personaId: 'communication',
    context: { status: 'complete', missing: [] },
  },
])

function fixtureRecords(definition: FixtureDefinition): FixtureRecords {
  const source = {
    connectorId: 'fixture',
    accountId: 'synthetic-account',
    objectType: 'message',
    externalId: `synthetic-message-${definition.suffix}`,
    sourceTimestamp: definition.timestamp,
  }
  const event = parseExternalEvent({
    kind: 'external_event',
    schemaVersion: 1,
    id: `fixture-event-${definition.suffix}`,
    idempotencyKey: `fixture:inbox:${definition.suffix}:v1`,
    source,
    eventType: 'message.received',
    occurredAt: definition.timestamp,
    receivedAt: definition.timestamp,
    context:
      definition.context.status === 'complete'
        ? { status: 'complete' }
        : { status: 'partial', missing: definition.context.missing },
    normalized: { fixture: true, subject: definition.subject },
  })
  const thread = parseExternalThread({
    kind: 'external_thread',
    schemaVersion: 1,
    id: `fixture-thread-${definition.suffix}`,
    subject: definition.subject,
    externalReferences: [source],
    sourceEventIds: [event.id],
    createdAt: definition.timestamp,
    updatedAt: definition.timestamp,
  })
  const workItem = parseWorkItem({
    kind: 'work_item',
    schemaVersion: 1,
    id: `fixture-work-item-${definition.suffix}`,
    threadId: thread.id,
    sourceEventIds: [event.id],
    inboxState: definition.inboxState,
    title: definition.title,
    summary: definition.summary,
    attentionReason: definition.attentionReason,
    ...(definition.personaId === undefined ? {} : { selectedPersonaId: definition.personaId }),
    createdAt: definition.timestamp,
    updatedAt: definition.timestamp,
  })
  return { event, thread, workItem }
}

const FIXTURE_RECORDS = Object.freeze(DEFINITIONS.map(fixtureRecords))

const FIXTURE_AUDIT_RECORDS = Object.freeze(
  DEFINITIONS.map((definition, index) => {
    const records = FIXTURE_RECORDS[index]
    if (records === undefined) throw new Error('Fixture Audit definition is missing its records.')
    const persona =
      definition.personaId === undefined
        ? undefined
        : findBuiltInPersonaConfiguration(definition.personaId)
    return parseAuditRecord({
      kind: 'audit_record',
      schemaVersion: 1,
      id: `fixture-audit-routing-${definition.suffix}`,
      category: 'routing',
      outcome: 'success',
      actor: { type: 'system' },
      summary:
        persona === undefined
          ? 'Synthetic Work Item routing completed without a selected Persona.'
          : `Synthetic Work Item routed to ${persona.name}.`,
      references: [
        { kind: 'work_item', id: records.workItem.id },
        { kind: 'external_thread', id: records.thread.id },
        { kind: 'external_event', id: records.event.id },
      ],
      details: {
        fixture: true,
        contextStatus: definition.context.status,
        personaSelected: persona !== undefined,
      },
      occurredAt: definition.timestamp,
    })
  }),
)

function seed(database: TwinDeskDatabase, includeAudit: boolean): void {
  database.ingestExternalEvents(FIXTURE_RECORDS.map(({ event }) => event))
  for (const { thread, workItem } of FIXTURE_RECORDS) {
    database.putWorkItemProjection({ thread, workItem })
  }
  if (includeAudit) database.appendAuditRecords(FIXTURE_AUDIT_RECORDS)
}

function readFixtureItems(database: TwinDeskDatabase): readonly WorkItem[] {
  const items: WorkItem[] = []
  for (const { workItem } of FIXTURE_RECORDS) {
    const current = database.getWorkItem(workItem.id)
    if (current !== undefined) items.push(current)
  }
  items.sort((left, right) => {
    const chronological = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return chronological === 0 ? left.id.localeCompare(right.id) : chronological
  })
  return items
}

function counts(items: readonly WorkItem[]): Readonly<Record<InboxState, number>> {
  const result: Record<InboxState, number> = {
    needs_reply: 0,
    needs_review: 0,
    waiting: 0,
    done: 0,
  }
  for (const item of items) result[item.inboxState] += 1
  return Object.freeze(result)
}

function projectItem(item: WorkItem): FixtureInboxItem {
  const definition = DEFINITIONS.find(({ suffix }) => item.id === `fixture-work-item-${suffix}`)
  const context = definition?.context ?? { status: 'partial', missing: ['Fixture metadata'] }
  const persona =
    item.selectedPersonaId === undefined
      ? undefined
      : findBuiltInPersonaConfiguration(item.selectedPersonaId)
  return Object.freeze({
    id: item.id,
    inboxState: item.inboxState,
    title: item.title,
    summary: item.summary,
    attentionReason: item.attentionReason,
    ...(item.selectedPersonaId === undefined ? {} : { personaId: item.selectedPersonaId }),
    ...(persona === undefined ? {} : { personaLabel: persona.name }),
    source: Object.freeze({ label: 'Synthetic fixture', objectType: 'message' }),
    context: Object.freeze({
      status: context.status,
      missing: Object.freeze([...context.missing]),
    }),
    sourceCount: item.sourceEventIds.length,
    updatedAt: item.updatedAt,
  })
}

function projectAuditRecord(record: AuditRecord): FixtureAuditItem {
  const actorLabel: Readonly<Record<AuditRecord['actor']['type'], string>> = {
    system: 'TwinDesk',
    user: 'Local user',
    persona: 'Persona',
    connector: 'Connector',
  }
  return Object.freeze({
    category: record.category,
    outcome: record.outcome,
    actorType: record.actor.type,
    actorLabel: actorLabel[record.actor.type],
    summary: record.summary,
    referenceKinds: Object.freeze(record.references.map(({ kind }) => kind)),
    occurredAt: record.occurredAt,
  })
}

/**
 * Open an idempotently seeded, read-only-at-the-API-boundary Stage 1 Inbox service.
 * The caller chooses whether the SQLite database is in-memory or durable.
 */
export function createFixtureInboxService(
  databasePath = ':memory:',
  options: FixtureInboxServiceOptions = {},
): FixtureInboxService {
  const database = openTwinDeskDatabase(databasePath)
  try {
    seed(database, options.includeAudit === true)
  } catch (error) {
    database.close()
    throw error
  }

  let closed = false
  return {
    read(state) {
      if (closed) throw new Error('The fixture Inbox service is closed.')
      if (state !== undefined && !FIXTURE_INBOX_STATES.includes(state)) {
        throw new TypeError('The Inbox state is not supported.')
      }
      const allItems = readFixtureItems(database)
      const visibleItems =
        state === undefined ? allItems : allItems.filter((item) => item.inboxState === state)
      return Object.freeze({
        version: 1,
        fixture: true,
        counts: counts(allItems),
        items: Object.freeze(visibleItems.map(projectItem)),
      })
    },
    readAudit() {
      if (closed) throw new Error('The fixture Inbox service is closed.')
      return Object.freeze({
        version: 1,
        fixture: true,
        items: Object.freeze(
          database.queryAuditTimeline({ limit: 100 }).records.map(projectAuditRecord),
        ),
      })
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
