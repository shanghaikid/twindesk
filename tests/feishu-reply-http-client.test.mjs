import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES,
  FeishuReplyExecutionClientError,
  FeishuReplyHttpClient,
} from '../packages/plugin-feishu/dist/index.js'

const TARGET_MESSAGE_ID = 'om_synthetic_reply_target'
const MESSAGE_ID = 'om_synthetic_reply_result'
const PRIVATE_TOKEN = 'u-synthetic-private-reply-token'
const PRIVATE_CONTENT = 'Synthetic approved reply with a quote: "ready".'
const IDEMPOTENCY_KEY = `tdfr1:${'a'.repeat(40)}`
const SENT_MILLISECONDS = 1_787_888_400_000
const REPLY_URL = 'https://open.feishu.cn/open-apis/im/v1/messages/om_synthetic_reply_target/reply'

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {unknown} value */
function json(value) {
  return bytes(JSON.stringify(value))
}

/**
 * @param {BodyInit | null} body
 * @param {{status?: number, headers?: HeadersInit}} [options]
 */
function response(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** @param {Record<string, unknown>} [changes] */
function successBody(changes = {}) {
  return json({
    code: 0,
    msg: 'success',
    data: {
      message_id: MESSAGE_ID,
      create_time: String(SENT_MILLISECONDS),
      chat_id: 'oc_synthetic_chat_not_returned',
      body: { content: PRIVATE_CONTENT },
    },
    ...changes,
  })
}

function request() {
  return {
    targetMessageId: TARGET_MESSAGE_ID,
    content: PRIVATE_CONTENT,
    idempotencyKey: IDEMPOTENCY_KEY,
    accessToken: bytes(PRIVATE_TOKEN),
  }
}

test('reply HTTP client sends one exact fixed-endpoint text request and minimizes the result', async () => {
  const first = successBody().slice(0, 47)
  const second = successBody().slice(47)
  /** @type {{url?: string, init?: RequestInit, body?: Uint8Array}} */
  const captured = {}
  const client = new FeishuReplyHttpClient({
    fetch: async (url, init) => {
      assert.ok(init !== undefined)
      assert.ok(init.body instanceof Uint8Array)
      captured.url = String(url)
      captured.init = init
      captured.body = init.body
      assert.deepEqual(JSON.parse(new TextDecoder().decode(init.body)), {
        content: JSON.stringify({ text: PRIVATE_CONTENT }),
        msg_type: 'text',
        uuid: IDEMPOTENCY_KEY,
      })
      return response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first)
            controller.enqueue(second)
            controller.close()
          },
        }),
      )
    },
  })
  const input = request()
  const result = await client.send(input, new AbortController().signal)

  assert.deepEqual(result, {
    kind: 'feishu_reply_http_result',
    schemaVersion: 1,
    messageId: MESSAGE_ID,
    sentAt: new Date(SENT_MILLISECONDS).toISOString(),
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(captured.url, REPLY_URL)
  assert.equal(captured.init?.method, 'POST')
  assert.equal(captured.init?.cache, 'no-store')
  assert.equal(captured.init?.credentials, 'omit')
  assert.equal(captured.init?.redirect, 'error')
  assert.equal(captured.init?.referrerPolicy, 'no-referrer')
  assert.ok(captured.init?.signal instanceof AbortSignal)
  const headers = new Headers(captured.init?.headers)
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(headers.get('authorization'), `Bearer ${PRIVATE_TOKEN}`)
  assert.equal(new TextDecoder().decode(input.accessToken), PRIVATE_TOKEN)
  assert.equal(
    captured.body?.every((value) => value === 0),
    true,
  )
  assert.equal(
    first.every((value) => value === 0),
    true,
  )
  assert.equal(
    second.every((value) => value === 0),
    true,
  )
  input.accessToken.fill(0)
})

