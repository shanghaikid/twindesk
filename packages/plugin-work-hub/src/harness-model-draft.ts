import { parseDraft, type Draft, type WorkItemId } from '@twindesk/domain'
import type {
  HarnessModelDraftRunRequest,
  HarnessModelDraftRunResult,
  HarnessModelDraftRunner,
} from '@twindesk/harness-adapter'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

import {
  createWorkHubModelDraftLinkage,
  type WorkHubModelDraftLinkageResult,
} from './model-draft-linkage.ts'
import {
  findBuiltInPersonaConfiguration,
  mapPersonaConfigurationToPreset,
} from './persona-presets.ts'

export const WORK_HUB_HARNESS_MODEL_DRAFT_VERSION = 1 as const

export type WorkHubHarnessModelDraftErrorCode =
  | 'invalid_options'
  | 'invalid_request'
  | 'cancelled'
  | 'runtime_unavailable'
  | 'linkage_unavailable'

export class WorkHubHarnessModelDraftError extends Error {
  readonly code: WorkHubHarnessModelDraftErrorCode

  constructor(code: WorkHubHarnessModelDraftErrorCode, message: string) {
    super(message)
    this.name = 'WorkHubHarnessModelDraftError'
    this.code = code
  }
}

export interface WorkHubHarnessModelDraftRequest {
  readonly kind: 'work_hub_harness_model_draft_request'
  readonly schemaVersion: typeof WORK_HUB_HARNESS_MODEL_DRAFT_VERSION
  readonly draftId: string
  readonly workItemId: string
  readonly personaId: string
  readonly revision: number
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly rationale?: string
}

export interface WorkHubHarnessModelDraftResult {
  readonly disposition: WorkHubModelDraftLinkageResult['disposition']
  readonly runtimeDisposition: HarnessModelDraftRunResult['disposition']
  readonly draft: Draft
  readonly audit: WorkHubModelDraftLinkageResult['audit']
}

export interface WorkHubHarnessModelDraftOptions {
  readonly database: TwinDeskDatabase
  readonly runner: HarnessModelDraftRunner
}

type ParsedOptions = Readonly<WorkHubHarnessModelDraftOptions>

function fail(
  code: WorkHubHarnessModelDraftErrorCode,
  message: string,
): WorkHubHarnessModelDraftError {
  return new WorkHubHarnessModelDraftError(code, message)
}

function optionsAt(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 2 ||
      !Object.hasOwn(descriptors, 'database') ||
      !Object.hasOwn(descriptors, 'runner') ||
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
      runner: runner as HarnessModelDraftRunner,
    })
  } catch {
    throw fail('invalid_options', 'The Work Hub Harness model Draft options are invalid.')
  }
}

function requestAt(value: unknown): WorkHubHarnessModelDraftRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const required = [
      'kind',
      'schemaVersion',
      'draftId',
      'workItemId',
      'personaId',
      'revision',
      'sessionId',
      'provider',
      'model',
      'prompt',
    ]
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.keys(descriptors).some((key) => !required.includes(key) && key !== 'rationale') ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.kind?.value !== 'work_hub_harness_model_draft_request' ||
      descriptors.schemaVersion?.value !== WORK_HUB_HARNESS_MODEL_DRAFT_VERSION
    ) {
      throw new TypeError()
    }
    const draftId = descriptors.draftId?.value
    const workItemId = descriptors.workItemId?.value
    const personaId = descriptors.personaId?.value
    const revision = descriptors.revision?.value
    const sessionId = descriptors.sessionId?.value
    const provider = descriptors.provider?.value
    const model = descriptors.model?.value
    const prompt = descriptors.prompt?.value
    const rationale = descriptors.rationale?.value
    const runtimeId = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u
    const routeId = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u
    if (
      typeof draftId !== 'string' ||
      draftId.length === 0 ||
      draftId.length > 160 ||
      typeof workItemId !== 'string' ||
      workItemId.length === 0 ||
      workItemId.length > 200 ||
      typeof personaId !== 'string' ||
      findBuiltInPersonaConfiguration(personaId) === undefined ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      typeof sessionId !== 'string' ||
      sessionId.length > 150 ||
      !runtimeId.test(sessionId) ||
      typeof provider !== 'string' ||
      provider.length > 120 ||
      !routeId.test(provider) ||
      typeof model !== 'string' ||
      model.length > 160 ||
      !routeId.test(model) ||
      typeof prompt !== 'string' ||
      prompt.trim().length === 0 ||
      Buffer.byteLength(prompt, 'utf8') > 64 * 1_024 ||
      (rationale !== undefined &&
        (typeof rationale !== 'string' || Buffer.byteLength(rationale, 'utf8') > 1_024))
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      kind: 'work_hub_harness_model_draft_request',
      schemaVersion: WORK_HUB_HARNESS_MODEL_DRAFT_VERSION,
      draftId,
      workItemId,
      personaId,
      revision: revision as number,
      sessionId,
      provider,
      model,
      prompt,
      ...(rationale === undefined ? {} : { rationale }),
    })
  } catch {
    throw fail('invalid_request', 'The Work Hub Harness model Draft request is invalid.')
  }
}

