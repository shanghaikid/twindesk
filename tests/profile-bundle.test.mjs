import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  apply,
  inject,
  name,
  TWIN_DESK_STATUS,
  TWIN_DESK_STATUS_TOOL_NAME,
} from '../packages/plugin-work-hub/src/index.ts'
import {
  apply as applyTechnicalContext,
  inject as technicalContextInject,
  name as technicalContextName,
  TWIN_DESK_TECHNICAL_CONTEXT,
  TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME,
} from '../packages/plugin-work-hub/src/technical-context.ts'
import {
  apply as applyUiHost,
  inject as uiHostInject,
  name as uiHostName,
} from '../packages/plugin-ui/src/index.ts'
import {
  prepareTwinDeskAgentPresets,
  prepareTwinDeskCodexSafetyConfig,
  PROFILE_BUNDLES,
  readBootGraph,
  resolveHarnessHome,
  TWIN_DESK_AGENT_PRESET_IDS,
} from '../scripts/harness-profile.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the Workbench Profile composes the pinned Harness layers in order', () => {
  assert.deepEqual(PROFILE_BUNDLES, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@twindesk/bundle-workbench',
  ])
  assert.equal(Object.isFrozen(PROFILE_BUNDLES), true)
})

test('a relative Harness home override is anchored to the repository', () => {
  const previous = process.env.TWINDESK_HARNESS_HOME
  process.env.TWINDESK_HARNESS_HOME = '.profile-test-home'
  try {
    assert.equal(resolveHarnessHome(), resolve(repositoryRoot, '.profile-test-home'))
  } finally {
    if (previous === undefined) delete process.env.TWINDESK_HARNESS_HOME
    else process.env.TWINDESK_HARNESS_HOME = previous
  }
})

test('the Workbench Bundle declares and mounts the TwinDesk Host and Client plugins', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../packages/bundle-workbench/package.json', import.meta.url), 'utf8'),
  )
  const patch = await readFile(
    new URL('../packages/bundle-workbench/cordis.patch.yml', import.meta.url),
    'utf8',
  )

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies['@twindesk/plugin-work-hub'], 'workspace:*')
  assert.equal(manifest.dependencies['@twindesk/plugin-ui'], 'workspace:*')
  assert.equal(manifest.dependencies['@twindesk/domain'], 'workspace:*')
  assert.equal(manifest.dependencies['@twindesk/harness-adapter'], 'workspace:*')
  assert.equal(manifest.exports['./cordis-runtime'].default, './dist/cordis-runtime.js')
  assert.deepEqual(manifest.files, ['agent-presets', 'cordis.patch.yml', 'dist'])
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-persona'], '0.1.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-skill-filesystem'], '0.1.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-subagent-codex'], '0.1.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-tool-subagent'], '0.1.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-tool-skill'], '0.1.1-rc.2')
  assert.match(patch, /id: twindesk-subagent-codex-readonly/u)
  assert.match(patch, /permissionMode: never/u)
  assert.match(patch, /CODEX_HOME: !!js dshHomePath\('twindesk-codex-readonly'\)/u)
  assert.match(patch, /id: twindesk-work-hub/u)
  assert.match(patch, /name: '@twindesk\/plugin-work-hub'/u)
  assert.match(patch, /id: twindesk-workbench-runtime/u)
  assert.match(patch, /name: '@twindesk\/bundle-workbench\/cordis-runtime'/u)
  assert.match(patch, /TWINDESK_WEB_PORT/u)
  assert.match(patch, /provider: !!js/u)
  assert.doesNotMatch(patch, /apiKey|credential:/u)
  assert.match(patch, /id: twindesk-ui/u)
  assert.match(patch, /name: '@twindesk\/plugin-ui'/u)
})

test('the Workbench Bundle owns two distinct draft-only Agent Presets', async () => {
  assert.deepEqual(TWIN_DESK_AGENT_PRESET_IDS, [
    'twindesk-technical-lead',
    'twindesk-communication',
  ])
  assert.equal(Object.isFrozen(TWIN_DESK_AGENT_PRESET_IDS), true)

  const presetRoot = resolve(repositoryRoot, 'packages/bundle-workbench/agent-presets')
  const technical = await readFile(
    join(presetRoot, 'twindesk-technical-lead', 'agent.cordis.yml'),
    'utf8',
  )
  const communication = await readFile(
    join(presetRoot, 'twindesk-communication', 'agent.cordis.yml'),
    'utf8',
  )

  assert.match(technical, /TwinDesk Technical Lead Persona/u)
  assert.match(technical, /@twindesk\/plugin-work-hub\/technical-context/u)
  assert.match(technical, /includeDefaultRoots: false/u)
  assert.match(technical, /never claim that a message was sent/u)
  assert.match(technical, /name: '@deepseek-ai\/dsh-tool-subagent'/u)
  assert.match(technical, /provider: twindesk-codex-readonly/u)
  assert.match(technical, /enableRunInBackground: false/u)
  assert.match(technical, /maxDepth: provider-managed/u)
  assert.match(communication, /TwinDesk Communication Persona/u)
  assert.match(communication, /includeDefaultRoots: false/u)
  assert.match(communication, /never claim that a message was sent/u)
  assert.doesNotMatch(communication, /technical-context/u)
  assert.doesNotMatch(communication, /dsh-tool-subagent/u)
  assert.doesNotMatch(`${technical}\n${communication}`, /dsh-tool-(?:bash|filesystem)/u)
})

