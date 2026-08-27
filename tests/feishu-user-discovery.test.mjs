import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_USER_MESSAGE_DISCOVERY_VERSION,
  FEISHU_USER_MESSAGE_STREAM,
  FeishuUserDiscoveryError,
  FeishuUserMessageDiscoverer,
  FeishuUserMessageSearchClientError,
} from '../packages/plugin-feishu/dist/index.js'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')
const SEARCH_END = '2026-08-27T07:59:30.000Z'
const INITIAL_START = '2026-08-27T06:59:30.000Z'

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    user: {
      identityType: 'user',
      displayName: 'Synthetic Local User',
      principalId: 'ou_synthetic_user',
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-feishu-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

/** @param {Record<string, any>} [overrides] */
function message(overrides = {}) {
  return {
    messageId: 'om_synthetic_user_message_1',
    chatId: 'oc_synthetic_user_chat',
    chatType: 'group',
    messageType: 'text',
    createTime: String(NOW - 60_000),
    senderPrincipalId: 'ou_synthetic_sender',
    senderName: 'Synthetic Sender',
    chatName: 'Synthetic Project',
    deleted: false,
    updated: false,
    content: { text: 'Synthetic project update' },
    mentions: [],
    ...overrides,
  }
}

/**
 * @param {{
 *   messages?: any[],
 *   unavailableMessageIds?: string[],
 *   hasMore?: boolean,
 *   nextPageToken?: string,
 *   identityType?: string,
 *   accountId?: string,
 *   appId?: string,
 *   tenantKey?: string,
 *   userPrincipalId?: string
 * }} [overrides]
 */
function page(overrides = {}) {
  const hasMore = overrides.hasMore ?? false
  return {
    kind: 'feishu_user_message_search_page',
    schemaVersion: 1,
    identityType: overrides.identityType ?? 'user',
    accountId: overrides.accountId ?? 'feishu-account:synthetic',
    appId: overrides.appId ?? 'cli_synthetic_twindesk',
    tenantKey: overrides.tenantKey ?? 'tenant_synthetic',
    userPrincipalId: overrides.userPrincipalId ?? 'ou_synthetic_user',
    messages: overrides.messages ?? [message()],
    unavailableMessageIds: overrides.unavailableMessageIds ?? [],
    hasMore,
    ...(hasMore ? { nextPageToken: overrides.nextPageToken ?? 'page-token-synthetic-next' } : {}),
  }
}

/**
 * @param {(request: import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchRequest, signal: AbortSignal) => Promise<unknown>} search
 * @param {number} [now]
 */
function discoverer(search, now = NOW) {
  return new FeishuUserMessageDiscoverer(
    configuration(),
    { search },
    {
      tenantKey: 'tenant_synthetic',
      now: () => now,
      initialLookbackMs: 60 * 60 * 1000,
      overlapMs: 5 * 60 * 1000,
      indexingDelayMs: 30 * 1000,
    },
  )
}

/** @param {import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageDiscoveryRequest['cursor']} [cursor] @param {number} [limit] */
function request(cursor, limit = 10) {
  return {
    accountId: 'feishu-account:synthetic',
    stream: 'user_visible_messages',
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  }
}

test('User search is time-bounded, identity-bound, and always reports partial coverage', async () => {
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchRequest[]} */
  const requests = []
  const batch = await discoverer(async (searchRequest, signal) => {
    signal.throwIfAborted()
    requests.push(searchRequest)
    return page()
  }).discover(request(undefined, 10), new AbortController().signal)

  assert.equal(FEISHU_USER_MESSAGE_DISCOVERY_VERSION, 1)
  assert.equal(FEISHU_USER_MESSAGE_STREAM, 'user_visible_messages')
  assert.deepEqual(requests, [
    {
      identityType: 'user',
      accountId: 'feishu-account:synthetic',
      appId: 'cli_synthetic_twindesk',
      tenantKey: 'tenant_synthetic',
      userPrincipalId: 'ou_synthetic_user',
      startTime: INITIAL_START,
      endTime: SEARCH_END,
      pageSize: 10,
    },
  ])
  assert.equal(batch.messages.length, 1)
  assert.equal(batch.messages[0]?.messageId, 'om_synthetic_user_message_1')
  assert.equal(batch.messages[0]?.userPrincipalId, 'ou_synthetic_user')
  assert.equal(Object.isFrozen(batch.messages[0]), true)
  assert.equal(Object.isFrozen(batch.messages[0]?.content), true)
  assert.deepEqual(batch.coverage, {
    status: 'partial',
    basis: 'authorized_user_message_search',
    windowStart: INITIAL_START,
    windowEnd: SEARCH_END,
    limitations: ['api_visibility', 'bounded_time_window', 'indexing_delay'],
  })
  assert.equal(batch.candidateCursor?.committedThrough, SEARCH_END)
  assert.equal(batch.candidateCursor?.stream, 'user_visible_messages')
  assert.equal(batch.hasMore, false)
})