function signalAt(value: AbortSignal | undefined): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Work Hub Harness model Draft request is invalid.')
  }
  return value
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

function runtimeResultAt(
  value: unknown,
  request: HarnessModelDraftRunRequest,
): HarnessModelDraftRunResult {
  try {
    const result = dataObjectAt(value, [
      'kind',
      'schemaVersion',
      'disposition',
      'sessionId',
      'runId',
      'presetId',
      'text',
      'completedAt',
    ])
    if (
      result.kind !== 'harness_model_draft_run_result' ||
      result.schemaVersion !== 1 ||
      (result.disposition !== 'completed' && result.disposition !== 'recovered') ||
      result.sessionId !== request.sessionId ||
      result.runId !== `${request.sessionId}:turn-1` ||
      result.presetId !== request.presetId ||
      typeof result.text !== 'string' ||
      result.text.trim().length === 0 ||
      Buffer.byteLength(result.text, 'utf8') > 64 * 1_024 ||
      typeof result.completedAt !== 'string'
    ) {
      throw new TypeError()
    }
    const draft = parseDraft({
      kind: 'draft',
      schemaVersion: 1,
      id: 'runtime-result-validation',
      workItemId: 'runtime-result-validation',
      personaId: 'technical-lead',
      sessionId: result.sessionId,
      runId: result.runId,
      revision: 1,
      state: 'editing',
      content: { mediaType: 'text/plain', text: result.text },
      createdAt: result.completedAt,
      updatedAt: result.completedAt,
    })
    return Object.freeze({
      kind: 'harness_model_draft_run_result',
      schemaVersion: 1,
      disposition: result.disposition,
      sessionId: draft.sessionId as string,
      runId: draft.runId as string,
      presetId: result.presetId,
      text: draft.content.text,
      completedAt: draft.createdAt,
    })
  } catch {
    throw fail('runtime_unavailable', 'The Harness model Draft result is invalid.')
  }
}

/**
 * Run one installed Persona through Harness, then persist only its bounded
 * visible text as an editing Draft after the adapter confirms Session durability.
 */