test('Profile preparation creates a fail-closed native Codex safety config', async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), 'twindesk-profile-codex-'))
  try {
    const configPath = await prepareTwinDeskCodexSafetyConfig(harnessHome)
    assert.equal(await prepareTwinDeskCodexSafetyConfig(harnessHome), configPath)
    assert.equal(
      await readFile(configPath, 'utf8'),
      [
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'disable_response_storage = true',
        'check_for_update_on_startup = false',
        '',
      ].join('\n'),
    )
    assert.equal((await lstat(dirname(configPath))).mode & 0o777, 0o700)
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600)

    await writeFile(configPath, '# synthetic divergent config\n')
    await assert.rejects(
      prepareTwinDeskCodexSafetyConfig(harnessHome),
      /Refusing to overwrite divergent TwinDesk Codex safety config/u,
    )

    await rm(configPath)
    const linkedTarget = join(harnessHome, 'synthetic-target.toml')
    await writeFile(linkedTarget, '# synthetic link target\n')
    await symlink(linkedTarget, configPath)
    await assert.rejects(
      prepareTwinDeskCodexSafetyConfig(harnessHome),
      /Refusing to use non-file TwinDesk Codex safety config/u,
    )
  } finally {
    await rm(harnessHome, { recursive: true, force: true })
  }
})

test('Profile preparation materializes presets idempotently and refuses divergent content', async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), 'twindesk-profile-presets-'))
  try {
    const targetRoot = await prepareTwinDeskAgentPresets(harnessHome)
    await prepareTwinDeskAgentPresets(harnessHome)
    const technicalComposition = join(targetRoot, 'twindesk-technical-lead', 'agent.cordis.yml')
    const original = await readFile(technicalComposition, 'utf8')
    assert.match(original, /TwinDesk Technical Lead Persona/u)

    const divergent = '# synthetic local edit\n'
    await writeFile(technicalComposition, divergent)
    await assert.rejects(
      prepareTwinDeskAgentPresets(harnessHome),
      /Refusing to overwrite Agent Preset .* differs from the versioned bundle/u,
    )
    assert.equal(await readFile(technicalComposition, 'utf8'), divergent)
  } finally {
    await rm(harnessHome, { recursive: true, force: true })
  }
})

test('Profile preparation refuses a linked Agent Preset root', async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), 'twindesk-profile-preset-link-'))
  try {
    const linkedTarget = join(harnessHome, 'linked-target')
    await mkdir(linkedTarget)
    await symlink(linkedTarget, join(harnessHome, '.agent-presets'), 'dir')
    await assert.rejects(
      prepareTwinDeskAgentPresets(harnessHome),
      /Refusing to use non-directory Agent Preset root/u,
    )
  } finally {
    await rm(harnessHome, { recursive: true, force: true })
  }
})

test('the UI Host entry enrolls an external Client plugin', () => {
  assert.equal(typeof applyUiHost, 'function')
  assert.equal(uiHostName, 'twindesk-ui')
  assert.deepEqual(uiHostInject, [])
})

test('the Profile parser reads the Harness Client boot graph fail-loudly', () => {
  assert.deepEqual(
    readBootGraph(
      '<head><script>globalThis["__DSH_BOOT__"] = {"rev":"one","entries":[]}</script></head>',
    ),
    { rev: 'one', entries: [] },
  )
  assert.throws(() => readBootGraph('<head></head>'), /did not publish the __DSH_BOOT__/u)
})

test('the Work Hub Host plugin declares the status Tool contract', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(name, 'twindesk-work-hub')
  assert.deepEqual(inject, ['settings', 'tools'])
  assert.equal(TWIN_DESK_STATUS_TOOL_NAME, 'twindesk_status')
  assert.deepEqual(TWIN_DESK_STATUS, {
    product: 'TwinDesk',
    roadmapStage: 0,
    autonomyMode: 'draft_only',
    ready: true,
  })
  assert.equal(Object.isFrozen(TWIN_DESK_STATUS), true)
})

test('the technical-lead Preset plugin declares a scoped read-only context Tool', () => {
  assert.equal(typeof applyTechnicalContext, 'function')
  assert.equal(technicalContextName, 'twindesk-technical-context')
  assert.deepEqual(technicalContextInject, ['tools'])
  assert.equal(TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME, 'twindesk_technical_context')
  assert.deepEqual(TWIN_DESK_TECHNICAL_CONTEXT, {
    product: 'TwinDesk',
    perspective: 'technical_lead',
    autonomyMode: 'draft_only',
    evidenceRequired: true,
    externalWrites: false,
  })
  assert.equal(Object.isFrozen(TWIN_DESK_TECHNICAL_CONTEXT), true)
})
