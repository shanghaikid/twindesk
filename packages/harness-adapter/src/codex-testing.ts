import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

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
import SubagentRuntime, {
  type SubagentRunEndInfo,
  type SubagentRunInfo,
} from '@deepseek-ai/dsh-subagent'
import * as CodexSubagent from '@deepseek-ai/dsh-subagent-codex'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { startCodexResponsesFixture, type CodexFixtureRequest } from './codex-responses-fixture.ts'

const CODEX_PROVIDER = 'twindesk-codex-readonly-probe'
const SUBAGENT_TOOL = 'subagent_codex'

export interface HarnessCodexSubagentProbeOptions {
  readonly temporaryRoot: string
}

export interface HarnessCodexLifecycleProjection {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly local: boolean
  readonly stopReason?: string
  readonly lastAssistantText?: string
}

export interface HarnessCodexCapabilityDiagnostic {
  readonly name: string
  readonly code?: string
  readonly message: string
}

export interface HarnessCodexSubagentProbeResult {
  readonly provider: string
  readonly providerCapabilities: Readonly<{
    outputSchema: boolean
    depthLimit: boolean
    toolFilter: boolean
    persona: boolean
  }>
  readonly inheritsParentContext: boolean
  readonly toolHasBackgroundArgument: boolean
  readonly leadResultText: string
  readonly leadObservedChildResult: boolean
  readonly leadToolTrace: readonly Readonly<{
    type: 'tool/call' | 'tool/result'
    name?: string
    isError?: boolean
    text?: string
  }>[]
  readonly lifecycleStarts: readonly HarnessCodexLifecycleProjection[]
  readonly lifecycleEnds: readonly HarnessCodexLifecycleProjection[]
  readonly advertisedNativeTools: readonly string[]
  readonly readEvidenceObservedByModel: boolean
  readonly writeMarkerExists: boolean
  readonly cancellationStopReason: string
  readonly depthRejection: HarnessCodexCapabilityDiagnostic
  readonly toolFilterRejection: HarnessCodexCapabilityDiagnostic
  readonly numericDepthMountRejection: HarnessCodexCapabilityDiagnostic
  readonly requestsBeforeCapabilityRejections: number
  readonly requestsAfterCapabilityRejections: number
}

function toolCallResponse(
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): StreamChunk[] {
  const callId = CallId('twindesk-codex-lead-call')
  const serialized = JSON.stringify(argumentsValue)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: serialized },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: serialized },
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

class CodexLeadAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly responses = [
    toolCallResponse(SUBAGENT_TOOL, {
      description: 'Inspect repository title',
      prompt:
        'Read README.md from the current workspace and report its first Markdown heading. Do not modify any file.',
    }),
    textResponse('Lead accepted the attributed Codex result.'),
  ]

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Codex Lead fixture script exhausted')
    for (const chunk of response) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function requestFunctionNames(request: CodexFixtureRequest | undefined): string[] {
  const tools = request?.body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool): string[] => {
    if (tool === null || typeof tool !== 'object') return []
    const record = tool as Record<string, unknown>
    return record.type === 'function' && typeof record.name === 'string' ? [record.name] : []
  })
}

function requestContainsText(request: CodexFixtureRequest | undefined, expected: string): boolean {
  return JSON.stringify(request?.body ?? {}).includes(expected)
}

function assistantText(
  content: readonly Readonly<Record<string, unknown>>[] | undefined,
): string | undefined {
  if (content === undefined) return undefined
  const text = content.find((block) => block.type === 'text')?.text
  return typeof text === 'string' ? text : undefined
}

function diagnostic(error: unknown): HarnessCodexCapabilityDiagnostic {
  const value = error instanceof Error ? error : new Error(String(error))
  const code = (value as Error & { code?: unknown }).code
  return Object.freeze({
    name: value.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: value.message,
  })
}

async function expectRejection(
  run: () => Promise<unknown>,
): Promise<HarnessCodexCapabilityDiagnostic> {
  try {
    await run()
  } catch (error) {
    return diagnostic(error)
  }
  throw new Error('Expected the Harness capability check to reject')
}

function projectStart(info: SubagentRunInfo): HarnessCodexLifecycleProjection {
  return Object.freeze({
    runId: String(info.runId),
    provider: info.provider,
    id: String(info.id),
    local: info.local,
  })
}

function projectEnd(info: SubagentRunEndInfo): HarnessCodexLifecycleProjection {
  const lastAssistantText = assistantText(
    info.lastAssistantMessage as Readonly<Record<string, unknown>>[] | undefined,
  )
  return Object.freeze({
    runId: String(info.runId),
    provider: info.provider,
    id: String(info.id),
    local: info.local,
    stopReason: info.stopReason,
    ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
  })
}

