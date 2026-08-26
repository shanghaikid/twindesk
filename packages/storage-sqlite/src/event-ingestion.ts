import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  parseExternalEvent,
  type ExternalEvent,
  type ExternalEventId,
  type JsonValue,
} from '@twindesk/domain'

export type EventIngestionErrorCode =
  'database_closed' | 'idempotency_conflict' | 'stored_event_invalid' | 'write_failed'

export type EventConflictKey = 'id' | 'idempotency_key' | 'both'

export class EventIngestionError extends Error {
  readonly code: EventIngestionErrorCode
  readonly inputIndex: number | undefined
  readonly conflictKey: EventConflictKey | undefined

  constructor(
    code: EventIngestionErrorCode,
    message: string,
    details: {
      readonly inputIndex?: number
      readonly conflictKey?: EventConflictKey
    } = {},
  ) {
    super(message)
    this.name = 'EventIngestionError'
    this.code = code
    this.inputIndex = details.inputIndex
    this.conflictKey = details.conflictKey
  }
}

export interface EventIngestionItem {
  readonly inputIndex: number
  readonly eventId: ExternalEventId
  readonly disposition: 'inserted' | 'duplicate'
}

export interface EventIngestionResult {
  readonly insertedCount: number
  readonly duplicateCount: number
  readonly items: readonly EventIngestionItem[]
}

interface ExternalEventRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly idempotency_key: unknown
  readonly connector_id: unknown
  readonly account_id: unknown
  readonly object_type: unknown
  readonly external_id: unknown
  readonly source_timestamp: unknown
  readonly event_type: unknown
  readonly occurred_at: unknown
  readonly received_at: unknown
  readonly context_status: unknown
  readonly context_missing_json: unknown
  readonly normalized_json: unknown
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(',')}}`
}

function eventDigest(event: ExternalEvent): string {
  const missing = event.context.status === 'partial' ? [...event.context.missing].sort() : null
  const canonicalRecord: JsonValue = [
    event.kind,
    event.schemaVersion,
    event.id,
    event.idempotencyKey,
    event.source.connectorId,
    event.source.accountId,
    event.source.objectType,
    event.source.externalId,
    event.source.sourceTimestamp ?? null,
    event.eventType,
    event.occurredAt,
    event.context.status,
    missing,
    event.normalized,
  ]
  return createHash('sha256').update(canonicalJson(canonicalRecord), 'utf8').digest('hex')
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new TypeError('Stored JSON is not text.')
  return JSON.parse(value) as unknown
}

function parseStoredEvent(row: ExternalEventRow): ExternalEvent {
  try {
    const context =
      row.context_status === 'complete'
        ? { status: 'complete' }
        : {
            status: row.context_status,
            missing: parseStoredJson(row.context_missing_json),
          }
    const source = {
      connectorId: row.connector_id,
      accountId: row.account_id,
      objectType: row.object_type,
      externalId: row.external_id,
      ...(row.source_timestamp === null ? {} : { sourceTimestamp: row.source_timestamp }),
    }
    return parseExternalEvent({
      kind: row.kind,
      schemaVersion: row.schema_version,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      source,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      context,
      normalized: parseStoredJson(row.normalized_json),
    })
  } catch {
    throw new EventIngestionError(
      'stored_event_invalid',
      'A stored external event does not match the supported schema.',
    )
  }
}

function conflictKey(row: ExternalEventRow, event: ExternalEvent): EventConflictKey | undefined {
  const idMatches = row.id === event.id
  const idempotencyKeyMatches = row.idempotency_key === event.idempotencyKey
  if (idMatches && idempotencyKeyMatches) return 'both'
  if (idMatches) return 'id'
  if (idempotencyKeyMatches) return 'idempotency_key'
  return undefined
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed ingestion failure if SQLite already rolled back.
  }
}

function prepareIngestionStatements(database: DatabaseSync) {
  try {
    return {
      findExisting: database.prepare(
        `SELECT kind, schema_version, id, idempotency_key, connector_id, account_id,
                object_type, external_id, source_timestamp, event_type, occurred_at,
                received_at, context_status, context_missing_json, normalized_json
         FROM external_events
         WHERE id = ? OR idempotency_key = ?`,
      ),
      insert: database.prepare(
        `INSERT INTO external_events (
           kind, schema_version, id, idempotency_key, connector_id, account_id,
           object_type, external_id, source_timestamp, event_type, occurred_at,
           received_at, context_status, context_missing_json, normalized_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
    }
  } catch {
    throw new EventIngestionError('write_failed', 'External event storage is unavailable.')
  }
}

export function ingestExternalEvents(
  database: DatabaseSync,
  input: readonly ExternalEvent[],
): EventIngestionResult {
  if (!Array.isArray(input)) throw new TypeError('External event batch must be an array.')
  const events = Array.from(input, (event) => parseExternalEvent(event))
  if (events.length === 0) {
    return Object.freeze({ insertedCount: 0, duplicateCount: 0, items: Object.freeze([]) })
  }

  const { findExisting, insert } = prepareIngestionStatements(database)
  const items: EventIngestionItem[] = []
  let insertedCount = 0
  let duplicateCount = 0
  let activeInputIndex: number | undefined

  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new EventIngestionError('write_failed', 'The external event transaction could not start.')
  }
  try {
    for (let inputIndex = 0; inputIndex < events.length; inputIndex += 1) {
      activeInputIndex = inputIndex
      const event = events[inputIndex]
      if (event === undefined) continue
      const rows = findExisting.all(event.id, event.idempotencyKey) as unknown as ExternalEventRow[]

      if (rows.length > 0) {
        const matchingRow = rows.find(
          (row) => eventDigest(parseStoredEvent(row)) === eventDigest(event),
        )
        if (matchingRow !== undefined && rows.length === 1) {
          duplicateCount += 1
          items.push(Object.freeze({ inputIndex, eventId: event.id, disposition: 'duplicate' }))
          continue
        }

        const key = rows
          .map((row) => conflictKey(row, event))
          .reduce<EventConflictKey | undefined>((combined, current) => {
            if (combined === undefined) return current
            if (current === undefined || current === combined) return combined
            return 'both'
          }, undefined)
        throw new EventIngestionError(
          'idempotency_conflict',
          'An external event conflicts with an existing stable identity.',
          { inputIndex, conflictKey: key ?? 'both' },
        )
      }

      const missingJson =
        event.context.status === 'partial' ? canonicalJson([...event.context.missing].sort()) : null
      const result = insert.run(
        event.kind,
        event.schemaVersion,
        event.id,
        event.idempotencyKey,
        event.source.connectorId,
        event.source.accountId,
        event.source.objectType,
        event.source.externalId,
        event.source.sourceTimestamp ?? null,
        event.eventType,
        event.occurredAt,
        event.receivedAt,
        event.context.status,
        missingJson,
        canonicalJson(event.normalized),
      )
      if (result.changes !== 1) {
        throw new EventIngestionError('write_failed', 'External event insertion did not commit.')
      }
      insertedCount += 1
      items.push(Object.freeze({ inputIndex, eventId: event.id, disposition: 'inserted' }))
    }
    database.exec('COMMIT')
  } catch (error) {
    rollback(database)
    if (error instanceof EventIngestionError) throw error
    throw new EventIngestionError(
      'write_failed',
      'The external event batch could not be stored.',
      activeInputIndex === undefined ? {} : { inputIndex: activeInputIndex },
    )
  }

  return Object.freeze({
    insertedCount,
    duplicateCount,
    items: Object.freeze(items),
  })
}
