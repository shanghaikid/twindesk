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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import type { HarnessJsonValue, HarnessToolHostContext } from './index.js'

/** Out-of-tree Host plugin shape accepted by the compatibility probe. */
export interface HarnessToolPlugin {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: HarnessToolHostContext): void
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
  plugin: HarnessToolPlugin,
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
