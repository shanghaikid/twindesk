import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { startWorkbenchWebServer } from '../packages/bundle-workbench/dist/index.js'

const commandArguments = process.argv.slice(2)
if (commandArguments[0] === '--') commandArguments.shift()

const { values } = parseArgs({
  args: commandArguments,
  options: {
    database: { type: 'string', default: '.twindesk/twindesk.sqlite3' },
    port: { type: 'string', default: '4173' },
  },
  strict: true,
})
const port = Number(values.port)
const databasePath = resolve(values.database)
await mkdir(dirname(databasePath), { recursive: true })
const running = await startWorkbenchWebServer({ databasePath, port })
console.log(`TwinDesk Web: ${running.url}`)

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await running.close()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error(error)
        process.exit(1)
      },
    )
  })
}
