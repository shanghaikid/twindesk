import process from 'node:process'
import { parseArgs } from 'node:util'

import { startTwinDeskWebServer } from './server.ts'

const commandArguments = process.argv.slice(2)
if (commandArguments[0] === '--') commandArguments.shift()

const { values } = parseArgs({
  args: commandArguments,
  options: {
    port: { type: 'string', default: '4173' },
  },
  strict: true,
})
const port = Number(values.port)
const running = await startTwinDeskWebServer({ port })
console.log(`TwinDesk Web: ${running.url}`)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await running.close()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error)
        process.exit(1)
      },
    )
  })
}
