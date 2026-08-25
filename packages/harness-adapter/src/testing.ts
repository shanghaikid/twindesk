import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import SettingsProvider, {
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import type { HarnessHostContext, HarnessJsonValue } from './index.js'

const require = createRequire(import.meta.url)
const { SlotCore } = require('@deepseek-ai/dsh-client-ui-slots') as {
  readonly SlotCore: new () => unknown
}

/** Out-of-tree Host plugin shape accepted by compatibility probes. */
export interface HarnessHostPlugin {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: HarnessHostContext): void
}

/** One simplified Tool trace entry, projected from the Agent Session log. */
export interface HarnessToolTraceEntry {
  readonly type: 'tool/call' | 'tool/result'
  readonly name?: string
  readonly isError?: boolean
  readonly text?: string
}

/** Observable result of a deterministic, keyless Harness Agent round trip. */
export interface HarnessToolProbeResult {
  readonly registeredTools: readonly string[]
  readonly advertisedTools: readonly string[]
  readonly directValue: HarnessJsonValue
  readonly cancellationCode: string | undefined
  readonly trace: readonly HarnessToolTraceEntry[]
  readonly toolsAfterPluginDisposal: readonly string[]
}

/** Input for the file-backed boolean settings compatibility probe. */
export interface HarnessBooleanSettingsProbeOptions {
  readonly filePath: string
  readonly namespace: string
  readonly key: string
  readonly updatedValue: boolean
  readonly rejectedPatch: Readonly<Record<string, HarnessJsonValue>>
  readonly toolName: string
}

/** Safe diagnostic projection of one rejected settings update. */
export interface HarnessSettingsDiagnostic {
  readonly name: string
  readonly message: string
}

/** Observable result of a file-backed settings update and restart. */
export interface HarnessBooleanSettingsProbeResult {
  readonly initialValue: unknown
  readonly updatedValue: unknown
  readonly toolValueAfterUpdate: HarnessJsonValue
  readonly browserDescriptorAfterRejection: unknown
  readonly recoveredValue: unknown
  readonly browserDescriptorAfterRestart: unknown
  readonly rejectedDiagnostic: HarnessSettingsDiagnostic
  readonly persistedDocument: string
  readonly toolValueAfterRestart: HarnessJsonValue
  readonly namespacesAfterPluginDisposal: readonly string[]
  readonly toolsAfterPluginDisposal: readonly string[]
}

/** Observable result of the public Client slot seam used by the Inbox spike. */
export interface HarnessClientSlotProbeResult {
  readonly inboxShadowsConversation: boolean
  readonly conversationRestored: boolean
  readonly footerActionMounted: boolean
  readonly footerActionRemoved: boolean
}

/** Input for the two-preset, keyless Stage 0 behavior probe. */
export interface HarnessAgentPresetProbeOptions {
  readonly presetRoot: string
  readonly plugin: HarnessHostPlugin
  readonly technicalPresetId: string
  readonly communicationPresetId: string
  readonly fixtureRequest: string
}

/** Safe projection of one preset's model-facing composition and response. */
export interface HarnessAgentPresetObservation {
  readonly presetId: string
  readonly systemPrompt: string
  readonly advertisedTools: readonly string[]
  readonly skills: readonly string[]
  readonly response: string
}

/** Observable result of composing two distinct Agent Presets. */
export interface HarnessAgentPresetProbeResult {
  readonly fixtureRequest: string
  readonly technical: HarnessAgentPresetObservation
  readonly communication: HarnessAgentPresetObservation
  readonly communicationToolsAfterTechnicalDisposal: readonly string[]
  readonly globalToolsAfterPluginDisposal: readonly string[]
}

interface ErasedClientSlotEntry {
  readonly component: unknown
}

interface ErasedClientSlotRegistry {
  register(
    options: Readonly<{
      name: string
      id?: string
      order?: number
      priority?: number
      children?: Readonly<Record<string, Readonly<{ kind: string; scope: string }>>>
    }>,
    component: unknown,
  ): () => void
  entriesOfSlot(name: string): readonly ErasedClientSlotEntry[]
}

/**
 * Exercise the exact pinned SlotCore behavior required by TD-031 without
 * exposing upstream types outside the adapter boundary.
 */
