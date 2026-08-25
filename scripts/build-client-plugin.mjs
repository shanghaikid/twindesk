import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

export const CLIENT_PLUGIN_ID = '@twindesk/plugin-ui'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..')
const pluginRoot = join(repositoryRoot, 'packages', 'plugin-ui')
const sourcePath = join(pluginRoot, 'src', 'client', 'index.ts')
const outputPath = join(pluginRoot, 'dist', 'client.js')
const sourceMapPath = `${outputPath}.map`
const buildInstruction = 'run `pnpm run build` before launching the Harness Profile'
const requiredClientEdges = Object.freeze([
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-sidebar',
])

/** @param {string} source */
export function inspectClientBundle(source) {
  const registration = `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_PLUGIN_ID)}`
  if (!source.includes(registration)) {
    throw new Error(
      `TwinDesk Client bundle does not register ${CLIENT_PLUGIN_ID} in the Harness lazy-CJS loader; ${buildInstruction}.`,
    )
  }
  if (!source.includes('factory: (require) => {') || !source.includes('return module.exports;')) {
    throw new Error(
      `TwinDesk Client bundle is missing the Harness lazy-CJS factory boundary; ${buildInstruction}.`,
    )
  }
  if (!source.includes('//# sourceMappingURL=client.js.map')) {
    throw new Error(
      `TwinDesk Client bundle is missing its source-map reference; ${buildInstruction}.`,
    )
  }
  for (const match of source.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)) {
    if (match[2] !== 'react') {
      throw new Error(
        `TwinDesk Client bundle requests unsupported module ${JSON.stringify(match[2])}; only Harness baseline modules may remain external.`,
      )
    }
  }
}

/** @param {string} root */
export async function inspectClientPluginArtifacts(root = pluginRoot) {
  const manifestPath = join(root, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot inspect TwinDesk Client plugin manifest at ${manifestPath}.`, {
      cause: error,
    })
  }
  const relativeBundle = manifest?.exports?.['./client']?.default
  if (typeof relativeBundle !== 'string') {
    throw new Error(
      `TwinDesk Client plugin manifest must export a default ./client bundle; ${buildInstruction}.`,
    )
  }
  if (manifest?.exports?.['./package.json'] !== './package.json') {
    throw new Error(
      'TwinDesk Client plugin must export ./package.json for Harness Client discovery.',
    )
  }
  const clientDeclaration = manifest?.dsh?.client
  if (
    clientDeclaration?.platform !== 'web' ||
    !Array.isArray(clientDeclaration.inject) ||
    !requiredClientEdges.every((edge) => clientDeclaration.inject.includes(edge))
  ) {
    throw new Error(
      'TwinDesk Client plugin manifest must declare the web platform and every required settings, sidebar, and conversation graph edge.',
    )
  }
  const bundlePath = resolve(root, relativeBundle)
  let bundle
  let sourceMap
  try {
    ;[bundle, sourceMap] = await Promise.all([
      readFile(bundlePath, 'utf8'),
      readFile(`${bundlePath}.map`, 'utf8'),
    ])
  } catch (error) {
    throw new Error(
      `TwinDesk Client bundle or source map is missing at ${bundlePath}; ${buildInstruction}.`,
      { cause: error },
    )
  }
  inspectClientBundle(bundle)
  let parsedMap
  try {
    parsedMap = JSON.parse(sourceMap)
  } catch (error) {
    throw new Error(`TwinDesk Client source map at ${bundlePath}.map is not valid JSON.`, {
      cause: error,
    })
  }
  if (
    parsedMap?.file !== 'client.js' ||
    !Array.isArray(parsedMap.sources) ||
    !parsedMap.sources.includes('../src/client/index.ts') ||
    !Array.isArray(parsedMap.sourcesContent) ||
    parsedMap.sourcesContent.length === 0
  ) {
    throw new Error(
      `TwinDesk Client source map at ${bundlePath}.map does not map the production bundle back to its TypeScript source.`,
    )
  }
  return Object.freeze({ bundlePath, bundle, sourceMap: parsedMap })
}

export async function buildClientPlugin() {
  const source = await readFile(sourcePath, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: {
      inlineSources: true,
      module: ts.ModuleKind.CommonJS,
      sourceMap: true,
      target: ts.ScriptTarget.ES2023,
    },
    fileName: 'index.ts',
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    throw new Error(
      `TwinDesk Client transpilation failed:\n${ts.formatDiagnostics(errors, {
        getCanonicalFileName: (filename) => filename,
        getCurrentDirectory: () => repositoryRoot,
        getNewLine: () => '\n',
      })}`,
    )
  }
  if (result.sourceMapText === undefined) {
    throw new Error('TwinDesk Client transpilation did not produce a source map.')
  }

  const compiled = result.outputText.replace(/\n?\/\/# sourceMappingURL=.*\s*$/u, '')
  const bundle = [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_PLUGIN_ID)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    compiled,
    'return module.exports; } });',
    '//# sourceMappingURL=client.js.map',
    '',
  ].join('\n')
  const sourceMap = JSON.parse(result.sourceMapText)
  sourceMap.file = 'client.js'
  sourceMap.sources = ['../src/client/index.ts']
  sourceMap.sourceRoot = ''
  sourceMap.mappings = `;;${String(sourceMap.mappings ?? '')}`

  await mkdir(dirname(outputPath), { recursive: true })
  await Promise.all([
    writeFile(outputPath, bundle),
    writeFile(sourceMapPath, `${JSON.stringify(sourceMap)}\n`),
  ])
  await inspectClientPluginArtifacts()
  console.log(`Built TwinDesk Client plugin at ${outputPath}`)
}

export async function cleanClientPlugin() {
  await Promise.all([rm(outputPath, { force: true }), rm(sourceMapPath, { force: true })])
  console.log('Cleaned TwinDesk Client plugin artifacts.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'clean') await cleanClientPlugin()
  else await buildClientPlugin()
}
