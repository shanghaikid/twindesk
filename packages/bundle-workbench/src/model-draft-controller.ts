import { createHash } from 'node:crypto'

import {
  parseDraft,
  parseDraftStateTransition,
  parseAuditRecord,
  type Draft,
  type DraftId,
  type WorkItemId,
} from '@twindesk/domain'
import {
  createWorkHubHarnessModelDraftOperation,
  type WorkHubHarnessModelDraftOptions,
} from '@twindesk/plugin-work-hub'
import { renderRedactedModelContext } from '@twindesk/plugin-work-hub/model-context'
import { findBuiltInPersonaConfiguration } from '@twindesk/plugin-work-hub/persona-presets'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

export type WorkbenchModelDraftErrorCode =
  'invalid_options' | 'invalid_request' | 'target_unavailable' | 'runtime_unavailable'

export class WorkbenchModelDraftError extends Error {
  readonly code: WorkbenchModelDraftErrorCode

  constructor(code: WorkbenchModelDraftErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchModelDraftError'
    this.code = code
  }
}

export interface WorkbenchModelDraftControllerOptions {
  readonly database: TwinDeskDatabase
  readonly runner: WorkHubHarnessModelDraftOptions['runner']
  /** Host-owned Harness provider route. It is never accepted from the browser. */
  readonly provider: string
  /** Host-owned model route. It is never accepted from the browser. */
  readonly model: string
  /** Trusted local clock for revision chronology. */
  readonly now?: () => number
}

export interface WorkbenchModelDraftEditRequest {
  readonly version: 1
  readonly workItemId: string
  readonly sourceRevision: number
  readonly content: {
    readonly mediaType: 'text/plain' | 'text/markdown'
    readonly text: string
  }
  readonly submitForReview: boolean
}

export interface WorkbenchModelDraftController {
  read(): Promise<unknown>
  create(workItemId: string, signal: AbortSignal): Promise<unknown>
  edit(request: WorkbenchModelDraftEditRequest, signal: AbortSignal): Promise<unknown>
}

type ParsedOptions = Readonly<Required<WorkbenchModelDraftControllerOptions>>
const MAX_MODEL_DRAFT_REVISION = 100

function fail(code: WorkbenchModelDraftErrorCode, message: string): WorkbenchModelDraftError {
  return new WorkbenchModelDraftError(code, message)
}

function routeAt(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    throw new TypeError()
  }
  return value
}

function optionsAt(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const requiredKeys = ['database', 'runner', 'provider', 'model']
    const allowedKeys = [...requiredKeys, 'now']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const database = descriptors.database?.value
    const runner = descriptors.runner?.value
    if (
      typeof database !== 'object' ||
      database === null ||
      typeof Reflect.get(database, 'getWorkItem') !== 'function' ||
      typeof Reflect.get(database, 'getDraft') !== 'function' ||
      typeof Reflect.get(database, 'createDraft') !== 'function' ||
      typeof Reflect.get(database, 'transitionDraft') !== 'function' ||
      typeof Reflect.get(database, 'reviseDraft') !== 'function' ||
      typeof Reflect.get(database, 'appendAuditRecords') !== 'function' ||
      typeof runner !== 'object' ||
      runner === null ||
      typeof Reflect.get(runner, 'run') !== 'function' ||
      (descriptors.now?.value !== undefined && typeof descriptors.now.value !== 'function')
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      database: database as TwinDeskDatabase,
      runner: runner as WorkHubHarnessModelDraftOptions['runner'],
      provider: routeAt(descriptors.provider?.value, 120),
      model: routeAt(descriptors.model?.value, 160),
      now: (descriptors.now?.value as (() => number) | undefined) ?? Date.now,
    })
  } catch {
    throw fail('invalid_options', 'The Workbench model Draft options are invalid.')
  }
}

function workItemIdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\u0000') ||
    Buffer.byteLength(value, 'utf8') > 512
  ) {
    throw fail('invalid_request', 'The Workbench model Draft request is invalid.')
  }
  return value
}

function signalAt(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Workbench model Draft request is invalid.')
  }
  return value
}

function stableSuffix(workItemId: string): string {
  return createHash('sha256')
    .update('twindesk:model-draft:v1\u0000', 'utf8')
    .update(workItemId, 'utf8')
    .digest('hex')
    .slice(0, 32)
}

