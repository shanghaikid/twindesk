import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(repositoryRoot, 'packages', 'web')
const sourceRoot = join(packageRoot, 'src', 'static')
const outputRoot = join(packageRoot, 'dist')

if (process.argv[2] === 'clean') {
  await rm(outputRoot, { force: true, recursive: true })
  process.exit(0)
}

for (const compiledEntry of [
  'app.js',
  'audit-contract.js',
  'cli.js',
  'feishu-authorization-contract.js',
  'feishu-oauth-recovery-contract.js',
  'feishu-reauthorization-contract.js',
  'feishu-settings-contract.js',
  'inbox-contract.js',
  'model-draft-contract.js',
  'index.js',
  'routes.js',
  'server.js',
]) {
  try {
    const entry = await stat(join(outputRoot, compiledEntry))
    if (!entry.isFile()) throw new Error('not a regular file')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Build @twindesk/web with TypeScript before copying static assets: ${message}`)
  }
}

await mkdir(outputRoot, { recursive: true })
await Promise.all([
  cp(join(sourceRoot, 'index.html'), join(outputRoot, 'index.html')),
  cp(join(sourceRoot, 'styles.css'), join(outputRoot, 'styles.css')),
])

console.log(`Built TwinDesk Web shell at ${outputRoot}`)
