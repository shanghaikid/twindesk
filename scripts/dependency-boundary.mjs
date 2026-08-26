import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import ts from 'typescript'

const adapterDirectory = 'harness-adapter'
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
const expectedAdapterDependencies = new Map([
  ['@deepseek-ai/cordis', '4.0.1'],
  ['@deepseek-ai/cordis-plugin-include', '1.0.6'],
  ['@deepseek-ai/cordis-plugin-loader', '1.0.2'],
  ['@deepseek-ai/dsh-agent', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-agent-loop', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-agent-presets', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-app-boot', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-client-ui-slots', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-llm', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-session', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-session-persistence', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-settings', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-settings-file', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-scope', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-skill', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-system-prompt', '0.1.1-rc.2'],
  ['@deepseek-ai/dsh-tools', '0.1.1-rc.2'],
  ['@deepseek-ai/schemastery', '3.18.1'],
])
const sourceExtensions = new Set(['.cts', '.js', '.mjs', '.mts', '.ts', '.tsx'])

/**
 * Dependencies that would couple the pure domain package to infrastructure,
 * connector, UI, or model SDK concerns.
 *
 * @param {string} specifier
 */
function isDomainForbidden(specifier) {
  return (
    specifier.startsWith('@deepseek-ai/') ||
    /^@twindesk\/(?:bundle-workbench|harness-adapter|plugin-|storage-sqlite)/u.test(specifier) ||
    /^@larksuiteoapi\//u.test(specifier) ||
    /^@atlaskit\//u.test(specifier) ||
    /^@anthropic-ai\//u.test(specifier) ||
    /^@ai-sdk\//u.test(specifier) ||
    /^@google\/(?:genai|generative-ai)$/u.test(specifier) ||
    /^(?:jira-client|jira\.js|openai|react|react-dom|svelte|vue)(?:$|\/)/u.test(specifier)
  )
}

/** @param {string} filename */
function isSourceFile(filename) {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 && sourceExtensions.has(filename.slice(dot))
}

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function listSourceFiles(directory) {
  /** @type {string[]} */
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)))
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(path)
    }
  }

  return files
}

/**
 * @param {string} source
 * @param {string} filename
 * @returns {string[]}
 */
function referencedSpecifiers(source, filename) {
  const preprocessed = ts.preProcessFile(source, true, true)
  const specifiers = new Set([
    ...preprocessed.importedFiles.map(({ fileName }) => fileName),
    ...preprocessed.typeReferenceDirectives.map(({ fileName }) => fileName),
  ])
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)

  /** @param {import('typescript').Node} node */
  function visit(node) {
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      specifiers.add(argument.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...specifiers]
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function validateDependencyBoundaries(root) {
  /** @type {string[]} */
  const errors = []
  const packagesRoot = join(root, 'packages')
  let packageEntries

  try {
    packageEntries = await readdir(packagesRoot, { withFileTypes: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [`Cannot inspect ${relative(root, packagesRoot)}: ${message}`]
  }

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue

    const packageDirectory = entry.name
    const packageRoot = join(packagesRoot, packageDirectory)
    const manifestPath = join(packageRoot, 'package.json')
    let manifest

    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Cannot inspect ${relative(root, manifestPath)}: ${message}`)
      continue
    }

    if (!isRecord(manifest)) {
      errors.push(`${relative(root, manifestPath)} must contain a JSON object`)
      continue
    }

    for (const field of dependencyFields) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      if (!isRecord(dependencies)) {
        errors.push(`${relative(root, manifestPath)}#${field} must be an object`)
        continue
      }

      for (const [specifier, version] of Object.entries(dependencies)) {
        if (packageDirectory === 'domain' && isDomainForbidden(specifier)) {
          errors.push(`@twindesk/domain must not declare ${specifier} in ${field}`)
        }

        if (packageDirectory === adapterDirectory && specifier.startsWith('@deepseek-ai/')) {
          const expected = expectedAdapterDependencies.get(specifier)
          if (expected === undefined) {
            errors.push(
              `@twindesk/harness-adapter has an undeclared upstream boundary: ${specifier}`,
            )
          } else if (version !== expected) {
            errors.push(
              `@twindesk/harness-adapter must pin ${specifier}@${expected}, received ${String(version)}`,
            )
          }
        }
      }
    }

    if (packageDirectory === adapterDirectory) {
      const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
      for (const [specifier, version] of expectedAdapterDependencies) {
        if (dependencies[specifier] !== version) {
          errors.push(`@twindesk/harness-adapter must depend on ${specifier}@${version}`)
        }
      }
    }

    const sourceRoot = join(packageRoot, 'src')
    let sourceFiles
    try {
      sourceFiles = await listSourceFiles(sourceRoot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Cannot inspect ${relative(root, sourceRoot)}: ${message}`)
      continue
    }

    for (const sourceFile of sourceFiles) {
      let source
      try {
        source = await readFile(sourceFile, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`Cannot inspect ${relative(root, sourceFile)}: ${message}`)
        continue
      }

      for (const specifier of referencedSpecifiers(source, sourceFile)) {
        if (packageDirectory !== adapterDirectory && specifier.startsWith('@deepseek-ai/')) {
          errors.push(
            `${relative(root, sourceFile)} must import ${specifier} through @twindesk/harness-adapter`,
          )
        } else if (packageDirectory === 'domain' && isDomainForbidden(specifier)) {
          errors.push(`@twindesk/domain source must not import ${specifier}`)
        }
      }
    }
  }

  return errors
}