function draftIdFor(workItemId: string, revision: number): DraftId {
  return (
    revision === 1
      ? `model-draft-${stableSuffix(workItemId)}`
      : `model-draft-${stableSuffix(workItemId)}-revision-${String(revision)}`
  ) as DraftId
}

function editRequestAt(value: unknown): WorkbenchModelDraftEditRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['version', 'workItemId', 'sourceRevision', 'content', 'submitForReview']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.version?.value !== 1 ||
      !Number.isSafeInteger(descriptors.sourceRevision?.value) ||
      (descriptors.sourceRevision?.value as number) < 1 ||
      (descriptors.sourceRevision?.value as number) >= MAX_MODEL_DRAFT_REVISION ||
      typeof descriptors.submitForReview?.value !== 'boolean'
    ) {
      throw new TypeError()
    }
    const contentValue = descriptors.content?.value
    if (typeof contentValue !== 'object' || contentValue === null || Array.isArray(contentValue)) {
      throw new TypeError()
    }
    const contentPrototype = Object.getPrototypeOf(contentValue) as unknown
    const contentDescriptors = Object.getOwnPropertyDescriptors(contentValue)
    if (
      (contentPrototype !== Object.prototype && contentPrototype !== null) ||
      Object.getOwnPropertySymbols(contentValue).length !== 0 ||
      Object.keys(contentDescriptors).length !== 2 ||
      !Object.hasOwn(contentDescriptors, 'mediaType') ||
      !Object.hasOwn(contentDescriptors, 'text') ||
      Object.values(contentDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      (contentDescriptors.mediaType?.value !== 'text/plain' &&
        contentDescriptors.mediaType?.value !== 'text/markdown') ||
      typeof contentDescriptors.text?.value !== 'string' ||
      contentDescriptors.text.value.trim().length === 0 ||
      Buffer.byteLength(contentDescriptors.text.value, 'utf8') > 64 * 1_024
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      version: 1,
      workItemId: workItemIdAt(descriptors.workItemId?.value),
      sourceRevision: descriptors.sourceRevision?.value as number,
      content: Object.freeze({
        mediaType: contentDescriptors.mediaType?.value as 'text/plain' | 'text/markdown',
        text: contentDescriptors.text.value,
      }),
      submitForReview: descriptors.submitForReview.value as boolean,
    })
  } catch (error) {
    if (error instanceof WorkbenchModelDraftError) throw error
    throw fail('invalid_request', 'The Workbench model Draft edit request is invalid.')
  }
}

function timestampAt(clock: () => number): string {
  let value: number
  try {
    value = clock()
  } catch {
    throw fail('runtime_unavailable', 'The Workbench model Draft clock is unavailable.')
  }
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw fail('runtime_unavailable', 'The Workbench model Draft clock is unavailable.')
  }
  try {
    return new Date(value).toISOString()
  } catch {
    throw fail('runtime_unavailable', 'The Workbench model Draft clock is unavailable.')
  }
}

function draftSnapshot(
  draft: Draft,
  personaLabel: string,
  disposition: 'created' | 'recovered' | 'repaired' | 'saved' | 'submitted',
): unknown {
  return Object.freeze({
    version: 1,
    disposition,
    autonomy: 'draft_only',
    externalWritesAvailable: false,
    draft: Object.freeze({
      workItemId: draft.workItemId,
      personaLabel,
      revision: draft.revision,
      state: draft.state,
      content: Object.freeze({ ...draft.content }),
      updatedAt: draft.updatedAt,
    }),
  })
}

function latestModelDraft(database: TwinDeskDatabase, initial: Draft): Draft {
  let current = initial
  for (let revision = initial.revision + 1; revision <= MAX_MODEL_DRAFT_REVISION; revision += 1) {
    let candidate: Draft | undefined
    try {
      candidate = database.getDraft(draftIdFor(initial.workItemId, revision))
    } catch {
      throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
    }
    if (candidate === undefined) {
      if (current.state === 'superseded') {
        throw fail('target_unavailable', 'The Workbench model Draft revision chain is incomplete.')
      }
      return current
    }
    if (
      candidate.workItemId !== initial.workItemId ||
      candidate.personaId !== initial.personaId ||
      candidate.revision !== revision
    ) {
      throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
    }
    current = candidate
  }
  if (current.state === 'superseded') {
    throw fail('target_unavailable', 'The Workbench model Draft revision limit was reached.')
  }
  return current
}