test('reply HTTP client maps explicit HTTP and application failures without payloads', async () => {
  /** @type {Array<[number, Record<string, unknown>, string]>} */
  const cases = [
    [401, { code: 0 }, 'not_authorized'],
    [403, { code: 0 }, 'not_authorized'],
    [429, { code: 0 }, 'rate_limited'],
    [400, { code: 0 }, 'rejected'],
    [404, { code: 0 }, 'rejected'],
    [503, { code: 0 }, 'unknown'],
    [200, { code: 99991400, msg: PRIVATE_CONTENT }, 'rate_limited'],
    [200, { code: 99991663, msg: PRIVATE_TOKEN }, 'not_authorized'],
    [200, { code: 99991672, msg: PRIVATE_TOKEN }, 'scope_missing'],
    [200, { code: 99991676, msg: PRIVATE_TOKEN }, 'scope_missing'],
    [400, { code: 99991679, msg: PRIVATE_TOKEN }, 'scope_missing'],
    [200, { code: 230001, msg: PRIVATE_CONTENT }, 'rejected'],
    [200, { code: 987654321, msg: PRIVATE_CONTENT }, 'unknown'],
  ]
  for (const [status, value, expectedCode] of cases) {
    const input = request()
    await assert.rejects(
      new FeishuReplyHttpClient({
        fetch: async () => response(json(value), { status }),
      }).send(input, new AbortController().signal),
      (error) =>
        error instanceof FeishuReplyExecutionClientError &&
        error.code === expectedCode &&
        !error.message.includes(PRIVATE_TOKEN) &&
        !error.message.includes(PRIVATE_CONTENT),
    )
    assert.equal(new TextDecoder().decode(input.accessToken), PRIVATE_TOKEN)
    input.accessToken.fill(0)
  }
})

test('reply HTTP client clears parsed error bodies and cancels rejected error streams', async () => {
  const scopeBody = json({ code: 99991679, msg: PRIVATE_TOKEN })
  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async () =>
        response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(scopeBody)
              controller.close()
            },
          }),
          { status: 400 },
        ),
    }).send(request(), new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyExecutionClientError &&
      error.code === 'scope_missing' &&
      !error.message.includes(PRIVATE_TOKEN),
  )
  assert.equal(
    scopeBody.every((value) => value === 0),
    true,
  )

  let cancelled = false
  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status: 400, headers: { 'content-type': 'text/plain' } },
        ),
    }).send(request(), new AbortController().signal),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'rejected',
  )
  assert.equal(cancelled, true)
})

test('reply HTTP client treats ambiguous or malformed post-send responses as unknown', async () => {
  const malformed = [
    bytes(''),
    json({ code: 0, msg: 'success' }),
    json({ code: 0, msg: 'success', data: { message_id: MESSAGE_ID, create_time: 'invalid' } }),
    bytes(
      `{"code":0,"msg":"success","data":{"message_id":"first","message_id":"${MESSAGE_ID}","create_time":"${SENT_MILLISECONDS}"}}`,
    ),
    new Uint8Array([0xff, 0xfe, 0xfd]),
    json({
      code: 0,
      msg: 'success',
      data: { message_id: MESSAGE_ID, create_time: String(SENT_MILLISECONDS) },
      leaked: PRIVATE_CONTENT,
    }),
  ]
  for (const body of malformed) {
    await assert.rejects(
      new FeishuReplyHttpClient({
        fetch: async () =>
          response(
            new ReadableStream({
              start(controller) {
                if (body.byteLength > 0) controller.enqueue(body)
                controller.close()
              },
            }),
          ),
      }).send(request(), new AbortController().signal),
      (error) =>
        error instanceof FeishuReplyExecutionClientError &&
        error.code === 'unknown' &&
        !error.message.includes(PRIVATE_CONTENT),
    )
    assert.equal(
      body.every((value) => value === 0),
      true,
    )
  }

  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async () => response(successBody(), { headers: { 'content-type': 'text/plain' } }),
    }).send(request(), new AbortController().signal),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'unknown',
  )
  await assert.rejects(
    new FeishuReplyHttpClient({ fetch: async () => response(successBody(), { status: 302 }) }).send(
      request(),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'unknown',
  )
})

