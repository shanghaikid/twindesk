import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_USER_MESSAGE_SEARCH_HTTP_RESPONSE_MAX_BYTES,
  FEISHU_USER_MESSAGE_SEARCH_URL,
  FeishuUserMessageSearchClientError,
  FeishuUserMessageSearchHttpClient,
} from '../packages/plugin-feishu/dist/index.js'

const PRIVATE_TOKEN = 'u-synthetic-private-search-token'
const PRIVATE_TEXT = 'Synthetic private project update'
const START_TIME = '2026-09-02T01:02:03.400Z'
const END_TIME = '2026-09-02T02:03:04.500Z'
const CREATE_MILLISECONDS = Date.parse('2026-09-02T01:30:00.000Z')
const UPDATE_MILLISECONDS = Date.parse('2026-09-02T01:31:00.000Z')
const MESSAGE_ID = 'om_synthetic_search_message'
const CHAT_ID = 'oc_synthetic_search_chat'

/** @param {string} value */
function bytes(value) {
  return new TextEncoder().encode(value)
}

/** @param {unknown} value */
function json(value) {
  return bytes(JSON.stringify(value))
}

/** @param {unknown} value @param {number} [status] */
function response(value, status = 200) {
  return new Response(json(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** @param {Record<string, unknown>} [changes] @returns {any} */
function request(changes = {}) {
  return {
    identityType: 'user',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    tenantKey: 'tenant_synthetic',
    userPrincipalId: 'ou_synthetic_user',
    startTime: START_TIME,
    endTime: END_TIME,
    pageSize: 10,
    accessToken: bytes(PRIVATE_TOKEN),
    ...changes,
  }
}

/** @param {Record<string, unknown>} [changes] @returns {any} */
function searchResponse(changes = {}) {
  return {
    code: 0,
    msg: 'success',
    data: {
      items: [
        {
          id: 'search_result_synthetic',
          meta_data: {
            message_id: MESSAGE_ID,
            type: 'text',
            create_time: String(CREATE_MILLISECONDS),
            update_time: String(UPDATE_MILLISECONDS),
            chat_id: CHAT_ID,
            from_id: 'ou_synthetic_sender',
            thread_id: 'omt_synthetic_thread',
            is_p2p_chat: false,
          },
        },
      ],
      has_more: false,
      ...changes,
    },
  }
}

/** @param {Record<string, unknown>} [changes] @returns {any} */
function detailResponse(changes = {}) {
  return {
    code: 0,
    msg: 'success',
    data: {
      items: [
        {
          message_id: MESSAGE_ID,
          thread_id: 'omt_synthetic_thread',
          msg_type: 'text',
          create_time: String(CREATE_MILLISECONDS),
          update_time: String(UPDATE_MILLISECONDS),
          deleted: false,
          updated: true,
          chat_id: CHAT_ID,
          sender: {
            id: 'ou_synthetic_sender',
            id_type: 'open_id',
            sender_type: 'user',
            sender_name: 'Synthetic Sender',
          },
          body: { content: JSON.stringify({ text: PRIVATE_TEXT }) },
          mentions: [
            {
              key: '@_user_1',
              id: 'ou_synthetic_mentioned',
              id_type: 'open_id',
              name: 'Synthetic Mention',
            },
          ],
          ...changes,
        },
      ],
    },
  }
}

test('User message HTTP client performs bounded time search then exact detail reads', async () => {
  /** @type {Array<{url: string, init: RequestInit, body?: BodyInit}>} */
  const calls = []
  const input = request()
  const client = new FeishuUserMessageSearchHttpClient({
    fetch: async (url, init) => {
      assert.ok(init !== undefined)
      const captured = {
        url: String(url),
        init,
        ...(init.body instanceof Uint8Array ? { body: init.body.slice() } : {}),
      }
      calls.push(captured)
      return calls.length === 1 ? response(searchResponse()) : response(detailResponse())
    },
  })

  /** @type {any} */
  const result = await client.search(input, new AbortController().signal)

  assert.equal(calls.length, 2)
  const searchCall = calls[0]
  const detailCall = calls[1]
  assert.ok(searchCall)
  assert.ok(detailCall)
  const searchUrl = new URL(searchCall.url)
  assert.equal(`${searchUrl.origin}${searchUrl.pathname}`, FEISHU_USER_MESSAGE_SEARCH_URL)
  assert.equal(searchUrl.searchParams.get('page_size'), '10')
  assert.equal(searchUrl.searchParams.get('user_id_type'), 'open_id')
  assert.equal(searchCall.init.method, 'POST')
  assert.ok(searchCall.body instanceof Uint8Array)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(searchCall.body)), {
    filter: {
      time_range: {
        start_time: String(Math.floor(Date.parse(START_TIME) / 1000)),
        end_time: String(Math.ceil(Date.parse(END_TIME) / 1000)),
      },
    },
  })
  assert.match(detailCall.url, new RegExp(`/im/v1/messages/${MESSAGE_ID}\\?`))
  assert.equal(new URL(detailCall.url).searchParams.get('with_sender_name'), 'true')
  for (const call of calls) {
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.credentials, 'omit')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.referrerPolicy, 'no-referrer')
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${PRIVATE_TOKEN}`)
  }
  assert.deepEqual(result, {
    kind: 'feishu_user_message_search_page',
    schemaVersion: 1,
    identityType: 'user',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    tenantKey: 'tenant_synthetic',
    userPrincipalId: 'ou_synthetic_user',
    messages: [
      {
        messageId: MESSAGE_ID,
        chatId: CHAT_ID,
        chatType: 'group',
        messageType: 'text',
        createTime: String(CREATE_MILLISECONDS),
        updatedTime: String(UPDATE_MILLISECONDS),
        senderPrincipalId: 'ou_synthetic_sender',
        senderName: 'Synthetic Sender',
        threadId: 'omt_synthetic_thread',
        deleted: false,
        updated: true,
        content: { text: PRIVATE_TEXT },
        mentions: [{ key: '@_user_1', principalId: 'ou_synthetic_mentioned' }],
      },
    ],
    unavailableMessageIds: [],
    hasMore: false,
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.messages), true)
  assert.equal(new TextDecoder().decode(input.accessToken), PRIVATE_TOKEN)
  input.accessToken.fill(0)
})

test('unavailable details stay explicit and preserve search pagination', async () => {
  let calls = 0
  const input = request({ pageToken: 'synthetic-next-page' })
  /** @type {any} */
  const result = await new FeishuUserMessageSearchHttpClient({
    fetch: async () => {
      calls += 1
      return calls === 1
        ? response(searchResponse({ has_more: true, page_token: 'synthetic-following-page' }))
        : response({ code: 230001, msg: PRIVATE_TEXT }, 404)
    },
  }).search(input, new AbortController().signal)

  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.unavailableMessageIds, [MESSAGE_ID])
  assert.equal(result.hasMore, true)
  assert.equal(result.nextPageToken, 'synthetic-following-page')
  input.accessToken.fill(0)
})

test('rounded API bounds do not leak results outside the exact discovery window', async () => {
  const search = searchResponse()
  search.data.items[0].meta_data.create_time = String(Date.parse(START_TIME) - 200)
  let calls = 0
  const input = request()
  /** @type {any} */
  const result = await new FeishuUserMessageSearchHttpClient({
    fetch: async () => {
      calls += 1
      return response(search)
    },
  }).search(input, new AbortController().signal)

  assert.equal(calls, 1)
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.unavailableMessageIds, [])
  input.accessToken.fill(0)
})

test('missing indexed chat type is resolved from exact chat metadata without guessing', async () => {
  const search = searchResponse()
  delete search.data.items[0].meta_data.is_p2p_chat
  let calls = 0
  /** @type {string[]} */
  const urls = []
  const input = request()
  /** @type {any} */
  const result = await new FeishuUserMessageSearchHttpClient({
    fetch: async (url) => {
      calls += 1
      urls.push(String(url))
      if (calls === 1) return response(search)
      if (calls === 2) return response(detailResponse())
      return response({
        code: 0,
        msg: 'success',
        data: { chat_mode: 'topic', name: 'Synthetic Topic' },
      })
    },
  }).search(input, new AbortController().signal)

  assert.equal(calls, 3)
  const chatRequestUrl = urls[2]
  assert.ok(chatRequestUrl)
  assert.match(chatRequestUrl, new RegExp(`/im/v1/chats/${CHAT_ID}\\?`))
  assert.equal(result.messages[0].chatType, 'group')
  assert.equal(result.messages[0].chatName, 'Synthetic Topic')
  input.accessToken.fill(0)
})

test('search errors are typed, payload-free, and page-token failures are replayable', async () => {
  /** @type {Array<[number, unknown, string, Record<string, unknown>?]>} */
  const cases = [
    [401, { code: 99991663, msg: PRIVATE_TOKEN }, 'not_authorized'],
    [400, { code: 99991679, msg: PRIVATE_TOKEN }, 'scope_missing'],
    [429, { code: 99991400, msg: PRIVATE_TOKEN }, 'rate_limited'],
    [400, { code: 230099, msg: PRIVATE_TEXT }, 'invalid_page_token', { pageToken: 'expired' }],
  ]
  for (const [status, value, expectedCode, changes = {}] of cases) {
    const input = request(changes)
    await assert.rejects(
      new FeishuUserMessageSearchHttpClient({
        fetch: async () => response(value, status),
      }).search(input, new AbortController().signal),
      (error) =>
        error instanceof FeishuUserMessageSearchClientError &&
        error.code === expectedCode &&
        !error.message.includes(PRIVATE_TOKEN) &&
        !error.message.includes(PRIVATE_TEXT),
    )
    input.accessToken.fill(0)
  }

  const input = request()
  await assert.rejects(
    new FeishuUserMessageSearchHttpClient({
      fetch: async () => {
        throw new Error(PRIVATE_TOKEN)
      },
    }).search(input, new AbortController().signal),
    (error) =>
      error instanceof FeishuUserMessageSearchClientError &&
      error.code === 'network' &&
      !error.message.includes(PRIVATE_TOKEN),
  )
  input.accessToken.fill(0)
})

test('malformed search/detail responses fail closed instead of changing identity or content', async () => {
  const malformedSearch = searchResponse()
  malformedSearch.data.items[0].meta_data.message_id = '../different-message'
  const input = request()
  await assert.rejects(
    new FeishuUserMessageSearchHttpClient({
      fetch: async () => response(malformedSearch),
    }).search(input, new AbortController().signal),
    (error) =>
      error instanceof FeishuUserMessageSearchClientError && error.code === 'invalid_response',
  )
  input.accessToken.fill(0)

  let calls = 0
  const detailInput = request()
  await assert.rejects(
    new FeishuUserMessageSearchHttpClient({
      fetch: async () => {
        calls += 1
        return calls === 1
          ? response(searchResponse())
          : response(detailResponse({ chat_id: 'oc_wrong_chat' }))
      },
    }).search(detailInput, new AbortController().signal),
    (error) =>
      error instanceof FeishuUserMessageSearchClientError && error.code === 'invalid_response',
  )
  detailInput.accessToken.fill(0)
})

test('response bounds and timeout cancellation fail without returning remote payloads', async () => {
  const oversized = request()
  await assert.rejects(
    new FeishuUserMessageSearchHttpClient({
      fetch: async () =>
        new Response(json({ code: 0, data: {} }), {
          headers: {
            'content-type': 'application/json',
            'content-length': String(FEISHU_USER_MESSAGE_SEARCH_HTTP_RESPONSE_MAX_BYTES + 1),
          },
        }),
    }).search(oversized, new AbortController().signal),
    (error) =>
      error instanceof FeishuUserMessageSearchClientError && error.code === 'invalid_response',
  )
  oversized.accessToken.fill(0)

  let cancelled = false
  const timed = request()
  await assert.rejects(
    new FeishuUserMessageSearchHttpClient({
      timeoutMilliseconds: 10,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }).search(timed, new AbortController().signal),
    (error) => error instanceof FeishuUserMessageSearchClientError && error.code === 'network',
  )
  assert.equal(cancelled, true)
  timed.accessToken.fill(0)
})

test('borrowed token validation and internal cleanup do not invoke overridden iteration or fill', async () => {
  const token = bytes(PRIVATE_TOKEN)
  Object.defineProperty(token, Symbol.iterator, {
    value() {
      throw new Error('iterator must not run')
    },
  })
  Object.defineProperty(token, 'fill', {
    value() {
      throw new Error('fill must not run')
    },
  })
  const input = request({ accessToken: token })
  /** @type {any} */
  const result = await new FeishuUserMessageSearchHttpClient({
    fetch: async () => response(searchResponse({ items: [] })),
  }).search(input, new AbortController().signal)

  assert.deepEqual(result.messages, [])
  assert.equal(new TextDecoder().decode(token), PRIVATE_TOKEN)
  Uint8Array.prototype.fill.call(token, 0)
})