function recordUserDraftAudit(
  database: TwinDeskDatabase,
  draft: Draft,
  action: 'edited' | 'ready_for_review',
  sourceRevision: number,
): void {
  const audit = parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: `${draft.id}:user-${action}`,
    category: 'draft',
    outcome: 'success',
    actor: { type: 'user', id: 'local-user' },
    summary:
      action === 'edited'
        ? 'The user saved a local Draft revision.'
        : 'The user marked a local Draft ready for review.',
    references: [
      { kind: 'work_item', id: draft.workItemId },
      { kind: 'draft', id: draft.id },
    ],
    details: {
      action,
      sourceRevision,
      revision: draft.revision,
      state: draft.state,
      externalWrite: false,
    },
    occurredAt: draft.updatedAt,
  })
  try {
    const result = database.appendAuditRecords([audit])
    if (
      result.items.length !== 1 ||
      result.items[0]?.inputIndex !== 0 ||
      (result.items[0]?.disposition !== 'inserted' &&
        result.items[0]?.disposition !== 'duplicate') ||
      result.insertedCount + result.duplicateCount !== 1
    ) {
      throw new TypeError()
    }
  } catch {
    throw fail('runtime_unavailable', 'The Workbench model Draft Audit could not be stored.')
  }
}

/**
 * Bind a browser-safe product intent to one Host-selected provider/model route.
 * Prompt construction, Persona lookup, runtime identities, and persistence stay
 * behind this boundary; the caller supplies only a Work Item identity.
 */