export function createWorkHubHarnessModelDraftOperation(
  optionsValue: WorkHubHarnessModelDraftOptions,
): Readonly<{
  create(
    request: WorkHubHarnessModelDraftRequest,
    signal?: AbortSignal,
  ): Promise<WorkHubHarnessModelDraftResult>
}> {
  const options = optionsAt(optionsValue)
  const linkage = createWorkHubModelDraftLinkage({ database: options.database })
  return Object.freeze({
    async create(
      requestValue: WorkHubHarnessModelDraftRequest,
      signalValue?: AbortSignal,
    ): Promise<WorkHubHarnessModelDraftResult> {
      const request = requestAt(requestValue)
      const signal = signalAt(signalValue)
      try {
        signal?.throwIfAborted()
      } catch {
        throw fail('cancelled', 'The Work Hub Harness model Draft run was cancelled.')
      }
      const configuration = findBuiltInPersonaConfiguration(request.personaId)
      if (configuration === undefined) {
        throw fail('invalid_request', 'The Work Hub Harness model Draft request is invalid.')
      }
      const mapping = mapPersonaConfigurationToPreset(configuration)
      let workItem: ReturnType<TwinDeskDatabase['getWorkItem']>
      let storedDraft: ReturnType<TwinDeskDatabase['getDraft']>
      try {
        workItem = options.database.getWorkItem(request.workItemId as WorkItemId)
        storedDraft = options.database.getDraft(request.draftId as Draft['id'])
      } catch {
        throw fail('linkage_unavailable', 'The Harness model Draft target is unavailable.')
      }
      if (
        workItem === undefined ||
        (storedDraft === undefined && workItem.selectedPersonaId !== request.personaId) ||
        (storedDraft !== undefined &&
          (storedDraft.workItemId !== request.workItemId ||
            storedDraft.personaId !== request.personaId ||
            storedDraft.sessionId !== request.sessionId ||
            storedDraft.runId !== `${request.sessionId}:turn-1` ||
            storedDraft.revision !== request.revision ||
            storedDraft.rationale !== request.rationale))
      ) {
        throw fail('invalid_request', 'The Work Hub Harness model Draft request is invalid.')
      }
      try {
        parseDraft({
          kind: 'draft',
          schemaVersion: 1,
          id: request.draftId,
          workItemId: request.workItemId,
          personaId: request.personaId,
          sessionId: request.sessionId,
          runId: `${request.sessionId}:turn-1`,
          revision: request.revision,
          state: 'editing',
          content: { mediaType: 'text/plain', text: 'pending' },
          ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
          createdAt: workItem.updatedAt,
          updatedAt: workItem.updatedAt,
        })
      } catch {
        throw fail('invalid_request', 'The Work Hub Harness model Draft request is invalid.')
      }
      const runtimeRequest = Object.freeze({
        kind: 'harness_model_draft_run_request',
        schemaVersion: 1,
        sessionId: request.sessionId,
        presetId: mapping.presetId,
        provider: request.provider,
        model: request.model,
        prompt: request.prompt,
        mode: storedDraft === undefined ? 'create_or_recover' : 'recover_only',
      } satisfies HarnessModelDraftRunRequest)
      let runtime: HarnessModelDraftRunResult
      try {
        runtime = runtimeResultAt(await options.runner.run(runtimeRequest, signal), runtimeRequest)
      } catch (error) {
        if (signal?.aborted === true) {
          throw fail('cancelled', 'The Work Hub Harness model Draft run was cancelled.')
        }
        if (error instanceof WorkHubHarnessModelDraftError) throw error
        throw fail('runtime_unavailable', 'The Work Hub Harness model Draft run failed.')
      }
      try {
        signal?.throwIfAborted()
      } catch {
        throw fail('cancelled', 'The Work Hub Harness model Draft run was cancelled.')
      }
      let draft: Draft
      try {
        draft = parseDraft({
          kind: 'draft',
          schemaVersion: 1,
          id: request.draftId,
          workItemId: request.workItemId,
          personaId: request.personaId,
          sessionId: runtime.sessionId,
          runId: runtime.runId,
          revision: request.revision,
          state: 'editing',
          content: { mediaType: 'text/plain', text: runtime.text },
          ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
          createdAt: runtime.completedAt,
          updatedAt: runtime.completedAt,
        })
      } catch {
        throw fail('runtime_unavailable', 'The Harness model Draft result is invalid.')
      }
      let linked: WorkHubModelDraftLinkageResult
      try {
        linked = linkage.record({
          kind: 'work_hub_model_draft_linkage_request',
          schemaVersion: 1,
          draft,
        })
      } catch {
        throw fail('linkage_unavailable', 'The Harness model Draft could not be linked.')
      }
      return Object.freeze({
        disposition: linked.disposition,
        runtimeDisposition: runtime.disposition,
        draft: linked.draft,
        audit: linked.audit,
      })
    },
  })
}
