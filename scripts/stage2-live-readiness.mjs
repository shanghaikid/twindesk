import process from 'node:process'
import { parseArgs } from 'node:util'

import { inspectWorkbenchStage2LiveReadiness } from '../packages/bundle-workbench/dist/index.js'

const commandArguments = process.argv.slice(2)
if (commandArguments[0] === '--') commandArguments.shift()

try {
  const { values } = parseArgs({
    args: commandArguments,
    options: {
      url: { type: 'string' },
      timeout: { type: 'string', default: '10000' },
    },
    strict: true,
  })
  if (values.url === undefined) throw new TypeError()
  const timeoutMs = Number(values.timeout)
  const report = await inspectWorkbenchStage2LiveReadiness(
    values.url,
    new AbortController().signal,
    { timeoutMs },
  )
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'ready_for_live_steps') process.exitCode = 2
} catch {
  console.error('TwinDesk Stage 2 live-readiness check failed.')
  process.exitCode = 1
}
