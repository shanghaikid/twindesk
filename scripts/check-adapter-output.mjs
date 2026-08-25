import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const adapterRoot = join(process.cwd(), 'packages', 'harness-adapter', 'dist')
const declarationFiles = (await readdir(adapterRoot)).filter((name) => name.endsWith('.d.ts'))
const declarations = await Promise.all(
  declarationFiles.map((name) => readFile(join(adapterRoot, name), 'utf8')),
)

if (declarations.some((source) => source.includes('@deepseek-ai/'))) {
  throw new Error('Harness adapter declarations must not expose upstream package types.')
}

const adapter = await import(pathToFileURL(join(adapterRoot, 'index.js')).href)
const adapterTesting = await import(pathToFileURL(join(adapterRoot, 'testing.js')).href)

if (
  typeof adapter.inspectHarnessCompatibility !== 'function' ||
  typeof adapter.SUPPORTED_CORDIS_VERSION !== 'string' ||
  typeof adapter.SUPPORTED_HARNESS_VERSION !== 'string'
) {
  throw new Error('Built Harness adapter is missing its public compatibility contract.')
}

if (typeof adapterTesting.probeHarnessToolPlugin !== 'function') {
  throw new Error('Built Harness adapter is missing its public testing contract.')
}

const compatibility = adapter.inspectHarnessCompatibility()

if (
  compatibility.cordisVersion !== adapter.SUPPORTED_CORDIS_VERSION ||
  compatibility.harnessVersion !== adapter.SUPPORTED_HARNESS_VERSION
) {
  throw new Error('Built Harness adapter reported an unexpected compatibility version.')
}

console.log('Built Harness adapter boundary passed.')
