import cordisManifest from '@deepseek-ai/cordis/package.json' with { type: 'json' }
import agentManifest from '@deepseek-ai/dsh-agent/package.json' with { type: 'json' }
import agentLoopManifest from '@deepseek-ai/dsh-agent-loop/package.json' with { type: 'json' }
import appBootManifest from '@deepseek-ai/dsh-app-boot/package.json' with { type: 'json' }
import llmManifest from '@deepseek-ai/dsh-llm/package.json' with { type: 'json' }
import sessionManifest from '@deepseek-ai/dsh-session/package.json' with { type: 'json' }
import systemPromptManifest from '@deepseek-ai/dsh-system-prompt/package.json' with { type: 'json' }
import toolsManifest from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' }
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { DshProfileManifest as UpstreamProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const SUPPORTED_CORDIS_VERSION = '4.0.1'
export const SUPPORTED_HARNESS_VERSION = '0.1.1-rc.2'

type HasCordisLifecycle = 'effect' | 'plugin' extends keyof CordisContext ? true : never
type HasProfileBundles = UpstreamProfileManifest extends { bundles?: string[] } ? true : never
type HasToolRegistry = 'tools' extends keyof CordisContext ? true : never

const hasCordisLifecycle: HasCordisLifecycle = true
const hasProfileBundles: HasProfileBundles = true
const hasToolRegistry: HasToolRegistry = true
const harnessPackageManifests = Object.freeze([
  ['@deepseek-ai/dsh-agent', agentManifest],
  ['@deepseek-ai/dsh-agent-loop', agentLoopManifest],
  ['@deepseek-ai/dsh-app-boot', appBootManifest],
  ['@deepseek-ai/dsh-llm', llmManifest],
  ['@deepseek-ai/dsh-session', sessionManifest],
  ['@deepseek-ai/dsh-system-prompt', systemPromptManifest],
  ['@deepseek-ai/dsh-tools', toolsManifest],
] as const)

/** Lossless JSON values that may cross the Harness Tool boundary. */
export type HarnessJsonValue =
  null | boolean | number | string | HarnessJsonValue[] | { [key: string]: HarnessJsonValue }

/** Cordis lifecycle surface exposed to an out-of-tree TwinDesk Host plugin. */
export interface HarnessToolHostContext {
  effect(effect: () => () => void, label: string): void
}

/** A no-argument, read-only Tool owned outside Harness core. */
export interface ReadonlyHarnessTool<TValue extends HarnessJsonValue> {
  readonly name: string
  readonly description: string
  read(signal: AbortSignal): Promise<TValue>
  render(value: TValue): string
}

export interface HarnessCompatibility {
  readonly cordisVersion: typeof SUPPORTED_CORDIS_VERSION
  readonly harnessVersion: typeof SUPPORTED_HARNESS_VERSION
  readonly contracts: {
    readonly cordisLifecycle: true
    readonly profileBundles: true
    readonly toolRegistry: true
  }
}

export class UnsupportedHarnessVersionError extends Error {
  readonly code = 'UNSUPPORTED_HARNESS_VERSION'
  readonly packageName: string
  readonly expected: string
  readonly actual: string

  constructor(packageName: string, expected: string, actual: string) {
    super(`Unsupported ${packageName} version: expected ${expected}, received ${actual}`)
    this.name = 'UnsupportedHarnessVersionError'
    this.packageName = packageName
    this.expected = expected
    this.actual = actual
  }
}

function assertVersion(packageName: string, expected: string, actual: string): void {
  if (actual !== expected) {
    throw new UnsupportedHarnessVersionError(packageName, expected, actual)
  }
}

export function inspectHarnessCompatibility(): HarnessCompatibility {
  assertVersion('@deepseek-ai/cordis', SUPPORTED_CORDIS_VERSION, cordisManifest.version)
  for (const [packageName, manifest] of harnessPackageManifests) {
    assertVersion(packageName, SUPPORTED_HARNESS_VERSION, manifest.version)
  }

  return Object.freeze({
    cordisVersion: SUPPORTED_CORDIS_VERSION,
    harnessVersion: SUPPORTED_HARNESS_VERSION,
    contracts: Object.freeze({
      cordisLifecycle: hasCordisLifecycle,
      profileBundles: hasProfileBundles,
      toolRegistry: hasToolRegistry,
    }),
  })
}

/**
 * Register one no-argument read-only Tool through the pinned Harness API.
 *
 * Keeping `defineTool`, the registry contract, and Tool execution types here
 * prevents Harness-specific types from leaking into TwinDesk Host plugins.
 * The returned function is the exact registry disposer and must be owned by
 * the caller's Cordis lifecycle effect.
 */
export function registerReadonlyHarnessTool<TValue extends HarnessJsonValue>(
  host: HarnessToolHostContext,
  tool: ReadonlyHarnessTool<TValue>,
): () => void {
  const ctx = host as CordisContext

  return ctx.tools.register(
    defineTool({
      name: tool.name,
      description: tool.description,
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: tool.render(value as TValue) }],
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const value = await tool.read(exec.signal)
        exec.signal.throwIfAborted()
        return value
      },
    }),
  )
}
