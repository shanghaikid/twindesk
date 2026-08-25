import { spawn, spawnSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CLIENT_PLUGIN_ID, inspectClientPluginArtifacts } from './build-client-plugin.mjs'

export const PROFILE_NAME = 'workbench'
export const PROFILE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@twindesk/bundle-workbench',
])
export const TWIN_DESK_AGENT_PRESET_IDS = Object.freeze([
  'twindesk-technical-lead',
  'twindesk-communication',
])

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..')
const defaultHarnessHome = join(repositoryRoot, '.twindesk', 'harness')
const profilePnpmStore = join(repositoryRoot, '.pnpm-store')
const bundleRoot = join(repositoryRoot, 'packages', 'bundle-workbench')
const bundledAgentPresetRoot = join(bundleRoot, 'agent-presets')
const workHubPluginRoot = join(repositoryRoot, 'packages', 'plugin-work-hub')
const uiPluginRoot = join(repositoryRoot, 'packages', 'plugin-ui')
const dshBin = join(repositoryRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const startupTimeoutMs = 30_000
const clientVerificationTimeoutMs = 10_000
const shutdownTimeoutMs = 5_000
const maxDiagnosticOutput = 64 * 1024

/** @returns {string} */
export function resolveHarnessHome() {
  return resolve(repositoryRoot, process.env.TWINDESK_HARNESS_HOME ?? defaultHarnessHome)
}

/** @param {string} harnessHome */
function profileDirectory(harnessHome) {
  return join(harnessHome, 'profiles', PROFILE_NAME)
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** @param {string} harnessHome */
async function ensurePinnedPnpm(harnessHome) {
  const pnpmCli = process.env.npm_execpath
  const packageManager = process.env.npm_config_user_agent
  if (!pnpmCli || !packageManager?.startsWith('pnpm/11.7.0 ')) {
    throw new Error('Run Profile commands through pnpm 11.7.0 so plugin installation is pinned.')
  }

  const shimDirectory = join(harnessHome, '.bin')
  await mkdir(shimDirectory, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(
      join(shimDirectory, 'pnpm.cmd'),
      `@echo off\r\n"${process.execPath}" "${pnpmCli}" %*\r\n`,
    )
  } else {
    const shim = join(shimDirectory, 'pnpm')
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(pnpmCli)} "$@"\n`,
    )
    await chmod(shim, 0o755)
  }
}

/**
 * @param {string[]} args
 * @param {string} harnessHome
 * @param {'inherit' | 'pipe'} stdio
 */
function runDshSync(args, harnessHome, stdio = 'inherit') {
  const shimDirectory = join(harnessHome, '.bin')
  const result = spawnSync(process.execPath, [dshBin, ...args], {
    cwd: repositoryRoot,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    env: {
      ...process.env,
      DSH_HOME: harnessHome,
      PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}`,
    },
    stdio,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = stdio === 'pipe' ? `${result.stdout ?? ''}${result.stderr ?? ''}` : ''
    throw new Error(`dsh ${args.join(' ')} failed with exit code ${result.status ?? 1}\n${output}`)
  }

  return result
}

/** @param {string} path */
async function realpathOrUndefined(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** @param {string} path */
async function lstatOrUndefined(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read one preset as a relative-path to byte-content map while refusing links
 * and special files. Preset materialization must never follow an unexpected
 * path outside the versioned bundle or generated Harness home.
 * @param {string} root
 * @returns {Promise<Map<string, Buffer | null>>}
 */
async function snapshotPreset(root) {
  const snapshot = new Map()

  /** @param {string} directory @param {string} relativeDirectory */
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = join(relativeDirectory, entry.name)
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent Preset contains an unsupported symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, null)
        await visit(path, relativePath)
      } else if (entry.isFile()) {
        snapshot.set(relativePath, await readFile(path))
      } else {
        throw new Error(`Agent Preset contains an unsupported special file: ${path}`)
      }
    }
  }

  await visit(root, '')
  return snapshot
}

/**
 * @param {Map<string, Buffer | null>} expected
 * @param {Map<string, Buffer | null>} actual
 */
