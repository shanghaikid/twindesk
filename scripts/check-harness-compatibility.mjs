import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const HARNESS_COMPATIBILITY_TESTS = Object.freeze([
  Object.freeze({
    file: 'tests/harness-adapter.test.mjs',
    capability: 'pinned public interfaces and Client slot semantics',
  }),
  Object.freeze({
    file: 'tests/status-tool.test.mjs',
    capability: 'Host plugin activation, Tool registration, and Session trace',
  }),
  Object.freeze({
    file: 'tests/settings.test.mjs',
    capability: 'Settings persistence, validation, redaction, and disposal',
  }),
  Object.freeze({
    file: 'tests/client-plugin.test.mjs',
    capability: 'external Client plugin loading and Inbox slot lifecycle',
  }),
  Object.freeze({
    file: 'tests/profile-bundle.test.mjs',
    capability: 'Profile Bundle composition and fail-closed generated configuration',
  }),
  Object.freeze({
    file: 'tests/agent-presets.test.mjs',
    capability: 'Persona selection and Preset-scoped Skills and Tools',
  }),
  Object.freeze({
    file: 'tests/session-persistence.test.mjs',
    capability: 'Session persistence and duplicate-free cold resume',
  }),
  Object.freeze({
    file: 'tests/codex-subagent.test.mjs',
    capability: 'read-only Codex delegation, cancellation, and attribution',
  }),
  Object.freeze({
    file: 'tests/compatibility-suite.test.mjs',
    capability: 'suite coverage manifest and failure diagnostics',
  }),
  Object.freeze({
    file: 'tests/compatibility-report.test.mjs',
    capability: 'Stage 0 report alignment and gate recommendation',
  }),
  Object.freeze({
    file: 'tests/stage0-exit-gate.test.mjs',
    capability: 'TD-052 decision consistency and Stage 1 gate enforcement',
  }),
])

export const HARNESS_COMPATIBILITY_STEPS = Object.freeze([
  Object.freeze({
    id: 'build',
    capability: 'workspace and production Client artifacts',
    command: 'pnpm',
    args: Object.freeze(['run', 'build']),
  }),
  Object.freeze({
    id: 'contracts',
    capability: 'pinned Host, Client, Preset, Session, and Codex contracts',
    command: 'node',
    args: Object.freeze(['--test', ...HARNESS_COMPATIBILITY_TESTS.map(({ file }) => file)]),
  }),
  Object.freeze({
    id: 'adapter-output',
    capability: 'built adapter exports, declarations, and runtime versions',
    command: 'pnpm',
    args: Object.freeze(['run', 'adapter:check']),
  }),
  Object.freeze({
    id: 'profile',
    capability: 'effective Profile composition and real loopback startup',
    command: 'pnpm',
    args: Object.freeze(['run', 'profile:check']),
  }),
])

/** @param {{ command: string, args: readonly string[] }} step */
export function formatCompatibilityCommand(step) {
  return [step.command, ...step.args].join(' ')
}

/**
 * @param {{ id: string, capability: string, command: string, args: readonly string[] }} step
 * @param {{ status: number | null, signal?: NodeJS.Signals | null, error?: Error }} result
 */
export function compatibilityFailure(step, result) {
  const reason = result.error
    ? result.error.message
    : result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${String(result.status ?? 1)}`
  return new Error(
    `Harness compatibility step ${JSON.stringify(step.id)} failed (${step.capability}): ${reason}. Command: ${formatCompatibilityCommand(step)}`,
  )
}

/**
 * Run every Stage 0 Harness compatibility boundary in its supported production
 * composition. The injectable runner exists only for deterministic diagnostic
 * tests; production callers use Node's synchronous child-process runner.
 * @param {{ runner?: typeof spawnSync }} [options]
 */
export function runHarnessCompatibilitySuite(options = {}) {
  const pnpmCli = process.env.npm_execpath
  const packageManager = process.env.npm_config_user_agent
  if (!pnpmCli || !packageManager?.startsWith('pnpm/11.7.0 ')) {
    throw new Error(
      'Run the Harness compatibility suite through pnpm 11.7.0 so the pinned package manager is preserved.',
    )
  }

  const runner = options.runner ?? spawnSync
  for (const step of HARNESS_COMPATIBILITY_STEPS) {
    const args = step.command === 'pnpm' ? [pnpmCli, ...step.args] : [...step.args]
    console.log(`[compat:${step.id}] ${step.capability}`)
    const result = runner(process.execPath, args, { env: process.env, stdio: 'inherit' })
    if (result.error || result.status !== 0) throw compatibilityFailure(step, result)
  }
  console.log('TwinDesk Harness compatibility suite passed.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runHarnessCompatibilitySuite()
}
