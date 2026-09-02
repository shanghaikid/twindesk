import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

export const HARNESS_MODEL_DRAFT_RUN_VERSION = 1 as const

export type HarnessModelDraftRunErrorCode =
  | 'invalid_context'
  | 'invalid_request'
  | 'cancelled'
  | 'runtime_unavailable'
  | 'persistence_unavailable'
  | 'stored_run_conflict'
  | 'invalid_output'

export class HarnessModelDraftRunError extends Error {
  readonly code: HarnessModelDraftRunErrorCode

  constructor(code: HarnessModelDraftRunErrorCode, message: string) {
    super(message)
    this.name = 'HarnessModelDraftRunError'
    this.code = code
  }
}

export interface HarnessModelDraftRunRequest {
  readonly kind: 'harness_model_draft_run_request'
  readonly schemaVersion: typeof HARNESS_MODEL_DRAFT_RUN_VERSION
  readonly sessionId: string
  readonly presetId: string
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly mode: 'create_or_recover' | 'recover_only'
}

export interface HarnessModelDraftRunResult {
  readonly kind: 'harness_model_draft_run_result'
  readonly schemaVersion: typeof HARNESS_MODEL_DRAFT_RUN_VERSION
  readonly disposition: 'completed' | 'recovered'
  readonly sessionId: string
  readonly runId: string
  readonly presetId: string
  readonly text: string
  readonly completedAt: string
}

export interface HarnessModelDraftRunner {
  run(
    request: HarnessModelDraftRunRequest,
    signal?: AbortSignal,
  ): Promise<HarnessModelDraftRunResult>
}

export interface HarnessModelDraftRoute {
  readonly provider: string
  readonly model: string
}

interface HarnessRuntimeServices {
  readonly agents: Context['agents']
  readonly sessions: Context['sessions']
  readonly sessionPersistence: Context['sessionPersistence']
  readonly agentPresets: Context['agentPresets']
}

function fail(code: HarnessModelDraftRunErrorCode, message: string): HarnessModelDraftRunError {
  return new HarnessModelDraftRunError(code, message)
}

function servicesAt(value: unknown): HarnessRuntimeServices {
  try {
    if (typeof value !== 'object' || value === null) throw new TypeError()
    const context = value as Context
    const agents = context.agents
    const sessions = context.sessions
    const sessionPersistence = context.sessionPersistence
    const agentPresets = context.agentPresets
    if (
      typeof agents?.create !== 'function' ||
      typeof agents?.get !== 'function' ||
      typeof sessions?.flush !== 'function' ||
      typeof sessionPersistence?.list !== 'function' ||
      typeof sessionPersistence?.inspect !== 'function' ||
      typeof agentPresets?.mount !== 'function'
    ) {
      throw new TypeError()
    }
    return Object.freeze({ agents, sessions, sessionPersistence, agentPresets })
  } catch {
    throw fail('invalid_context', 'The Harness model Draft runtime context is invalid.')
  }
}

function requestAt(value: unknown): HarnessModelDraftRunRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = [
      'kind',
      'schemaVersion',
      'sessionId',
      'presetId',
      'provider',
      'model',
      'prompt',
      'mode',
    ]
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.kind?.value !== 'harness_model_draft_run_request' ||
      descriptors.schemaVersion?.value !== HARNESS_MODEL_DRAFT_RUN_VERSION
    ) {
      throw new TypeError()
    }
    const sessionId = descriptors.sessionId?.value
    const presetId = descriptors.presetId?.value
    const provider = descriptors.provider?.value
    const model = descriptors.model?.value
    const prompt = descriptors.prompt?.value
    const mode = descriptors.mode?.value
    const runtimeId = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u
    const routeId = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u
    if (
      typeof sessionId !== 'string' ||
      sessionId.length > 150 ||
      !runtimeId.test(sessionId) ||
      typeof presetId !== 'string' ||
      presetId.length > 120 ||
      !runtimeId.test(presetId) ||
      typeof provider !== 'string' ||
      provider.length > 120 ||
      !routeId.test(provider) ||
      typeof model !== 'string' ||
      model.length > 160 ||
      !routeId.test(model) ||
      typeof prompt !== 'string' ||
      prompt.trim().length === 0 ||
      Buffer.byteLength(prompt, 'utf8') > 64 * 1_024 ||
      (mode !== 'create_or_recover' && mode !== 'recover_only')
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      kind: 'harness_model_draft_run_request',
      schemaVersion: HARNESS_MODEL_DRAFT_RUN_VERSION,
      sessionId,
      presetId,
      provider,
      model,
      prompt,
      mode,
    })
  } catch {
    throw fail('invalid_request', 'The Harness model Draft run request is invalid.')
  }
}

function signalAt(value: AbortSignal | undefined): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Harness model Draft run request is invalid.')
  }
  return value
}

function routeIdAt(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    throw fail('invalid_request', 'The Harness model Draft route is invalid.')
  }
  return value
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw new TypeError()
  }
  return descriptor.value
}

function denseArrayValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor | undefined
  >
  const lengthDescriptor = descriptors.length
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0 ||
    (lengthDescriptor.value as number) > 1_000 ||
    Object.keys(descriptors).length !== (lengthDescriptor.value as number) + 1
  ) {
    throw new TypeError()
  }
  const values: unknown[] = []
  for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError()
    }
    values.push(descriptor.value)
  }
  return values
}

/**
 * Prove that one Host-selected provider/model route is mounted in the current
 * Harness generation without making a model request or resolving a credential.
 */
export async function inspectHarnessModelDraftRoute(
  contextValue: unknown,
  routeValue: HarnessModelDraftRoute,
  signalValue?: AbortSignal,
): Promise<HarnessModelDraftRoute> {
  const signal = signalAt(signalValue)
  let provider: string
  let model: string
  let llm: Context['llm']
  try {
    if (typeof routeValue !== 'object' || routeValue === null || Array.isArray(routeValue)) {
      throw new TypeError()
    }
    const prototype = Object.getPrototypeOf(routeValue) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(routeValue)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(routeValue).length !== 0 ||
      Object.keys(descriptors).length !== 2 ||
      !Object.hasOwn(descriptors, 'provider') ||
      !Object.hasOwn(descriptors, 'model') ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    provider = routeIdAt(descriptors.provider?.value, 120)
    model = routeIdAt(descriptors.model?.value, 160)
  } catch (error) {
    if (error instanceof HarnessModelDraftRunError) throw error
    throw fail('invalid_request', 'The Harness model Draft route is invalid.')
  }
  try {
    if (typeof contextValue !== 'object' || contextValue === null) throw new TypeError()
    const candidate = (contextValue as Context).llm
    if (
      typeof candidate?.listProviders !== 'function' ||
      typeof candidate.resolveModelInfo !== 'function'
    ) {
      throw new TypeError()
    }
    llm = candidate
  } catch (error) {
    if (error instanceof HarnessModelDraftRunError) throw error
    throw fail('invalid_context', 'The Harness model Draft route context is invalid.')
  }
  try {
    signal?.throwIfAborted()
    const providers = denseArrayValues(llm.listProviders())
    if (providers.filter((candidate) => ownDataValue(candidate, 'id') === provider).length !== 1) {
      throw new TypeError()
    }
    const resolved = await llm.resolveModelInfo(provider, model, signal)
    signal?.throwIfAborted()
    if (ownDataValue(resolved, 'provider') !== provider || ownDataValue(resolved, 'id') !== model) {
      throw new TypeError()
    }
    return Object.freeze({ provider, model })
  } catch {
    if (signal?.aborted === true) {
      throw fail('cancelled', 'The Harness model Draft route check was cancelled.')
    }
    throw fail('runtime_unavailable', 'The Harness model Draft route is unavailable.')
  }
}