function snapshotsEqual(expected, actual) {
  if (expected.size !== actual.size) return false
  for (const [path, content] of expected) {
    const candidate = actual.get(path)
    if (content === null ? candidate !== null : !candidate?.equals(content)) return false
  }
  return true
}

/**
 * Install the versioned TwinDesk presets into Harness's supported user root.
 * Existing matching copies are accepted; divergent content is never replaced.
 * @param {string} harnessHome
 */
export async function prepareTwinDeskAgentPresets(harnessHome = resolveHarnessHome()) {
  const targetRoot = join(harnessHome, '.agent-presets')
  await mkdir(targetRoot, { recursive: true })
  const targetRootStat = await lstat(targetRoot)
  if (!targetRootStat.isDirectory() || targetRootStat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory Agent Preset root: ${targetRoot}`)
  }

  for (const presetId of TWIN_DESK_AGENT_PRESET_IDS) {
    const source = join(bundledAgentPresetRoot, presetId)
    const target = join(targetRoot, presetId)
    const sourceStat = await lstatOrUndefined(source)
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Bundled Agent Preset is not a regular directory: ${source}`)
    }
    const expected = await snapshotPreset(source)
    const targetStat = await lstatOrUndefined(target)
    if (targetStat === undefined) {
      await cp(source, target, { recursive: true, errorOnExist: true, force: false })
      if (!snapshotsEqual(expected, await snapshotPreset(target))) {
        throw new Error(
          `Copied Agent Preset ${JSON.stringify(presetId)} does not match the versioned bundle: ${target}`,
        )
      }
      continue
    }
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite non-directory Agent Preset target: ${target}`)
    }
    if (!snapshotsEqual(expected, await snapshotPreset(target))) {
      throw new Error(
        `Refusing to overwrite Agent Preset ${JSON.stringify(presetId)} because its generated Harness copy differs from the versioned bundle: ${target}`,
      )
    }
  }

  return targetRoot
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @typedef {{ rev: string, entries: unknown[] }} ParsedBootGraph */

/**
 * @param {string} manifestPath
 * @param {boolean} allowMissing
 */
async function readProfileManifest(manifestPath, allowMissing = false) {
  let source
  try {
    source = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }

  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot parse generated Harness Profile manifest ${manifestPath}: ${message}`)
  }
  if (!isRecord(manifest)) {
    throw new Error(
      `Generated Harness Profile manifest ${manifestPath} must contain a JSON object.`,
    )
  }
  return manifest
}