export function createWorkbenchModelDraftController(
  optionsValue: WorkbenchModelDraftControllerOptions,
): WorkbenchModelDraftController {
  const options = optionsAt(optionsValue)
  const operation = createWorkHubHarnessModelDraftOperation({
    database: options.database,
    runner: options.runner,
  })
  return Object.freeze({
    async read() {
      return Object.freeze({ version: 1, capability: 'ready', autonomy: 'draft_only' })
    },
    async create(workItemIdValue: string, signalValue: AbortSignal) {
      const workItemId = workItemIdAt(workItemIdValue)
      const signal = signalAt(signalValue)
      try {
        signal.throwIfAborted()
      } catch {
        throw fail('runtime_unavailable', 'The Workbench model Draft run was cancelled.')
      }
      let workItem: ReturnType<TwinDeskDatabase['getWorkItem']>
      try {
        workItem = options.database.getWorkItem(workItemId as WorkItemId)
      } catch {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      if (workItem === undefined || workItem.selectedPersonaId === undefined) {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      const persona = findBuiltInPersonaConfiguration(workItem.selectedPersonaId)
      if (persona === undefined) {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      const context = renderRedactedModelContext({
        kind: 'work_item_model_context',
        schemaVersion: 1,
        workItem: {
          id: workItem.id,
          inboxState: workItem.inboxState,
          title: workItem.title,
          summary: workItem.summary,
          attentionReason: workItem.attentionReason,
          updatedAt: workItem.updatedAt,
        },
      })
      const prompt = [
        'Create one concise draft for local user review from the bounded Work Item context below.',
        'Do not claim an external action occurred. Preserve uncertainty and do not invent missing facts.',
        context,
      ].join('\n\n')
      const suffix = stableSuffix(workItem.id)
      let result: Awaited<ReturnType<typeof operation.create>>
      try {
        result = await operation.create(
          {
            kind: 'work_hub_harness_model_draft_request',
            schemaVersion: 1,
            draftId: draftIdFor(workItem.id, 1),
            workItemId: workItem.id,
            personaId: persona.id,
            revision: 1,
            sessionId: `model-draft-${suffix}`,
            provider: options.provider,
            model: options.model,
            prompt,
            rationale: `Generated for local review by the selected ${persona.name} Persona.`,
          },
          signal,
        )
      } catch {
        throw fail('runtime_unavailable', 'The Workbench model Draft run failed.')
      }
      const visibleDraft = latestModelDraft(options.database, result.draft)
      return draftSnapshot(
        visibleDraft,
        persona.name,
        result.disposition === 'inserted'
          ? 'created'
          : result.disposition === 'repaired'
            ? 'repaired'
            : 'recovered',
      )
    },
    async edit(requestValue: WorkbenchModelDraftEditRequest, signalValue: AbortSignal) {
      const request = editRequestAt(requestValue)
      const signal = signalAt(signalValue)
      try {
        signal.throwIfAborted()
      } catch {
        throw fail('runtime_unavailable', 'The Workbench model Draft edit was cancelled.')
      }
      let workItem: ReturnType<TwinDeskDatabase['getWorkItem']>
      let source: Draft | undefined
      let existing: Draft | undefined
      try {
        workItem = options.database.getWorkItem(request.workItemId as WorkItemId)
        source = options.database.getDraft(draftIdFor(request.workItemId, request.sourceRevision))
        existing = options.database.getDraft(
          draftIdFor(request.workItemId, request.sourceRevision + 1),
        )
      } catch {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      if (
        workItem === undefined ||
        workItem.selectedPersonaId === undefined ||
        source === undefined ||
        source.workItemId !== workItem.id ||
        source.revision !== request.sourceRevision ||
        source.personaId !== workItem.selectedPersonaId
      ) {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      const persona = findBuiltInPersonaConfiguration(workItem.selectedPersonaId)
      if (persona === undefined) {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      const targetState = request.submitForReview ? 'ready_for_review' : 'editing'
      if (existing !== undefined) {
        if (
          existing.workItemId !== workItem.id ||
          existing.personaId !== persona.id ||
          existing.revision !== request.sourceRevision + 1 ||
          existing.state !== targetState ||
          existing.content.mediaType !== request.content.mediaType ||
          existing.content.text !== request.content.text
        ) {
          throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
        }
        recordUserDraftAudit(
          options.database,
          existing,
          request.submitForReview ? 'ready_for_review' : 'edited',
          request.sourceRevision,
        )
        return draftSnapshot(existing, persona.name, 'recovered')
      }
      const unchanged =
        source.content.mediaType === request.content.mediaType &&
        source.content.text === request.content.text
      if (unchanged) {
        if (!request.submitForReview) {
          return draftSnapshot(source, persona.name, 'recovered')
        }
        if (source.state === 'ready_for_review') {
          recordUserDraftAudit(options.database, source, 'ready_for_review', source.revision)
          return draftSnapshot(source, persona.name, 'recovered')
        }
        if (source.state !== 'editing') {
          throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
        }
        const occurredAt = timestampAt(options.now)
        try {
          const result = options.database.transitionDraft(
            parseDraftStateTransition({
              kind: 'draft_state_transition',
              schemaVersion: 1,
              id: `model-draft-${stableSuffix(workItem.id)}-ready-${String(source.revision)}`,
              draftId: source.id,
              fromState: 'editing',
              toState: 'ready_for_review',
              occurredAt,
            }),
          )
          recordUserDraftAudit(options.database, result.draft, 'ready_for_review', source.revision)
          return draftSnapshot(result.draft, persona.name, 'submitted')
        } catch {
          throw fail('runtime_unavailable', 'The Workbench model Draft edit could not be stored.')
        }
      }
      if (source.state !== 'editing' && source.state !== 'ready_for_review') {
        throw fail('target_unavailable', 'The Workbench model Draft target is unavailable.')
      }
      const occurredAt = timestampAt(options.now)
      const revision = parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: draftIdFor(workItem.id, source.revision + 1),
        workItemId: workItem.id,
        personaId: persona.id,
        revision: source.revision + 1,
        state: targetState,
        content: request.content,
        rationale: 'Edited locally by the user.',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      try {
        const result = options.database.reviseDraft({
          transition: parseDraftStateTransition({
            kind: 'draft_state_transition',
            schemaVersion: 1,
            id: `model-draft-${stableSuffix(workItem.id)}-supersede-${String(source.revision)}`,
            draftId: source.id,
            fromState: source.state,
            toState: 'superseded',
            occurredAt,
          }),
          draft: revision,
        })
        recordUserDraftAudit(
          options.database,
          result.draft,
          request.submitForReview ? 'ready_for_review' : 'edited',
          source.revision,
        )
        return draftSnapshot(
          result.draft,
          persona.name,
          request.submitForReview ? 'submitted' : 'saved',
        )
      } catch {
        throw fail('runtime_unavailable', 'The Workbench model Draft edit could not be stored.')
      }
    },
  })
}
