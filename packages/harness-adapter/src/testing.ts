import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SettingsProvider, {
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
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
