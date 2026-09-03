import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { startTwinDeskWebServer } from '../packages/web/dist/server.js'

const PATH = '/api/connectors/feishu/bot/events'
const SIGNATURE_HEADERS = Object.freeze({
  'x-lark-request-timestamp': '1788422400',
  'x-lark-request-nonce': 'synthetic-webhook-nonce',
  'x-lark-signature': 'a'.repeat(64),
})

/** @param {string} url @param {string} body @param {Record<string, string>} [headers] */
function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...SIGNATURE_HEADERS,
      ...headers,
      connection: 'close',
    },
    body,
  })
}

test('Bot callback endpoint preserves signed bytes and emits exact Feishu acknowledgements', async (context) => {
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuBotEvents: {
      async consume(request, signal) {
        signal.throwIfAborted()
        calls += 1
        const input = /** @type {{headers: unknown, rawBody: Uint8Array}} */ (request)
        assert.deepEqual(input.headers, SIGNATURE_HEADERS)
        const parsed = JSON.parse(Buffer.from(input.rawBody).toString('utf8'))
        if (parsed.type === 'url_verification') {
          return { version: 1, disposition: 'challenge', challenge: parsed.challenge }
        }
        return { version: 1, disposition: 'accepted' }
      },
    },
  })
  context.after(() => running.close())

  const eventBody = JSON.stringify({ schema: '2.0', synthetic: true })
  const accepted = await post(`${running.url}${PATH}`, eventBody)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await accepted.json(), {})

  const challenge = await post(
    `${running.url}${PATH}`,
    JSON.stringify({ type: 'url_verification', challenge: 'synthetic-callback-challenge' }),
  )
  assert.equal(challenge.status, 200)
  assert.deepEqual(await challenge.json(), { challenge: 'synthetic-callback-challenge' })
  assert.equal(calls, 2)
  assert.equal((await fetch(`${running.url}${PATH}`)).status, 405)
  assert.equal((await post(`${running.url}${PATH}?debug=true`, eventBody)).status, 400)
  assert.equal(
    (
      await post(`${running.url}${PATH}`, eventBody, {
        'content-type': 'text/plain',
      })
    ).status,
    415,
  )
  assert.equal(calls, 2)
})

test('Bot callback endpoint minimizes rejection, unavailability, and hostile results', async (context) => {
  const privateValue = 'synthetic-private-webhook-value'
  let disposition = 'rejected'
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuBotEvents: {
      async consume() {
        if (disposition === 'hostile') {
          return { version: 1, disposition: 'accepted', privateValue }
        }
        return { version: 1, disposition }
      },
    },
  })
  context.after(() => running.close())
  const body = JSON.stringify({ schema: '2.0' })

  let response = await post(`${running.url}${PATH}`, body)
  assert.equal(response.status, 401)
  assert.equal((await response.text()).includes(privateValue), false)
  disposition = 'unavailable'
  response = await post(`${running.url}${PATH}`, body)
  assert.equal(response.status, 503)
  disposition = 'hostile'
  response = await post(`${running.url}${PATH}`, body)
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes(privateValue), false)

  const unavailable = await startTwinDeskWebServer({ port: 0 })
  context.after(() => unavailable.close())
  assert.equal((await post(`${unavailable.url}${PATH}`, body)).status, 503)
})

test('Web shutdown cancels an active Bot callback before closing storage', async () => {
  /** @type {(() => void) | undefined} */
  let resolveStarted
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => {
    resolveStarted = () => resolve()
  })
  let aborted = false
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuBotEvents: {
      consume(_request, signal) {
        resolveStarted?.()
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    },
  })
  const pending = post(`${running.url}${PATH}`, JSON.stringify({ schema: '2.0' })).catch(
    () => undefined,
  )
  await started
  await running.close()
  await pending
  assert.equal(aborted, true)
})

test('duplicate signature headers fail before invoking Bot callback service', async (context) => {
  let calls = 0
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuBotEvents: {
      async consume() {
        calls += 1
        return { version: 1, disposition: 'accepted' }
      },
    },
  })
  context.after(() => running.close())
  const body = JSON.stringify({ schema: '2.0' })
  const status = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${running.url}${PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-lark-request-timestamp': SIGNATURE_HEADERS['x-lark-request-timestamp'],
          'x-lark-request-nonce': SIGNATURE_HEADERS['x-lark-request-nonce'],
          'x-lark-signature': ['a'.repeat(64), 'b'.repeat(64)],
          connection: 'close',
        },
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      },
    )
    outgoing.once('error', reject)
    outgoing.end(body)
  })
  assert.equal(status, 400)
  assert.equal(calls, 0)
})