export function probeHarnessClientInboxSlots(): HarnessClientSlotProbeResult {
  const slots = new SlotCore() as unknown as ErasedClientSlotRegistry
  const shell = () => null
  const conversation = () => null
  const inbox = () => null
  const footerAction = () => null
  const disposeShell = slots.register(
    {
      name: 'root',
      children: {
        conversation: { kind: 'single', scope: 'session-maybe' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    },
    shell,
  )
  const disposeConversation = slots.register({ name: 'conversation' }, conversation)
  const disposeInbox = slots.register({ name: 'conversation', priority: -100 }, inbox)
  const disposeFooter = slots.register(
    { name: 'sidebar.footer.action', id: 'twindesk-inbox', order: -100 },
    footerAction,
  )

  const inboxShadowsConversation = slots.entriesOfSlot('conversation')[0]?.component === inbox
  const footerActionMounted =
    slots.entriesOfSlot('sidebar.footer.action')[0]?.component === footerAction

  disposeInbox()
  const conversationRestored = slots.entriesOfSlot('conversation')[0]?.component === conversation
  disposeFooter()
  const footerActionRemoved = slots.entriesOfSlot('sidebar.footer.action').length === 0
  disposeConversation()
  disposeShell()

  return Object.freeze({
    inboxShadowsConversation,
    conversationRestored,
    footerActionMounted,
    footerActionRemoved,
  })
}

/** Small writable provider for tests that do not exercise persistence. */
class MemorySettingsProvider extends SettingsProvider {
  private storedDocument: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument = { ...this.storedDocument, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function toolCallResponse(name: string): StreamChunk[] {
  const callId = CallId('twindesk-status-agent-call')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: '{}' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: '{}' },
    },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class DeterministicAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly responses: StreamChunk[][]

  constructor(toolName: string) {
    super()
    this.responses = [toolCallResponse(toolName), textResponse('status observed')]
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Deterministic Harness adapter script exhausted')
    for (const chunk of response) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

const TECHNICAL_PROBE_RESPONSE =
  'Technical assessment: verify the dependency compatibility failure and release impact before changing scope. Recommendation: assign an owner and preserve a rollback path. Draft only; no external action was performed.'
const COMMUNICATION_PROBE_RESPONSE =
  "Stakeholder draft: Friday's release may move by two days while the dependency upgrade is verified. We will confirm the impact and share the next update. Draft only; not sent."

class PersonaAwareAdapter extends LlmAdapter {
  readonly requests = new Map<string, GenerateOptions>()
  private readonly expectedFixtureRequest: string

  constructor(expectedFixtureRequest: string) {
    super()
    this.expectedFixtureRequest = expectedFixtureRequest
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId)
    this.requests.set(sessionId, options)
    const hasExpectedFixture = options.messages.some(
      (message) =>
        message.role === 'user' &&
        message.content.some(
          (block) => block.type === 'text' && block.text === this.expectedFixtureRequest,
        ),
    )
    if (!hasExpectedFixture) {
      throw new Error(`Agent Preset probe received an unexpected fixture for ${sessionId}`)
    }
    const system = options.system ?? ''
    let response: string
    if (system.includes('TwinDesk Technical Lead Persona')) {
      response = TECHNICAL_PROBE_RESPONSE
    } else if (system.includes('TwinDesk Communication Persona')) {
      response = COMMUNICATION_PROBE_RESPONSE
    } else {
      throw new Error(`Agent Preset probe received an unrecognized Persona for ${sessionId}`)
    }
    for (const chunk of textResponse(response)) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function finalAssistantText(handle: AgentHandle): string {
  const message = handle.agent.session
    .deriveMessages()
    .findLast((candidate) => candidate.role === 'assistant')
  const text = message?.content.find((candidate) => candidate.type === 'text')
  if (text?.type !== 'text') throw new Error('Agent Preset probe produced no assistant text')
  return text.text
}

/**
 * Compose both TwinDesk Stage 0 Agent Presets through the pinned public
 * Harness services and run the same fixture through a deterministic model.
 * No API key, network request, external write Tool, or product persistence is
 * involved; this is a replaceable-runtime compatibility probe.
 */
export async function probeHarnessAgentPresets(
  options: HarnessAgentPresetProbeOptions,
): Promise<HarnessAgentPresetProbeResult> {
  const ctx = new Context()
  const serviceFibers: Fiber[] = []
  const agentHandles: AgentHandle[] = []
  let pluginFiber: Fiber | undefined

  async function mount(service: Plugin, config?: unknown): Promise<Fiber> {
    const fiber = await ctx.plugin(service, config)
    serviceFibers.push(fiber)
    return fiber
  }

  async function createObservation(
    presetId: string,
    sessionId: string,
    adapter: PersonaAwareAdapter,
  ): Promise<{ handle: AgentHandle; observation: HarnessAgentPresetObservation }> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: 'twindesk-preset-probe', model: 'deterministic' },
      setup: async (agentCtx: Context) => void (await ctx.agentPresets.mount(agentCtx, presetId)),
    })
    agentHandles.push(handle)
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: options.fixtureRequest }],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()

    const request = adapter.requests.get(sessionId)
    if (request === undefined) {
      throw new Error(`Agent Preset probe captured no model request for ${sessionId}`)
    }
    const composedPreset = ctx.agentPresets.composedPreset(handle.agent.ctx)
    if (composedPreset !== presetId) {
      throw new Error(
        `Agent Preset probe composed ${JSON.stringify(composedPreset)} instead of ${JSON.stringify(presetId)}`,
      )
    }
    const agentScope = scopeOf(handle.agent.ctx)
    if (agentScope === undefined) {
      throw new Error(`Agent Preset probe found no scope for ${sessionId}`)
    }

    return {
      handle,
      observation: Object.freeze({
        presetId: composedPreset,
        systemPrompt: request.system ?? '',
        advertisedTools: Object.freeze((request.tools ?? []).map((schema) => schema.name).sort()),
        skills: Object.freeze(
          (await ctx.skills.list({ scope: agentScope })).map((skill) => skill.name).sort(),
        ),
        response: finalAssistantText(handle),
      }),
    }
  }

  try {
    ctx.baseUrl = `${pathToFileURL(options.presetRoot).href.replace(/\/$/u, '')}/`
    await mount(Loader)
    ctx.loader.builtins.include = Include
    await mount(LlmRuntime)
    await mount(SessionStore)
    await mount(MemorySettingsProvider)
    await mount(SystemPrompt, { persona: '' })
    await mount(ToolRuntime)
    await mount(SkillRegistry)
    await mount(AgentRegistry)
    await mount(AgentLoop, { agents: [] })
    await mount(AgentPresets, {
      default: options.technicalPresetId,
      roots: [{ path: options.presetRoot, trust: 'user' }],
      includeUserRoot: false,
    })

    pluginFiber = await ctx.plugin(options.plugin as Plugin)
    const adapter = new PersonaAwareAdapter(options.fixtureRequest)
    ctx.llm.registerAdapter(['twindesk-preset-probe'], adapter)

    const technical = await createObservation(
      options.technicalPresetId,
      'twindesk-preset-technical',
      adapter,
    )
    const communication = await createObservation(
      options.communicationPresetId,
      'twindesk-preset-communication',
      adapter,
    )

    await technical.handle.dispose()
    agentHandles.splice(agentHandles.indexOf(technical.handle), 1)
    const communicationToolsAfterTechnicalDisposal = ctx.tools
      .schemas(communication.handle.agent)
      .map((schema) => schema.name)
      .sort()

    await pluginFiber.dispose()
    pluginFiber = undefined
    const globalToolsAfterPluginDisposal = ctx.tools.schemas().map((schema) => schema.name)

    return Object.freeze({
      fixtureRequest: options.fixtureRequest,
      technical: technical.observation,
      communication: communication.observation,
      communicationToolsAfterTechnicalDisposal: Object.freeze(
        communicationToolsAfterTechnicalDisposal,
      ),
      globalToolsAfterPluginDisposal: Object.freeze(globalToolsAfterPluginDisposal),
    })
  } finally {
    for (const handle of agentHandles.reverse()) await handle.dispose()
    if (pluginFiber !== undefined) await pluginFiber.dispose()
    for (const fiber of serviceFibers.reverse()) await fiber.dispose()
  }
}