function visibleText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  if (event.data.interrupted === true) {
    throw fail('stored_run_conflict', 'The stored Harness model Draft run is incomplete.')
  }
  const blocks = event.data.message.content
  if (blocks.some((block) => block.type !== 'text' && block.type !== 'reasoning')) {
    throw fail('invalid_output', 'The Harness model Draft output is not plain text.')
  }
  const text = blocks
    .filter(
      (block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
  if (text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > 64 * 1_024) {
    throw fail('invalid_output', 'The Harness model Draft output is invalid.')
  }
  return text
}

function resultFromStored(
  request: HarnessModelDraftRunRequest,
  inspection: Awaited<ReturnType<Context['sessionPersistence']['inspect']>>,
  disposition: HarnessModelDraftRunResult['disposition'],
): HarnessModelDraftRunResult {
  if (
    String(inspection.meta.id) !== request.sessionId ||
    inspection.meta.agentPreset !== request.presetId
  ) {
    throw fail('stored_run_conflict', 'The stored Harness model Draft identity conflicts.')
  }
  const starts = inspection.events.filter(
    (event): event is Extract<SessionEvent, { type: 'turn/start' }> => event.type === 'turn/start',
  )
  const ends = inspection.events.filter(
    (event): event is Extract<SessionEvent, { type: 'turn/end' }> => event.type === 'turn/end',
  )
  const directInputs = inspection.events.filter(
    (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
      event.type === 'user/message' && event.data.source.kind === 'user',
  )
  const outputs = inspection.events.filter(
    (event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
      event.type === 'assistant/message' && event.data.turn === 1,
  )
  const end = ends[0]
  const output = outputs.at(-1)
  if (
    starts.length !== 1 ||
    starts[0]?.data.turn !== 1 ||
    ends.length !== 1 ||
    end?.data.turn !== 1 ||
    end.data.reason.kind !== 'completed' ||
    directInputs.length !== 1 ||
    directInputs[0]?.data.content.length !== 1 ||
    directInputs[0].data.content[0]?.type !== 'text' ||
    directInputs[0].data.content[0].text !== request.prompt ||
    output === undefined ||
    output.seq >= end.seq ||
    output.data.message.source.provider !== request.provider ||
    output.data.message.source.model !== request.model ||
    !Number.isSafeInteger(end.time) ||
    end.time < inspection.meta.createdAt
  ) {
    throw fail('stored_run_conflict', 'The stored Harness model Draft run conflicts.')
  }
  const text = visibleText(output)
  return Object.freeze({
    kind: 'harness_model_draft_run_result',
    schemaVersion: HARNESS_MODEL_DRAFT_RUN_VERSION,
    disposition,
    sessionId: request.sessionId,
    runId: `${request.sessionId}:turn-1`,
    presetId: request.presetId,
    text,
    completedAt: new Date(end.time).toISOString(),
  })
}

async function existingSession(
  services: HarnessRuntimeServices,
  request: HarnessModelDraftRunRequest,
  signal: AbortSignal | undefined,
): Promise<HarnessModelDraftRunResult | undefined> {
  const sessionId = SessionId(request.sessionId)
  if (services.agents.get(sessionId) !== undefined) {
    throw fail('stored_run_conflict', 'The Harness model Draft run is still active.')
  }
  const matching = (await services.sessionPersistence.list(signal)).filter(
    (header) => String(header.id) === request.sessionId,
  )
  if (matching.length === 0) return undefined
  if (matching.length !== 1) {
    throw fail('stored_run_conflict', 'The stored Harness model Draft identity conflicts.')
  }
  if (services.agents.get(sessionId) !== undefined) {
    throw fail('stored_run_conflict', 'The Harness model Draft run is still active.')
  }
  const inspection = await services.sessionPersistence.inspect(sessionId, signal)
  if (services.agents.get(sessionId) !== undefined) {
    throw fail('stored_run_conflict', 'The Harness model Draft run is still active.')
  }
  return resultFromStored(request, inspection, 'recovered')
}

async function runNewSession(
  services: HarnessRuntimeServices,
  request: HarnessModelDraftRunRequest,
  signal: AbortSignal | undefined,
): Promise<HarnessModelDraftRunResult> {
  let handle: AgentHandle | undefined
  let failed = false
  const cancel = (): void => handle?.agent.cancel({ kind: 'user' })
  try {
    signal?.throwIfAborted()
    handle = await services.agents.create({
      sessionId: SessionId(request.sessionId),
      agentOptions: { provider: request.provider, model: request.model },
      meta: { agentPreset: request.presetId },
      ...(signal === undefined ? {} : { signal }),
      setup: async (agentContext: Context) =>
        void (await services.agentPresets.mount(agentContext, request.presetId)),
    })
    signal?.addEventListener('abort', cancel, { once: true })
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()
    signal?.throwIfAborted()
    if (!(await services.sessions.flush(handle.agent.session))) {
      throw fail(
        'persistence_unavailable',
        'No Harness Session persistence listener confirmed durability.',
      )
    }
    signal?.throwIfAborted()
    await handle.dispose()
    handle = undefined
    const inspection = await services.sessionPersistence.inspect(
      SessionId(request.sessionId),
      signal,
    )
    return resultFromStored(request, inspection, 'completed')
  } catch (error) {
    failed = true
    if (error instanceof HarnessModelDraftRunError) throw error
    if (signal?.aborted === true) {
      throw fail('cancelled', 'The Harness model Draft run was cancelled.')
    }
    throw fail('runtime_unavailable', 'The Harness model Draft run did not complete.')
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch {
        if (!failed) {
          throw fail('runtime_unavailable', 'The Harness model Draft runtime did not close.')
        }
      }
    }
  }
}

/**
 * Bind TwinDesk to the pinned Harness Agent/Session lifecycle without exposing
 * Harness types to callers. A result is returned only after a participating
 * persistence listener flushes and the completed turn is re-read cold.
 */
export function createHarnessModelDraftRunner(contextValue: unknown): HarnessModelDraftRunner {
  const services = servicesAt(contextValue)
  return Object.freeze({
    async run(
      requestValue: HarnessModelDraftRunRequest,
      signalValue?: AbortSignal,
    ): Promise<HarnessModelDraftRunResult> {
      const request = requestAt(requestValue)
      const signal = signalAt(signalValue)
      try {
        signal?.throwIfAborted()
        const recovered = await existingSession(services, request, signal)
        if (recovered !== undefined) {
          signal?.throwIfAborted()
          return recovered
        }
        if (request.mode === 'recover_only') {
          throw fail('stored_run_conflict', 'The stored Harness model Draft run is missing.')
        }
        const completed = await runNewSession(services, request, signal)
        signal?.throwIfAborted()
        return completed
      } catch (error) {
        if (error instanceof HarnessModelDraftRunError) throw error
        if (signal?.aborted === true) {
          throw fail('cancelled', 'The Harness model Draft run was cancelled.')
        }
        throw fail('persistence_unavailable', 'The Harness Session store is unavailable.')
      }
    },
  })
}