test('reply HTTP client rejects declared and streamed responses over its bound', async () => {
  let cancelled = false
  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES + 1),
              'content-type': 'application/json',
            },
          },
        ),
    }).send(request(), new AbortController().signal),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'unknown',
  )
  assert.equal(cancelled, true)

  const oversized = new Uint8Array(FEISHU_REPLY_HTTP_RESPONSE_MAX_BYTES + 1)
  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async () =>
        response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized)
            },
          }),
        ),
    }).send(request(), new AbortController().signal),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'unknown',
  )
  assert.equal(
    oversized.every((value) => value === 0),
    true,
  )
})

test('reply HTTP client maps network and timeout ambiguity and propagates caller cancellation', async () => {
  /** @type {Uint8Array | undefined} */
  let rejectedBody
  await assert.rejects(
    new FeishuReplyHttpClient({
      fetch: async (_url, init) => {
        assert.ok(init?.body instanceof Uint8Array)
        rejectedBody = init.body
        throw new Error(`${PRIVATE_TOKEN} ${PRIVATE_CONTENT}`)
      },
    }).send(request(), new AbortController().signal),
    (error) =>
      error instanceof FeishuReplyExecutionClientError &&
      error.code === 'network' &&
      !error.message.includes(PRIVATE_TOKEN),
  )
  assert.equal(
    rejectedBody?.every((value) => value === 0),
    true,
  )

  await assert.rejects(
    new FeishuReplyHttpClient({
      timeoutMilliseconds: 5,
      fetch: (_url, init) => {
        assert.ok(init?.signal instanceof AbortSignal)
        const signal = init.signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }).send(request(), new AbortController().signal),
    (error) => error instanceof FeishuReplyExecutionClientError && error.code === 'network',
  )

  const caller = new AbortController()
  const pending = new FeishuReplyHttpClient({
    fetch: (_url, init) => {
      assert.ok(init?.signal instanceof AbortSignal)
      const signal = init.signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }).send(request(), caller.signal)
  caller.abort(new Error('synthetic caller cancellation'))
  await assert.rejects(pending, /synthetic caller cancellation/u)
})

test('reply HTTP client rejects hostile options and requests before Fetch', async () => {
  let reads = 0
  const hostileOptions = {}
  Object.defineProperty(hostileOptions, 'fetch', {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(PRIVATE_TOKEN)
    },
  })
  assert.throws(
    () => new FeishuReplyHttpClient(/** @type {any} */ (hostileOptions)),
    (error) =>
      error instanceof FeishuReplyExecutionClientError && error.code === 'invalid_response',
  )

  let fetchCalls = 0
  /** @type {Record<string, unknown>} */
  const hostileRequest = {}
  Object.defineProperty(hostileRequest, 'content', {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(PRIVATE_CONTENT)
    },
  })
  const invalid = [
    hostileRequest,
    { ...request(), targetMessageId: '../target' },
    { ...request(), content: '   ' },
    { ...request(), content: `bad\u0000content` },
    { ...request(), idempotencyKey: `tdfr1:${'a'.repeat(41)}` },
    { ...request(), accessToken: bytes('token with spaces') },
    { ...request(), accessToken: new Uint8Array(new SharedArrayBuffer(16)) },
  ]
  const client = new FeishuReplyHttpClient({
    fetch: async () => {
      fetchCalls += 1
      return response(successBody())
    },
  })
  for (const input of invalid) {
    await assert.rejects(
      client.send(/** @type {any} */ (input), new AbortController().signal),
      (error) =>
        error instanceof FeishuReplyExecutionClientError &&
        error.code === 'invalid_response' &&
        !error.message.includes(PRIVATE_CONTENT),
    )
  }
  assert.equal(reads, 0)
  assert.equal(fetchCalls, 0)
  assert.throws(() => new FeishuReplyHttpClient({ timeoutMilliseconds: 0 }), {
    name: 'FeishuReplyExecutionClientError',
    code: 'invalid_response',
  })
})