/**
 * Exercise an installed Tool through the published Harness packages only.
 *
 * This test boundary uses a scripted in-process model adapter, so it needs no
 * API key or network. It covers direct execution, pre-dispatch cancellation,
 * Agent invocation, durable Session events, and Host plugin disposal.
 */
export async function probeHarnessToolPlugin(
  plugin: HarnessHostPlugin,
  toolName: string,
): Promise<HarnessToolProbeResult> {
  const ctx = new Context()
  const serviceFibers: Fiber[] = []
  let pluginFiber: Fiber | undefined

  async function mount(service: Plugin, config?: unknown): Promise<Fiber> {
    const fiber = await ctx.plugin(service, config)
    serviceFibers.push(fiber)
    return fiber
  }

  try {
    await mount(LlmRuntime)
    await mount(SessionStore)
    await mount(MemorySettingsProvider)
    await mount(SystemPrompt, { persona: 'Use the requested TwinDesk Tool.' })
    await mount(ToolRuntime)
    await mount(AgentRegistry)
    await mount(AgentLoop, { agents: [] })

    pluginFiber = await ctx.plugin(plugin as Plugin)
    const registeredTools = ctx.tools.schemas().map((schema) => schema.name)

    const direct = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('twindesk-status-direct-call'),
      name: toolName,
      arguments: {},
    })
    if (direct.isError || !('value' in direct)) {
      throw new Error(`Direct Harness Tool probe failed for ${JSON.stringify(toolName)}`)
    }

    const cancelled = await ctx.tools.execute({
      signal: AbortSignal.abort(new Error('compatibility probe cancelled')),
      callId: CallId('twindesk-status-cancelled-call'),
      name: toolName,
      arguments: {},
    })

    const adapter = new DeterministicAdapter(toolName)
    ctx.llm.registerAdapter(['twindesk-probe'], adapter)
    const agent = ctx.agentLoop.create(SessionId('twindesk-status-probe'), {
      provider: 'twindesk-probe',
      model: 'deterministic',
    })
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Report TwinDesk status.' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()

    const trace = agent.session.events.flatMap((event): HarnessToolTraceEntry[] => {
      if (event.type === 'tool/call') {
        return [{ type: event.type, name: event.data.name }]
      }
      if (event.type !== 'tool/result') return []
      const block = event.data.message.content.find((candidate) => candidate.type === 'tool-result')
      const text = block?.content.find((candidate) => candidate.type === 'text')
      return [
        {
          type: event.type,
          ...(block === undefined ? {} : { isError: block.isError }),
          ...(text?.type === 'text' ? { text: text.text } : {}),
        },
      ]
    })
    const advertisedTools = adapter.requests[0]?.tools?.map((schema) => schema.name) ?? []

    await pluginFiber.dispose()
    pluginFiber = undefined
    const toolsAfterPluginDisposal = ctx.tools.schemas().map((schema) => schema.name)

    return {
      registeredTools,
      advertisedTools,
      directValue: direct.value,
      cancellationCode: cancelled.error?.info?.code,
      trace,
      toolsAfterPluginDisposal,
    }
  } finally {
    if (pluginFiber !== undefined) await pluginFiber.dispose()
    for (const fiber of serviceFibers.reverse()) await fiber.dispose()
  }
}