/** @param {string} harnessHome */
export async function prepareProfile(harnessHome = resolveHarnessHome()) {
  const profileRoot = profileDirectory(harnessHome)
  const manifestPath = join(profileRoot, 'package.json')
  const installedBundle = join(profileRoot, 'node_modules', '@twindesk', 'bundle-workbench')
  const installedWorkHubPlugin = join(profileRoot, 'node_modules', '@twindesk', 'plugin-work-hub')
  const installedUiPlugin = join(profileRoot, 'node_modules', '@twindesk', 'plugin-ui')
  await mkdir(harnessHome, { recursive: true })
  await ensurePinnedPnpm(harnessHome)
  await inspectClientPluginArtifacts(uiPluginRoot)
  await prepareTwinDeskAgentPresets(harnessHome)

  const [bundleTarget, workHubPluginTarget, uiPluginTarget] = await Promise.all([
    realpathOrUndefined(installedBundle),
    realpathOrUndefined(installedWorkHubPlugin),
    realpathOrUndefined(installedUiPlugin),
  ])
  const [expectedBundleTarget, expectedWorkHubPluginTarget, expectedUiPluginTarget] =
    await Promise.all([realpath(bundleRoot), realpath(workHubPluginRoot), realpath(uiPluginRoot)])
  let manifest = await readProfileManifest(manifestPath, true)
  const dependencies = manifest && isRecord(manifest.dependencies) ? manifest.dependencies : {}

  if (
    bundleTarget !== expectedBundleTarget ||
    workHubPluginTarget !== expectedWorkHubPluginTarget ||
    uiPluginTarget !== expectedUiPluginTarget ||
    dependencies['@twindesk/bundle-workbench'] === undefined ||
    dependencies['@twindesk/plugin-work-hub'] === undefined ||
    dependencies['@twindesk/plugin-ui'] === undefined
  ) {
    runDshSync(
      [
        'plugin',
        '--profile',
        PROFILE_NAME,
        'add',
        '--store-dir',
        profilePnpmStore,
        '--save-exact',
        bundleRoot,
        workHubPluginRoot,
        uiPluginRoot,
      ],
      harnessHome,
    )
    manifest = await readProfileManifest(manifestPath)
  }

  if (!manifest) {
    throw new Error(`Harness did not create the generated Profile manifest ${manifestPath}.`)
  }
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  manifest.packageManager = 'pnpm@11.7.0'
  manifest.dsh = {
    ...dsh,
    profile: {
      ...profile,
      bundles: [...PROFILE_BUNDLES],
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return profileRoot
}

/** @param {string} harnessHome */
export async function dumpProfile(harnessHome = resolveHarnessHome()) {
  await prepareProfile(harnessHome)
  const result = runDshSync(['--profile', PROFILE_NAME, '--dump-config'], harnessHome, 'pipe')
  return String(result.stdout)
}

/**
 * @param {string} html
 * @returns {ParsedBootGraph}
 */
export function readBootGraph(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('Harness index did not publish the __DSH_BOOT__ Client graph.')
  const valueStart = start + marker.length
  const valueEnd = html.indexOf('</script>', valueStart)
  if (valueEnd < 0) throw new Error('Harness index contains an unterminated __DSH_BOOT__ graph.')
  let graph
  try {
    graph = JSON.parse(html.slice(valueStart, valueEnd))
  } catch (error) {
    throw new Error('Harness index published an invalid __DSH_BOOT__ Client graph.', {
      cause: error,
    })
  }
  if (!isRecord(graph) || typeof graph.rev !== 'string' || !Array.isArray(graph.entries)) {
    throw new Error('Harness index published a malformed __DSH_BOOT__ Client graph.')
  }
  return /** @type {ParsedBootGraph} */ (graph)
}

/** @param {string} baseUrl */
async function verifyServedClientPlugin(baseUrl) {
  const signal = AbortSignal.timeout(clientVerificationTimeoutMs)
  /** @type {{ graphRev: string, entry: { url: string, rev: string } }[]} */
  const snapshots = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(baseUrl, { cache: 'no-store', signal })
    if (!response.ok) {
      throw new Error(`Harness index reload returned HTTP ${String(response.status)}.`)
    }
    const graph = readBootGraph(await response.text())
    const entry = graph.entries.find(
      (candidate) => isRecord(candidate) && candidate.id === CLIENT_PLUGIN_ID,
    )
    if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.rev !== 'string') {
      throw new Error(`Harness Client graph does not contain ${CLIENT_PLUGIN_ID}.`)
    }
    snapshots.push({ graphRev: graph.rev, entry: { url: entry.url, rev: entry.rev } })
  }
  if (
    snapshots[0]?.graphRev !== snapshots[1]?.graphRev ||
    snapshots[0]?.entry.rev !== snapshots[1]?.entry.rev
  ) {
    throw new Error('Harness Client graph changed across an unchanged full-page reload.')
  }

  const entry = snapshots[0]?.entry
  if (entry === undefined) throw new Error('Harness Client entry disappeared before fetch.')
  const bundleUrl = new URL(entry.url, baseUrl)
  const [bundleResponse, sourceMapResponse] = await Promise.all([
    fetch(bundleUrl, { cache: 'no-store', signal }),
    fetch(new URL(`${bundleUrl.pathname}.map`, baseUrl), { cache: 'no-store', signal }),
  ])
  if (!bundleResponse.ok || !sourceMapResponse.ok) {
    throw new Error(
      `Harness did not serve the TwinDesk Client artifacts (bundle ${String(bundleResponse.status)}, source map ${String(sourceMapResponse.status)}).`,
    )
  }
  const bundle = await bundleResponse.text()
  if (!bundle.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_PLUGIN_ID)}`)) {
    throw new Error('Harness served a TwinDesk Client bundle with an invalid loader registration.')
  }
  const sourceMap = JSON.parse(await sourceMapResponse.text())
  if (sourceMap?.file !== 'client.js') {
    throw new Error('Harness served an invalid TwinDesk Client source map.')
  }
}

/**
 * Start the Web Profile, verify its served Client graph, and shut it down.
 * @param {string} harnessHome
 */
export async function smokeProfile(harnessHome = resolveHarnessHome()) {
  await prepareProfile(harnessHome)

  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [dshBin, '--profile', PROFILE_NAME, '--port', '0', '--no-open'],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DSH_HOME: harnessHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    let ready = false
    /** @type {unknown} */
    let verificationFailure
    let timedOut = false
    let shutdownTimedOut = false
    /** @type {NodeJS.Timeout | undefined} */
    let forcedShutdown
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forcedShutdown = setTimeout(() => {
        shutdownTimedOut = true
        child.kill('SIGKILL')
      }, shutdownTimeoutMs)
    }, startupTimeoutMs)

    /** @param {Buffer | string} chunk */
    const consume = (chunk) => {
      output += String(chunk)
      if (output.length > maxDiagnosticOutput) output = output.slice(-maxDiagnosticOutput)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (!ready && match?.[1] !== undefined) {
        ready = true
        clearTimeout(timeout)
        void verifyServedClientPlugin(match[1])
          .catch((error) => {
            verificationFailure = error
          })
          .finally(() => {
            child.kill('SIGTERM')
            forcedShutdown = setTimeout(() => {
              shutdownTimedOut = true
              child.kill('SIGKILL')
            }, shutdownTimeoutMs)
          })
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', (error) => {
      clearTimeout(timeout)
      clearTimeout(forcedShutdown)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      clearTimeout(forcedShutdown)
      if (timedOut) {
        reject(new Error(`Timed out waiting for the TwinDesk Profile to start.\n${output}`))
        return
      }
      if (shutdownTimedOut) {
        reject(
          new Error(
            `TwinDesk Profile did not shut down within ${shutdownTimeoutMs} ms.\n${output}`,
          ),
        )
        return
      }
      if (verificationFailure !== undefined) {
        reject(
          new Error(`TwinDesk Client plugin production verification failed.\n${output}`, {
            cause: verificationFailure,
          }),
        )
        return
      }
      if (ready && code === 0) {
        resolvePromise(undefined)
        return
      }
      reject(
        new Error(
          `TwinDesk Profile exited before a clean startup (code ${String(code)}, signal ${String(signal)}).\n${output}`,
        ),
      )
    })
  })
}

/** @param {string[]} args */
async function main(args) {
  const [command = 'check', ...rest] = args
  const harnessHome = resolveHarnessHome()

  if (command === 'prepare') {
    const profileRoot = await prepareProfile(harnessHome)
    console.log(`TwinDesk Harness Profile prepared at ${profileRoot}`)
    return
  }
  if (command === 'dump') {
    process.stdout.write(await dumpProfile(harnessHome))
    return
  }
  if (command === 'start') {
    await prepareProfile(harnessHome)
    const forwarded = rest[0] === '--' ? rest.slice(1) : rest
    const result = runDshSync(['--profile', PROFILE_NAME, '--no-open', ...forwarded], harnessHome)
    process.exitCode = result.status ?? 0
    return
  }
  if (command === 'check') {
    const config = await dumpProfile(harnessHome)
    if (
      !config.includes('id: twindesk-work-hub') ||
      !config.includes("name: '@twindesk/plugin-work-hub'") ||
      !config.includes('id: twindesk-ui') ||
      !config.includes("name: '@twindesk/plugin-ui'")
    ) {
      throw new Error(
        'The effective Harness configuration does not contain the required TwinDesk plugins.',
      )
    }
    await smokeProfile(harnessHome)
    console.log('TwinDesk Harness Profile composition and startup passed.')
    return
  }

  throw new Error(`Unknown Harness Profile command: ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
