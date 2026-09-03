import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const commandPath = resolve(repositoryRoot, 'scripts/stage2-live-readiness.mjs')
const MAX_OUTPUT_BYTES = 128 * 1024

/**
 * @param {string[]} arguments_
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string}>}
 */
function runCommand(arguments_) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(process.execPath, [commandPath, ...arguments_], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    /** @param {string} channel @param {string | Buffer} chunk */
    const append = (channel, chunk) => {
      const next = channel + chunk
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill()
        rejectCommand(new Error('Stage 2 readiness command output exceeded the test bound.'))
        return channel
      }
      return next
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', rejectCommand)
    child.once('close', (code, signal) => resolveCommand({ code, signal, stdout, stderr }))
  })
}

test('Stage 2 readiness command rejects a non-loopback origin with fixed output', async () => {
  const result = await runCommand(['--url', 'https://example.com:443'])

  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'TwinDesk Stage 2 live-readiness check failed.\n')
})

test('Stage 2 readiness command exits 2 with a bounded attention report', async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '0',
    })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')

  const result = await runCommand(['--url', `http://127.0.0.1:${address.port}`])

  assert.equal(result.code, 2)
  assert.equal(result.signal, null)
  assert.equal(result.stderr, '')
  assert.ok(Buffer.byteLength(result.stdout) < MAX_OUTPUT_BYTES)
  /** @type {unknown} */
  const report = JSON.parse(result.stdout)
  assert.ok(typeof report === 'object' && report !== null)
  assert.ok('version' in report)
  assert.ok('status' in report)
  assert.ok('checks' in report && Array.isArray(report.checks))
  assert.equal(report.version, 1)
  assert.equal(report.status, 'attention_required')
  assert.equal(report.checks.length, 5)
  assert.equal(
    report.checks.every(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        'status' in check &&
        check.status === 'attention_required',
    ),
    true,
  )
})
