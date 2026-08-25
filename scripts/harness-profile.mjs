import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PROFILE_NAME = 'workbench'
export const PROFILE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@twindesk/bundle-workbench',
])

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..')
const defaultHarnessHome = join(repositoryRoot, '.twindesk', 'harness')
const bundleRoot = join(repositoryRoot, 'packages', 'bundle-workbench')
const pluginRoot = join(repositoryRoot, 'packages', 'plugin-work-hub')
const dshBin = join(repositoryRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const startupTimeoutMs = 30_000
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
  const installedPlugin = join(profileRoot, 'node_modules', '@twindesk', 'plugin-work-hub')
  await mkdir(harnessHome, { recursive: true })
  await ensurePinnedPnpm(harnessHome)

  const [bundleTarget, pluginTarget] = await Promise.all([
    realpathOrUndefined(installedBundle),
    realpathOrUndefined(installedPlugin),
  ])
  const [expectedBundleTarget, expectedPluginTarget] = await Promise.all([
    realpath(bundleRoot),
    realpath(pluginRoot),
  ])
  let manifest = await readProfileManifest(manifestPath, true)
  const dependencies = manifest && isRecord(manifest.dependencies) ? manifest.dependencies : {}

  if (
    bundleTarget !== expectedBundleTarget ||
    pluginTarget !== expectedPluginTarget ||
    dependencies['@twindesk/bundle-workbench'] === undefined ||
    dependencies['@twindesk/plugin-work-hub'] === undefined
  ) {
    runDshSync(
      ['plugin', '--profile', PROFILE_NAME, 'add', '--save-exact', bundleRoot, pluginRoot],
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
 * Start the Web Profile and shut it down after Harness reports its bound URL.
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
      if (!ready && /dsh web: http:\/\//u.test(output)) {
        ready = true
        clearTimeout(timeout)
        child.kill('SIGTERM')
        forcedShutdown = setTimeout(() => {
          shutdownTimedOut = true
          child.kill('SIGKILL')
        }, shutdownTimeoutMs)
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
      !config.includes("name: '@twindesk/plugin-work-hub'")
    ) {
      throw new Error(
        'The effective Harness configuration does not contain the TwinDesk Host plugin.',
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