async function executeToolValue(
  ctx: Context,
  toolName: string,
  callId: string,
): Promise<HarnessJsonValue> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name: toolName,
    arguments: {},
  })
  if (result.isError || !('value' in result)) {
    throw new Error(`Harness Tool execution failed for ${JSON.stringify(toolName)}`)
  }
  return result.value
}

async function bootFileSettingsPlugin(
  plugin: HarnessHostPlugin,
  filePath: string,
): Promise<{ ctx: Context; pluginFiber: Fiber; serviceFibers: Fiber[] }> {
  const ctx = new Context()
  const serviceFibers: Fiber[] = []
  try {
    serviceFibers.push(await ctx.plugin(SystemPrompt, { persona: '' }))
    serviceFibers.push(await ctx.plugin(ToolRuntime))
    serviceFibers.push(await ctx.plugin(FileSettingsProvider, { path: filePath, watch: false }))
    const pluginFiber = await ctx.plugin(plugin as Plugin)
    return { ctx, pluginFiber, serviceFibers }
  } catch (error) {
    for (const fiber of serviceFibers.reverse()) await fiber.dispose()
    throw error
  }
}

async function disposeFileSettingsPlugin(
  pluginFiber: Fiber | undefined,
  serviceFibers: Fiber[],
): Promise<void> {
  if (pluginFiber !== undefined) await pluginFiber.dispose()
  for (const fiber of serviceFibers.reverse()) await fiber.dispose()
}

