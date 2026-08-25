import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const packageNamesByDirectory = new Map([
  ['bundle-workbench', '@twindesk/bundle-workbench'],
  ['domain', '@twindesk/domain'],
  ['harness-adapter', '@twindesk/harness-adapter'],
  ['plugin-feishu', '@twindesk/plugin-feishu'],
  ['plugin-jira', '@twindesk/plugin-jira'],
  ['plugin-ui', '@twindesk/plugin-ui'],
  ['plugin-work-hub', '@twindesk/plugin-work-hub'],
  ['storage-sqlite', '@twindesk/storage-sqlite'],
])

const harnessIntegrity =
  'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg=='

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} path
 * @param {string[]} errors
 * @returns {Promise<unknown>}
 */
async function readJson(path, errors) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot read valid JSON from ${path}: ${message}`)
    return undefined
  }
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function validateWorkspace(root) {
  /** @type {string[]} */
  const errors = []
  const rootManifest = await readJson(join(root, 'package.json'), errors)
  const rootTsconfig = await readJson(join(root, 'tsconfig.json'), errors)

  if (isRecord(rootManifest)) {
    if (rootManifest.packageManager !== 'pnpm@11.7.0') {
      errors.push('package.json must pin pnpm@11.7.0')
    }

    const engines = rootManifest.engines
    if (!isRecord(engines) || engines.node !== '^24.0.0') {
      errors.push('package.json must select Node.js 24')
    }

    const devDependencies = rootManifest.devDependencies
    if (!isRecord(devDependencies) || devDependencies['@deepseek-ai/dsh'] !== '0.1.1-rc.2') {
      errors.push('package.json must pin @deepseek-ai/dsh@0.1.1-rc.2 exactly')
    }
  }

  try {
    const nodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim()
    if (nodeVersion !== '24') {
      errors.push('.node-version must select Node.js 24')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot read .node-version: ${message}`)
  }

  try {
    const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
    if (!workspace.includes('  - packages/*')) {
      errors.push('pnpm-workspace.yaml must include packages/*')
    }
    if (!workspace.includes("'@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2': true")) {
      errors.push('pnpm-workspace.yaml must allow only the pinned Harness subprocess build')
    }
    if (/dsh-subprocess-local':\s+true/u.test(workspace)) {
      errors.push('pnpm-workspace.yaml must not allow an unversioned Harness subprocess build')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot read pnpm-workspace.yaml: ${message}`)
  }

  try {
    const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
    if (!lockfile.includes("'@deepseek-ai/dsh@0.1.1-rc.2':")) {
      errors.push('pnpm-lock.yaml must contain the pinned Harness package')
    }
    if (!lockfile.includes(`integrity: ${harnessIntegrity}`)) {
      errors.push('pnpm-lock.yaml must preserve the verified Harness package integrity')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot read pnpm-lock.yaml: ${message}`)
  }

  const references =
    isRecord(rootTsconfig) && Array.isArray(rootTsconfig.references) ? rootTsconfig.references : []
  const actualReferences = new Set(
    references.flatMap((reference) =>
      isRecord(reference) && typeof reference.path === 'string'
        ? [reference.path.replace('./packages/', '')]
        : [],
    ),
  )

  try {
    const packageDirectories = new Set(
      (await readdir(join(root, 'packages'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    )

    for (const directory of packageDirectories) {
      if (!packageNamesByDirectory.has(directory)) {
        errors.push(`packages/${directory} is not declared by the Stage 0 scaffold contract`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot inspect the packages directory: ${message}`)
  }

  for (const [directory, expectedName] of packageNamesByDirectory) {
    if (!actualReferences.has(directory)) {
      errors.push(`tsconfig.json is missing a project reference for ${directory}`)
    }

    const packageRoot = join(root, 'packages', directory)
    const manifest = await readJson(join(packageRoot, 'package.json'), errors)
    await readJson(join(packageRoot, 'tsconfig.json'), errors)

    if (!isRecord(manifest) || manifest.name !== expectedName) {
      errors.push(`${directory}/package.json must use the name ${expectedName}`)
    }
    if (!isRecord(manifest) || manifest.private !== true) {
      errors.push(`${expectedName} must remain private during Stage 0`)
    }
    if (!isRecord(manifest) || manifest.type !== 'module') {
      errors.push(`${expectedName} must use ECMAScript modules`)
    }

    try {
      await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8')
    } catch {
      errors.push(`${expectedName} is missing src/index.ts`)
    }
  }

  if (actualReferences.size !== packageNamesByDirectory.size) {
    errors.push('tsconfig.json contains an unexpected number of project references')
  }

  try {
    const envExample = await readFile(join(root, '.env.example'), 'utf8')
    const declarations = envExample.split(/\r?\n/u).filter(Boolean)
    if (declarations.length === 0) {
      errors.push('.env.example must declare at least one variable name')
    }
    for (const declaration of declarations) {
      if (!/^[A-Z][A-Z0-9_]*=$/u.test(declaration)) {
        errors.push('.env.example must contain variable names with empty values only')
        break
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`Cannot read .env.example: ${message}`)
  }

  return errors
}