function finalAssistantText(
  messages: ReturnType<import('@deepseek-ai/dsh-agent').Agent['session']['deriveMessages']>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.content.find((block) => block.type === 'text')
    if (text?.type === 'text') return text.text
  }
  throw new Error('Codex Lead produced no final assistant text')
}

/**
 * Exercise the official package-local Codex 0.147.0 wrapper through the pinned
 * Harness provider and Tool. The model endpoint is loopback-only and synthetic;
 * the native Codex process still performs the repository read, denied write,
 * and cancellation paths under its read-only sandbox.
 */
export async function probeHarnessCodexSubagent(
  options: HarnessCodexSubagentProbeOptions,
): Promise<HarnessCodexSubagentProbeResult> {
  const workspace = join(options.temporaryRoot, 'workspace')
  const codexHome = join(options.temporaryRoot, 'codex-home')
  const writeMarker = join(workspace, 'codex-write-marker')
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(codexHome, { recursive: true })])
  await writeFile(join(workspace, 'README.md'), '# TwinDesk Fixture\n', 'utf8')

  const fixture = await startCodexResponsesFixture([
    {
      kind: 'advertisedFunctionCall',
      choices: [
        { name: 'exec_command', arguments: { cmd: 'head -n 1 README.md' } },
        { name: 'shell_command', arguments: { command: 'head -n 1 README.md' } },
      ],
    },
    { kind: 'complete', text: 'Repository title: TwinDesk Fixture.' },
    {
      kind: 'advertisedFunctionCall',
      choices: [
        { name: 'exec_command', arguments: { cmd: 'touch codex-write-marker' } },
        { name: 'shell_command', arguments: { command: 'touch codex-write-marker' } },
      ],
    },
    { kind: 'complete', text: 'The requested write was blocked by the read-only sandbox.' },
    { kind: 'hold' },
  ])
  await writeFile(
    join(codexHome, 'config.toml'),
    [
      'model = "fixture-model"',
      'model_provider = "fixture"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'disable_response_storage = true',
      'check_for_update_on_startup = false',
      '',
      '[model_providers.fixture]',
      'name = "TwinDesk fixture"',
      `base_url = "${fixture.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
      '[analytics]',
      'enabled = false',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  )

  const ctx = new Context()
  const fibers: Fiber[] = []
  const starts: HarnessCodexLifecycleProjection[] = []
  const ends: HarnessCodexLifecycleProjection[] = []
  let lead: ReturnType<typeof ctx.agentLoop.create> | undefined

  async function mount(plugin: Plugin, config?: unknown): Promise<void> {
    fibers.push(await ctx.plugin(plugin, config))
  }

  try {
    await mount(LlmRuntime)
    await mount(SessionStore)
    await mount(SystemPrompt, { persona: 'Use only the configured foreground specialist Tool.' })
    await mount(ToolRuntime)
    await mount(AgentRegistry)
    await mount(AgentLoop, { agents: [] })
    await mount(SubagentRuntime)
    await mount(LocalSubprocessRuntime)
    await mount(CodexSubagent, {
      providerName: CODEX_PROVIDER,
      permissionMode: 'never',
      disposeGraceMs: 2_000,
      env: {
        OPENAI_API_KEY: 'twindesk-synthetic-codex-key',
        CODEX_HOME: codexHome,
        HOME: options.temporaryRoot,
        XDG_CONFIG_HOME: join(options.temporaryRoot, 'xdg'),
        PATH: process.env.PATH ?? delimiter,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '127.0.0.1,localhost',
      },
    })
    await mount(ToolSubagent, {
      provider: CODEX_PROVIDER,
      toolName: SUBAGENT_TOOL,
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    })

    ctx.on('subagent/start', (info) => starts.push(projectStart(info)))
    ctx.on('subagent/end', (info) => ends.push(projectEnd(info)))

    const provider = ctx.subagents.getProvider(CODEX_PROVIDER)
    if (provider === undefined) throw new Error('Codex provider was not registered')
    const schema = ctx.tools.schemas().find((candidate) => candidate.name === SUBAGENT_TOOL)
    if (schema === undefined) throw new Error('Codex subagent Tool was not registered')

    const leadAdapter = new CodexLeadAdapter()
    ctx.llm.registerAdapter(['twindesk-codex-lead'], leadAdapter)
    lead = ctx.agentLoop.create(
      SessionId('twindesk-codex-lead'),
      { provider: 'twindesk-codex-lead', model: 'deterministic' },
      { cwd: workspace },
    )
    lead.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Ask the Codex specialist for the repository title.' }],
        source: { kind: 'user' },
      }),
    )
    await lead.whenIdle()

    const leadTrace = lead.session.events.flatMap(
      (
        event,
      ): Array<{
        type: 'tool/call' | 'tool/result'
        name?: string
        isError?: boolean
        text?: string
      }> => {
        if (event.type === 'tool/call') {
          return [{ type: 'tool/call' as const, name: event.data.name }]
        }
        if (event.type !== 'tool/result') return []
        const block = event.data.message.content.find(
          (candidate) => candidate.type === 'tool-result',
        )
        const text = block?.content.find((candidate) => candidate.type === 'text')
        return [
          {
            type: 'tool/result' as const,
            ...(block === undefined ? {} : { isError: block.isError }),
            ...(text?.type === 'text' ? { text: text.text } : {}),
          },
        ]
      },
    )

    const writeRun = await ctx.subagents.start(CODEX_PROVIDER, {
      label: 'Attempt forbidden write',
      prompt: [{ type: 'text', text: 'Create codex-write-marker in the current workspace.' }],
      parent: lead,
      signal: new AbortController().signal,
    })
    await writeRun.result
    await writeRun.dispose()

    const cancelController = new AbortController()
    const cancelRun = await ctx.subagents.start(CODEX_PROVIDER, {
      label: 'Cancel bounded task',
      prompt: [{ type: 'text', text: 'Wait for further instructions.' }],
      parent: lead,
      signal: cancelController.signal,
    })
    await fixture.waitForRequest(4)
    cancelController.abort(new Error('TwinDesk cancellation probe'))
    const cancelled = await cancelRun.result
    await cancelRun.dispose()

    const requestsBeforeCapabilityRejections = fixture.requests.length
    const depthRejection = await expectRejection(() =>
      ctx.subagents.start(CODEX_PROVIDER, {
        label: 'Reject depth option',
        prompt: [{ type: 'text', text: 'This must not start.' }],
        parent: lead!,
        signal: new AbortController().signal,
        maxDepth: 1,
      }),
    )
    const toolFilterRejection = await expectRejection(() =>
      ctx.subagents.start(CODEX_PROVIDER, {
        label: 'Reject tool filter',
        prompt: [{ type: 'text', text: 'This must not start.' }],
        parent: lead!,
        signal: new AbortController().signal,
        toolFilter: { deny: ['write_file'] },
      }),
    )
    const numericDepthMountRejection = await expectRejection(async () => {
      const fiber = await ctx.plugin(ToolSubagent, {
        provider: CODEX_PROVIDER,
        toolName: 'invalid_depth_subagent',
        enableRunInBackground: false,
        maxDepth: 1,
      })
      await fiber.dispose()
    })
    const requestsAfterCapabilityRejections = fixture.requests.length

    let writeMarkerExists = true
    try {
      await readFile(writeMarker)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') writeMarkerExists = false
      else throw error
    }

    const parameterProperties = (schema.parameters as { properties?: Record<string, unknown> })
      .properties
    return Object.freeze({
      provider: provider.name,
      providerCapabilities: Object.freeze({ ...provider.capabilities }),
      inheritsParentContext: provider.inheritsParentContext,
      toolHasBackgroundArgument: parameterProperties?.run_in_background !== undefined,
      leadResultText: finalAssistantText(lead.session.deriveMessages()),
      leadObservedChildResult: JSON.stringify(leadAdapter.requests[1]?.messages ?? []).includes(
        'Repository title: TwinDesk Fixture',
      ),
      leadToolTrace: Object.freeze(leadTrace),
      lifecycleStarts: Object.freeze(starts),
      lifecycleEnds: Object.freeze(ends),
      advertisedNativeTools: Object.freeze(requestFunctionNames(fixture.requests[0]).sort()),
      readEvidenceObservedByModel: requestContainsText(fixture.requests[1], '# TwinDesk Fixture'),
      writeMarkerExists,
      cancellationStopReason: cancelled.stopReason,
      depthRejection,
      toolFilterRejection,
      numericDepthMountRejection,
      requestsBeforeCapabilityRejections,
      requestsAfterCapabilityRejections,
    })
  } finally {
    const disposalErrors: unknown[] = []
    try {
      for (const fiber of [...fibers].reverse()) {
        try {
          await fiber.dispose()
        } catch (error) {
          disposalErrors.push(error)
        }
      }
    } finally {
      try {
        await fixture.close()
      } catch (error) {
        disposalErrors.push(error)
      }
    }
    if (disposalErrors.length > 0) {
      throw new AggregateError(disposalErrors, 'Codex compatibility probe disposal failed')
    }
  }
}