/**
 * Verify one boolean namespace through update, persistence, process-style
 * restart, redacted browser description, rejection diagnostics, and disposal.
 */
export async function probeHarnessBooleanSettingPlugin(
  plugin: HarnessHostPlugin,
  options: HarnessBooleanSettingsProbeOptions,
): Promise<HarnessBooleanSettingsProbeResult> {
  const ns = settingsNamespace(options.namespace)
  const first = await bootFileSettingsPlugin(plugin, options.filePath)
  let firstPluginFiber: Fiber | undefined = first.pluginFiber
  let initialValue: unknown
  let updatedValue: unknown
  let toolValueAfterUpdate: HarnessJsonValue
  let browserDescriptorAfterRejection: unknown
  let rejectedDiagnostic: HarnessSettingsDiagnostic

  try {
    initialValue = structuredClone(first.ctx.settings.get(ns))
    await first.ctx.settings.update(ns, { [options.key]: options.updatedValue })
    updatedValue = structuredClone(first.ctx.settings.get(ns))
    toolValueAfterUpdate = await executeToolValue(
      first.ctx,
      options.toolName,
      'twindesk-settings-live-call',
    )

    let rejected: unknown
    try {
      await first.ctx.settings.update(ns, options.rejectedPatch)
    } catch (error) {
      rejected = error
    }
    if (rejected === undefined) {
      throw new Error(`Harness settings probe unexpectedly accepted undeclared fields`)
    }
    rejectedDiagnostic = {
      name: rejected instanceof Error ? rejected.name : 'Error',
      message: rejected instanceof Error ? rejected.message : String(rejected),
    }
    const descriptor = first.ctx.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) {
      throw new Error(
        `Harness settings probe could not describe ${JSON.stringify(options.namespace)} after rejection`,
      )
    }
    browserDescriptorAfterRejection = structuredClone(descriptor)
  } finally {
    await disposeFileSettingsPlugin(firstPluginFiber, first.serviceFibers)
    firstPluginFiber = undefined
  }

  const persistedDocument = await readFile(options.filePath, 'utf8')
  const second = await bootFileSettingsPlugin(plugin, options.filePath)
  let secondPluginFiber: Fiber | undefined = second.pluginFiber

  try {
    const recoveredValue = structuredClone(second.ctx.settings.get(ns))
    const descriptor = second.ctx.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) {
      throw new Error(
        `Harness settings probe could not describe ${JSON.stringify(options.namespace)}`,
      )
    }
    const browserDescriptorAfterRestart = structuredClone(descriptor)
    const toolValueAfterRestart = await executeToolValue(
      second.ctx,
      options.toolName,
      'twindesk-settings-restart-call',
    )

    await secondPluginFiber.dispose()
    secondPluginFiber = undefined
    const namespacesAfterPluginDisposal = second.ctx.settings
      .describe({ redactSecrets: true })
      .map((candidate) => String(candidate.ns))
    const toolsAfterPluginDisposal = second.ctx.tools.schemas().map((schema) => schema.name)

    return {
      initialValue,
      updatedValue,
      toolValueAfterUpdate,
      browserDescriptorAfterRejection,
      recoveredValue,
      browserDescriptorAfterRestart,
      rejectedDiagnostic,
      persistedDocument,
      toolValueAfterRestart,
      namespacesAfterPluginDisposal,
      toolsAfterPluginDisposal,
    }
  } finally {
    await disposeFileSettingsPlugin(secondPluginFiber, second.serviceFibers)
  }
}
