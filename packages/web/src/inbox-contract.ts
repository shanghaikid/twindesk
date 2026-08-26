export type InboxState = 'needs_reply' | 'needs_review' | 'waiting' | 'done'

export interface InboxItem {
  readonly id: string
  readonly inboxState: InboxState
  readonly title: string
  readonly summary: string
  readonly attentionReason: string
  readonly personaId?: string
  readonly personaLabel?: string
  readonly source: { readonly label: string; readonly objectType: string }
  readonly context: { readonly status: 'complete' | 'partial'; readonly missing: readonly string[] }
  readonly sourceCount: number
  readonly updatedAt: string
}

export interface InboxSnapshot {
  readonly version: 1
  readonly fixture: true
  readonly counts: Readonly<Record<InboxState, number>>
  readonly items: readonly InboxItem[]
}

export const INBOX_STATE_IDS = Object.freeze([
  'needs_reply',
  'needs_review',
  'waiting',
  'done',
] as const)

type UnknownRecord = Readonly<Record<string, unknown>>

function invalidInboxResponse(): never {
  throw new Error('Local API returned an invalid Inbox response.')
}

function recordAt(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidInboxResponse()
  }
  return value as UnknownRecord
}

function stringAt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return invalidInboxResponse()
  return value
}

function timestampAt(value: unknown): string {
  const timestamp = stringAt(value)
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(timestamp)
  if (match === null || !Number.isFinite(Date.parse(timestamp))) return invalidInboxResponse()
  const base = timestamp.replace(/(?:\.\d{1,3})?Z$/u, '')
  const canonical = `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`
  if (new Date(timestamp).toISOString() !== canonical) return invalidInboxResponse()
  return timestamp
}

function inboxStateAt(value: unknown): InboxState {
  if (typeof value !== 'string' || !INBOX_STATE_IDS.includes(value as never)) {
    return invalidInboxResponse()
  }
  return value as InboxState
}

function countAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidInboxResponse()
  return value as number
}

function parseInboxItem(value: unknown): InboxItem {
  const item = recordAt(value)
  const source = recordAt(item.source)
  const context = recordAt(item.context)
  const contextStatus = stringAt(context.status)
  if (contextStatus !== 'complete' && contextStatus !== 'partial') return invalidInboxResponse()
  if (!Array.isArray(context.missing)) return invalidInboxResponse()
  const missing = context.missing.map(stringAt)
  if (
    (contextStatus === 'complete' && missing.length !== 0) ||
    (contextStatus === 'partial' && missing.length === 0) ||
    new Set(missing).size !== missing.length
  ) {
    return invalidInboxResponse()
  }
  const updatedAt = timestampAt(item.updatedAt)
  const personaId = item.personaId === undefined ? undefined : stringAt(item.personaId)
  const personaLabel = item.personaLabel === undefined ? undefined : stringAt(item.personaLabel)
  if (personaId === undefined && personaLabel !== undefined) return invalidInboxResponse()
  const expectedPersonaLabel =
    personaId === 'technical-lead'
      ? 'Technical Lead'
      : personaId === 'communication'
        ? 'Communication'
        : undefined
  if (
    (expectedPersonaLabel !== undefined && personaLabel !== expectedPersonaLabel) ||
    (expectedPersonaLabel === undefined && personaLabel !== undefined)
  ) {
    return invalidInboxResponse()
  }
  const sourceCount = countAt(item.sourceCount)
  if (sourceCount === 0) return invalidInboxResponse()
  return {
    id: stringAt(item.id),
    inboxState: inboxStateAt(item.inboxState),
    title: stringAt(item.title),
    summary: stringAt(item.summary),
    attentionReason: stringAt(item.attentionReason),
    ...(personaId === undefined ? {} : { personaId }),
    ...(personaLabel === undefined ? {} : { personaLabel }),
    source: { label: stringAt(source.label), objectType: stringAt(source.objectType) },
    context: { status: contextStatus, missing },
    sourceCount,
    updatedAt,
  }
}

/** Parse the versioned loopback API response before browser rendering. */
export function parseInboxSnapshot(value: unknown, requestedState: InboxState): InboxSnapshot {
  const snapshot = recordAt(value)
  if (snapshot.version !== 1 || snapshot.fixture !== true || !Array.isArray(snapshot.items)) {
    throw new Error('Local API returned an unsupported Inbox response.')
  }
  const counts = recordAt(snapshot.counts)
  const parsedCounts: Record<InboxState, number> = {
    needs_reply: countAt(counts.needs_reply),
    needs_review: countAt(counts.needs_review),
    waiting: countAt(counts.waiting),
    done: countAt(counts.done),
  }
  const items = snapshot.items.map(parseInboxItem)
  if (
    items.some(({ inboxState }) => inboxState !== requestedState) ||
    new Set(items.map(({ id }) => id)).size !== items.length ||
    parsedCounts[requestedState] !== items.length
  ) {
    throw new Error('Local API returned an inconsistent Inbox response.')
  }
  return { version: 1, fixture: true, counts: parsedCounts, items }
}
