import process from 'node:process'

import { validateDependencyBoundaries } from './dependency-boundary.mjs'
import { validateWorkspace } from './workspace-contract.mjs'

const errors = [
  ...(await validateWorkspace(process.cwd())),
  ...(await validateDependencyBoundaries(process.cwd())),
]

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exitCode = 1
} else {
  console.log('Repository scaffold contract passed.')
}
