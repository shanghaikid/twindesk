import cordisManifest from '@deepseek-ai/cordis/package.json' with { type: 'json' }
import agentManifest from '@deepseek-ai/dsh-agent/package.json' with { type: 'json' }
import agentLoopManifest from '@deepseek-ai/dsh-agent-loop/package.json' with { type: 'json' }
import appBootManifest from '@deepseek-ai/dsh-app-boot/package.json' with { type: 'json' }
import llmManifest from '@deepseek-ai/dsh-llm/package.json' with { type: 'json' }
import sessionManifest from '@deepseek-ai/dsh-session/package.json' with { type: 'json' }
import settingsManifest from '@deepseek-ai/dsh-settings/package.json' with { type: 'json' }
import settingsFileManifest from '@deepseek-ai/dsh-settings-file/package.json' with { type: 'json' }
import systemPromptManifest from '@deepseek-ai/dsh-system-prompt/package.json' with { type: 'json' }
import toolsManifest from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' }
import schemasteryManifest from '@deepseek-ai/schemastery/package.json' with { type: 'json' }
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { DshProfileManifest as UpstreamProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const SUPPORTED_CORDIS_VERSION = '4.0.1'
export const SUPPORTED_HARNESS_VERSION = '0.1.1-rc.2'
export const SUPPORTED_SCHEMASTERY_VERSION = '3.18.1'

type HasCordisLifecycle = 'effect' | 'plugin' extends keyof CordisContext ? true : never
type HasProfileBundles = UpstreamProfileManifest extends { bundles?: string[] } ? true : never
type HasSettingsRegistry = 'settings' extends keyof CordisContext ? true : never
type HasToolRegistry = 'tools' extends keyof CordisContext ? true : never

const hasCordisLifecycle: HasCordisLifecycle = true
const hasProfileBundles: HasProfileBundles = true
const hasSettingsRegistry: HasSettingsRegistry = true
const hasToolRegistry: HasToolRegistry = true
const harnessPackageManifests = Object.freeze([
  ['@deepseek-ai/dsh-agent', agentManifest],
  ['@deepseek-ai/dsh-agent-loop', agentLoopManifest],
  ['@deepseek-ai/dsh-app-boot', appBootManifest],
  ['@deepseek-ai/dsh-llm', llmManifest],
  ['@deepseek-ai/dsh-session', sessionManifest],
  ['@deepseek-ai/dsh-settings', settingsManifest],
  ['@deepseek-ai/dsh-settings-file', settingsFileManifest],
  ['@deepseek-ai/dsh-system-prompt', systemPromptManifest],
  ['@deepseek-ai/dsh-tools', toolsManifest],
] as const)

/** Lossless JSON values that may cross the Harness Tool boundary. */
export type HarnessJsonValue =
  null | boolean | number | string | HarnessJsonValue[] | { [key: string]: HarnessJsonValue }

/** Cordis lifecycle surface exposed to an out-of-tree TwinDesk Host plugin. */
export interface HarnessHostContext {
  effect(effect: () => () => void, label: string): void
}

/** A no-argument, read-only Tool owned outside Harness core. */
export interface ReadonlyHarnessTool<TValue extends HarnessJsonValue> {
  readonly name: string
  readonly description: string
  read(signal: AbortSignal): Promise<TValue>
  render(value: TValue): string
}

/** One boolean-only settings namespace owned by a TwinDesk Host plugin. */
export interface BooleanHarnessSettingDefinition<TKey extends string> {
  readonly namespace: string
  readonly key: TKey
  readonly defaultValue: boolean
  readonly description: string
  readonly applies?: 'live' | 'restart'
}

/** Narrow owner handle returned for a registered boolean setting. */
export interface BooleanHarnessSettingScope<TKey extends string> {
  get(): Readonly<Record<TKey, boolean>>
}

export interface HarnessCompatibility {
  readonly cordisVersion: typeof SUPPORTED_CORDIS_VERSION
  readonly harnessVersion: typeof SUPPORTED_HARNESS_VERSION
  readonly schemasteryVersion: typeof SUPPORTED_SCHEMASTERY_VERSION
  readonly contracts: {
    readonly cordisLifecycle: true
    readonly profileBundles: true
    readonly settingsRegistry: true
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
  assertVersion(
    '@deepseek-ai/schemastery',
    SUPPORTED_SCHEMASTERY_VERSION,
    schemasteryManifest.version,
  )
  for (const [packageName, manifest] of harnessPackageManifests) {
    assertVersion(packageName, SUPPORTED_HARNESS_VERSION, manifest.version)
  }

  return Object.freeze({
    cordisVersion: SUPPORTED_CORDIS_VERSION,
    harnessVersion: SUPPORTED_HARNESS_VERSION,
    schemasteryVersion: SUPPORTED_SCHEMASTERY_VERSION,
    contracts: Object.freeze({
      cordisLifecycle: hasCordisLifecycle,
      profileBundles: hasProfileBundles,
      settingsRegistry: hasSettingsRegistry,
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
  host: HarnessHostContext,
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

/**
 * Register one live or restart-applied boolean setting through Harness.
 *
 * Schemastery preserves unknown object keys by default. The owner validator
 * therefore enforces an exact allowlist without echoing an attacker-controlled
 * key or value into its error. This keeps undeclared secret-like fields out of
 * storage, browser descriptors, and serialized diagnostics.
 */
export function registerBooleanHarnessSetting<TKey extends string>(
  host: HarnessHostContext,
  definition: BooleanHarnessSettingDefinition<TKey>,
): BooleanHarnessSettingScope<TKey> {
  const ctx = host as CordisContext
  const schema = z.object({
    [definition.key]: z
      .boolean()
      .default(definition.defaultValue)
      .description(definition.description),
  }) as z<Record<TKey, boolean>>
  const scope = ctx.settings.register(settingsNamespace(definition.namespace), schema, {
    applies: definition.applies ?? 'live',
    validate(value) {
      if (Object.keys(value).some((key) => key !== definition.key)) {
        throw new TypeError(
          `settings namespace ${JSON.stringify(definition.namespace)} accepts only declared fields`,
        )
      }
    },
  })

  return {
    get: () => scope.get(),
  }
}