test('pagination resumes the exact window after restart and advances only after the final page', async () => {
  const first = await discoverer(async () =>
    page({
      messages: [message({ messageId: 'om_later', createTime: String(NOW - 10_000) })],
      hasMore: true,
      nextPageToken: 'page-token-synthetic-second',
    }),
  ).discover(request(), new AbortController().signal)
  assert.equal(first.hasMore, true)
  assert.equal(first.candidateCursor?.committedThrough, undefined)
  assert.ok(first.candidateCursor)
  assert.equal(first.coverage.limitations.includes('pagination_in_progress'), true)

  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchRequest[]} */
  const resumedRequests = []
  const second = await discoverer(async (searchRequest) => {
    resumedRequests.push(searchRequest)
    return page({
      messages: [message({ messageId: 'om_earlier', createTime: String(NOW - 20_000) })],
    })
  }).discover(request(first.candidateCursor), new AbortController().signal)

  assert.equal(resumedRequests[0]?.startTime, INITIAL_START)
  assert.equal(resumedRequests[0]?.endTime, SEARCH_END)
  assert.equal(resumedRequests[0]?.pageToken, 'page-token-synthetic-second')
  assert.equal(second.messages[0]?.messageId, 'om_earlier')
  assert.equal(second.candidateCursor?.committedThrough, SEARCH_END)
  assert.equal(second.hasMore, false)
})

test('the next completed window overlaps its watermark without claiming full history', async () => {
  const first = await discoverer(async () => page()).discover(
    request(),
    new AbortController().signal,
  )
  assert.ok(first.candidateCursor)
  const laterNow = NOW + 10 * 60 * 1000
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuUserMessageSearchRequest | undefined} */
  let nextRequest
  const second = await discoverer(async (searchRequest) => {
    nextRequest = searchRequest
    return page({ messages: [] })
  }, laterNow).discover(request(first.candidateCursor), new AbortController().signal)

  assert.equal(nextRequest?.startTime, '2026-08-27T07:54:30.000Z')
  assert.equal(nextRequest?.endTime, '2026-08-27T08:09:30.000Z')
  assert.equal(second.coverage.status, 'partial')
  assert.equal(second.candidateCursor?.committedThrough, '2026-08-27T08:09:30.000Z')
})

test('an expired page token restarts the same window and relies on downstream idempotency', async () => {
  const first = await discoverer(async () =>
    page({ hasMore: true, nextPageToken: 'page-token-expiring' }),
  ).discover(request(), new AbortController().signal)
  assert.ok(first.candidateCursor)

  /** @type {Array<string | undefined>} */
  const tokens = []
  const recovered = await discoverer(async (searchRequest) => {
    tokens.push(searchRequest.pageToken)
    if (searchRequest.pageToken !== undefined) {
      throw new FeishuUserMessageSearchClientError('invalid_page_token')
    }
    return page({ hasMore: true, nextPageToken: 'page-token-recovered' })
  }).discover(request(first.candidateCursor), new AbortController().signal)

  assert.deepEqual(tokens, ['page-token-expiring', undefined])
  assert.equal(recovered.hasMore, true)
  assert.equal(recovered.candidateCursor?.committedThrough, undefined)
})

test('missing message details are explicit and prevent cursor advancement', async () => {
  const batch = await discoverer(async () =>
    page({
      messages: [message()],
      unavailableMessageIds: ['om_synthetic_missing_detail'],
    }),
  ).discover(request(), new AbortController().signal)

  assert.equal(batch.messages.length, 1)
  assert.deepEqual(batch.unavailableMessageIds, ['om_synthetic_missing_detail'])
  assert.equal(batch.candidateCursor, undefined)
  assert.equal(batch.hasMore, true)
  assert.deepEqual(batch.issues, [
    {
      code: 'message_details_unavailable',
      message: 'Some Feishu search results could not be retrieved as messages.',
      retryable: true,
      affectedCount: 1,
    },
  ])
  assert.equal(batch.coverage.limitations.includes('message_details_unavailable'), true)
})

