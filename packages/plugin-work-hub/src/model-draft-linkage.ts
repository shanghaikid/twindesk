import { parseAuditRecord, parseDraft, type AuditRecord, type Draft } from '@twindesk/domain'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

export const WORK_HUB_MODEL_DRAFT_LINKAGE_VERSION = 1 as const

export type WorkHubModelDraftLinkageErrorCode =
  'invalid_options' | 'invalid_request' | 'draft_unavailable' | 'audit_unavailable'

export class WorkHubModelDraftLinkageError extends Error {
  readonly code: WorkHubModelDraftLinkageErrorCode

  constructor(code: WorkHubModelDraftLinkageErrorCode, message: string) {
    super(message)
    this.name = 'WorkHubModelDraftLinkageError'
    this.code = code
  }
}

export interface WorkHubModelDraftLinkageRequest {
  readonly kind: 'work_hub_model_draft_linkage_request'
  readonly schemaVersion: typeof WORK_HUB_MODEL_DRAFT_LINKAGE_VERSION
  /** A completed Draft whose referenced Harness Session has already been durably flushed. */
  readonly draft: Draft
}

export interface WorkHubModelDraftLinkageResult {
  readonly disposition: 'inserted' | 'repaired' | 'duplicate'
  readonly draft: Draft
  readonly audit: AuditRecord
}

export interface WorkHubModelDraftLinkageOptions {
  readonly database: TwinDeskDatabase
}

type ParsedOptions = Readonly<{ database: TwinDeskDatabase }>
type ParsedDraftWrite = Readonly<{
  disposition: 'inserted' | 'duplicate'
  draft: Draft
}>

function fail(
  code: WorkHubModelDraftLinkageErrorCode,
  message: string,
): WorkHubModelDraftLinkageError {
  return new WorkHubModelDraftLinkageError(code, message)
}

function optionsAt(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const databaseDescriptor = descriptors.database
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      databaseDescriptor === undefined ||
      !Object.hasOwn(databaseDescriptor, 'value')
    ) {
      throw new TypeError()
    }
    const database = databaseDescriptor.value
    if (
      typeof database !== 'object' ||
      database === null ||
      typeof Reflect.get(database, 'createDraft') !== 'function' ||
      typeof Reflect.get(database, 'appendAuditRecords') !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ database: database as TwinDeskDatabase })
  } catch {
    throw fail('invalid_options', 'The Work Hub model Draft linkage options are invalid.')
  }
}

function requestAt(value: unknown): WorkHubModelDraftLinkageRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 3 ||
      !['kind', 'schemaVersion', 'draft'].every((key) => Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.kind?.value !== 'work_hub_model_draft_linkage_request' ||
      descriptors.schemaVersion?.value !== WORK_HUB_MODEL_DRAFT_LINKAGE_VERSION
    ) {
      throw new TypeError()
    }
    const draft = parseDraft(descriptors.draft?.value)
    if (
      draft.state !== 'editing' ||
      draft.sessionId === undefined ||
      draft.runId === undefined ||
      draft.id.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/u.test(draft.sessionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/u.test(draft.runId) ||
      Buffer.byteLength(draft.content.text, 'utf8') > 64 * 1_024 ||
      (draft.rationale !== undefined && Buffer.byteLength(draft.rationale, 'utf8') > 1_024)
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      kind: 'work_hub_model_draft_linkage_request',
      schemaVersion: WORK_HUB_MODEL_DRAFT_LINKAGE_VERSION,
      draft,
    })
  } catch {
    throw fail('invalid_request', 'The Work Hub model Draft linkage request is invalid.')
  }
}

