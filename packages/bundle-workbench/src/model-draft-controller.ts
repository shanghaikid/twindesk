import { createHash } from 'node:crypto'

import type { WorkItemId } from '@twindesk/domain'
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
}

export interface WorkbenchModelDraftController {
  read(): Promise<unknown>
  create(workItemId: string, signal: AbortSignal): Promise<unknown>
}

type ParsedOptions = Readonly<WorkbenchModelDraftControllerOptions>

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
    const keys = ['database', 'runner', 'provider', 'model']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
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
      typeof Reflect.get(database, 'appendAuditRecords') !== 'function' ||
      typeof runner !== 'object' ||
      runner === null ||
      typeof Reflect.get(runner, 'run') !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      database: database as TwinDeskDatabase,
      runner: runner as WorkHubHarnessModelDraftOptions['runner'],
      provider: routeAt(descriptors.provider?.value, 120),
      model: routeAt(descriptors.model?.value, 160),
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
            draftId: `model-draft-${suffix}`,
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
      return Object.freeze({
        version: 1,
        disposition:
          result.disposition === 'inserted'
            ? 'created'
            : result.disposition === 'repaired'
              ? 'repaired'
              : 'recovered',
        autonomy: 'draft_only',
        externalWritesAvailable: false,
        draft: Object.freeze({
          workItemId: result.draft.workItemId,
          personaLabel: persona.name,
          revision: result.draft.revision,
          state: result.draft.state,
          content: Object.freeze({ ...result.draft.content }),
          updatedAt: result.draft.updatedAt,
        }),
      })
    },
  })
}