test('identity, pagination, and response-shape mismatches fail without payload disclosure', async () => {
  const privateValue = 'synthetic-private-response-value'
  const cases = [
    page({ identityType: 'bot' }),
    page({ accountId: 'different-account' }),
    page({ tenantKey: 'different-tenant' }),
    { ...page(), nextPageToken: 'unexpected-final-token' },
    page({ messages: [message(), message()] }),
    page({ messages: [message({ content: { privateValue, nested: () => privateValue } })] }),
  ]
  for (const response of cases) {
    await assert.rejects(
      discoverer(async () => response).discover(request(), new AbortController().signal),
      (error) => error instanceof FeishuUserDiscoveryError && !error.message.includes(privateValue),
    )
  }

  let invoked = false
  const hostile = page()
  Object.defineProperty(hostile, 'messages', {
    enumerable: true,
    get() {
      invoked = true
      return privateValue
    },
  })
  await assert.rejects(
    discoverer(async () => hostile).discover(request(), new AbortController().signal),
    (error) => error instanceof FeishuUserDiscoveryError && !error.message.includes(privateValue),
  )
  assert.equal(invoked, false)

  const sparseMessages = new Array(1)
  await assert.rejects(
    discoverer(async () => page({ messages: sparseMessages })).discover(
      request(),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuUserDiscoveryError && error.code === 'invalid_response',
  )

  let arrayAccessorCalls = 0
  const accessorMessages = Object.defineProperty(/** @type {any[]} */ ([]), '0', {
    enumerable: true,
    get() {
      arrayAccessorCalls += 1
      return message({ content: { privateValue } })
    },
  })
  Object.defineProperty(accessorMessages, 'length', { value: 1 })
  await assert.rejects(
    discoverer(async () => page({ messages: accessorMessages })).discover(
      request(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof FeishuUserDiscoveryError &&
      error.code === 'invalid_response' &&
      !error.message.includes(privateValue),
  )
  assert.equal(arrayAccessorCalls, 0)
})

test('cursor identity conflicts and malformed cursors fail before calling Feishu', async () => {
  const first = await discoverer(async () => page()).discover(
    request(),
    new AbortController().signal,
  )
  assert.ok(first.candidateCursor)
  let calls = 0
  const active = discoverer(async () => {
    calls += 1
    return page()
  })
  await assert.rejects(
    active.discover(
      request({ ...first.candidateCursor, accountId: 'different-account' }),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuUserDiscoveryError && error.code === 'identity_mismatch',
  )
  await assert.rejects(
    active.discover(
      request({ ...first.candidateCursor, position: 'not-a-supported-position' }),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuUserDiscoveryError && error.code === 'invalid_cursor',
  )
  assert.equal(calls, 0)
})

test('cancellation and adapter failures retain typed, payload-free errors', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(discoverer(async () => page()).discover(request(), cancelled.signal), {
    name: 'AbortError',
  })

  const secret = 'synthetic-client-error-secret'
  await assert.rejects(
    discoverer(async () => {
      throw new Error(secret)
    }).discover(request(), new AbortController().signal),
    (error) =>
      error instanceof FeishuUserDiscoveryError &&
      error.code === 'client_failure' &&
      error.retryable &&
      !error.message.includes(secret),
  )
  await assert.rejects(
    discoverer(async () => {
      throw new FeishuUserMessageSearchClientError('scope_missing')
    }).discover(request(), new AbortController().signal),
    (error) =>
      error instanceof FeishuUserDiscoveryError &&
      error.code === 'scope_missing' &&
      !error.retryable,
  )
})

test('a caught-up cursor performs no request until the indexing boundary advances', async () => {
  const first = await discoverer(async () => page({ messages: [] })).discover(
    request(),
    new AbortController().signal,
  )
  assert.ok(first.candidateCursor)
  let calls = 0
  const idle = await discoverer(async () => {
    calls += 1
    return page()
  }).discover(request(first.candidateCursor), new AbortController().signal)
  assert.equal(calls, 0)
  assert.equal(idle.messages.length, 0)
  assert.equal(idle.candidateCursor, undefined)
  assert.equal(idle.coverage.windowStart, SEARCH_END)
  assert.equal(idle.coverage.windowEnd, SEARCH_END)
})

test('a cursor newer than the local clock fails before calling Feishu', async () => {
  const first = await discoverer(async () => page({ messages: [] })).discover(
    request(),
    new AbortController().signal,
  )
  assert.ok(first.candidateCursor)
  let calls = 0
  await assert.rejects(
    discoverer(async () => {
      calls += 1
      return page()
    }, NOW - 1).discover(request(first.candidateCursor), new AbortController().signal),
    (error) => error instanceof FeishuUserDiscoveryError && error.code === 'invalid_cursor',
  )
  assert.equal(calls, 0)
})