function dataObjectAt(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    throw new TypeError()
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function sameDraftCreationEvidence(left: Draft, right: Draft): boolean {
  return (
    left.id === right.id &&
    left.workItemId === right.workItemId &&
    left.personaId === right.personaId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.content.mediaType === right.content.mediaType &&
    left.content.text === right.content.text &&
    left.rationale === right.rationale &&
    left.createdAt === right.createdAt
  )
}

function draftWriteAt(value: unknown, expected: Draft): ParsedDraftWrite {
  const result = dataObjectAt(value, ['disposition', 'draft'])
  if (result.disposition !== 'inserted' && result.disposition !== 'duplicate') {
    throw new TypeError()
  }
  const draft = parseDraft(result.draft)
  if (
    !sameDraftCreationEvidence(draft, expected) ||
    Date.parse(draft.updatedAt) < Date.parse(expected.updatedAt) ||
    (result.disposition === 'inserted' &&
      (draft.state !== expected.state || draft.updatedAt !== expected.updatedAt))
  ) {
    throw new TypeError()
  }
  return Object.freeze({ disposition: result.disposition, draft })
}

function auditWriteAt(value: unknown): 'inserted' | 'duplicate' {
  const result = dataObjectAt(value, ['insertedCount', 'duplicateCount', 'items'])
  if (!Array.isArray(result.items)) throw new TypeError()
  const itemDescriptors = Object.getOwnPropertyDescriptors(result.items) as Record<
    string,
    PropertyDescriptor
  >
  if (
    Object.getPrototypeOf(result.items) !== Array.prototype ||
    Object.getOwnPropertySymbols(result.items).length !== 0 ||
    Object.keys(itemDescriptors).length !== 2 ||
    !Object.hasOwn(itemDescriptors, '0') ||
    !Object.hasOwn(itemDescriptors, 'length') ||
    itemDescriptors.length?.value !== 1 ||
    !Object.hasOwn(itemDescriptors[0] ?? {}, 'value')
  ) {
    throw new TypeError()
  }
  const item = dataObjectAt(itemDescriptors[0]?.value, ['inputIndex', 'disposition'])
  if (
    item.inputIndex !== 0 ||
    (item.disposition !== 'inserted' && item.disposition !== 'duplicate') ||
    result.insertedCount !== (item.disposition === 'inserted' ? 1 : 0) ||
    result.duplicateCount !== (item.disposition === 'duplicate' ? 1 : 0)
  ) {
    throw new TypeError()
  }
  return item.disposition
}

function auditFor(draft: Draft): AuditRecord {
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: `${draft.id}:model-run`,
    category: 'run',
    outcome: 'success',
    actor: { type: 'persona', id: draft.personaId },
    summary: 'A model-backed Draft was recorded for user review.',
    references: [
      { kind: 'work_item', id: draft.workItemId },
      { kind: 'draft', id: draft.id },
      { kind: 'session', id: draft.sessionId as string },
      { kind: 'run', id: draft.runId as string },
    ],
    details: {
      modelInvocation: true,
      revision: draft.revision,
      state: 'editing',
    },
    occurredAt: draft.updatedAt,
  })
}

/**
 * Link a caller-supplied, durably flushed Harness Session/Run to one local editing Draft.
 * Draft persistence precedes Audit so an interrupted Audit can be repaired by
 * exact replay without invoking the model again.
 */
export function createWorkHubModelDraftLinkage(
  optionsValue: WorkHubModelDraftLinkageOptions,
): Readonly<{
  record(request: WorkHubModelDraftLinkageRequest): WorkHubModelDraftLinkageResult
}> {
  const options = optionsAt(optionsValue)
  return Object.freeze({
    record(requestValue: WorkHubModelDraftLinkageRequest): WorkHubModelDraftLinkageResult {
      const request = requestAt(requestValue)
      let draftWrite: ParsedDraftWrite
      try {
        draftWrite = draftWriteAt(options.database.createDraft(request.draft), request.draft)
      } catch {
        throw fail('draft_unavailable', 'The model-backed Draft could not be stored.')
      }
      const audit = auditFor(request.draft)
      let auditDisposition: 'inserted' | 'duplicate'
      try {
        auditDisposition = auditWriteAt(options.database.appendAuditRecords([audit]))
      } catch {
        throw fail('audit_unavailable', 'The model-backed Draft Audit could not be stored.')
      }
      const disposition =
        draftWrite.disposition === 'inserted'
          ? 'inserted'
          : auditDisposition === 'inserted'
            ? 'repaired'
            : 'duplicate'
      return Object.freeze({ disposition, draft: draftWrite.draft, audit })
    },
  })
}
