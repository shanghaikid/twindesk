import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_CONTEXT_RETRIEVAL_VERSION,
  FeishuContextClientError,
  FeishuContextError,
  FeishuContextRetriever,
} from '../packages/plugin-feishu/dist/index.js'

const OBSERVED_AT = '2026-08-27T09:00:00.000Z'
const SOURCE_TIME = '2026-08-27T08:55:00.000Z'

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

function reference(overrides = {}) {
  return {
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic',
    objectType: 'message',
    externalId: 'om_synthetic_anchor',
    sourceTimestamp: SOURCE_TIME,
    ...overrides,
  }
}

function contextRequest(overrides = {}) {
  return {
    reference: reference(),
    purpose: 'Draft a synthetic reply with cited context',
    maxItems: 10,
    before: OBSERVED_AT,
    ...overrides,
  }
}

function conversationItem(overrides = {}) {
  return {
    source: reference(),
    title: 'Synthetic conversation message',
    content: {
      kind: 'feishu_conversation_message_context',
      messageType: 'text',
      text: 'Synthetic bounded conversation context',
      deleted: false,
      edited: false,
      relation: 'anchor',
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

function documentItem(overrides = {}) {
  return {
    source: reference({
      objectType: 'document',
      externalId: 'docx_synthetic_context',
    }),
    title: 'Synthetic referenced document',
    content: {
      kind: 'feishu_document_excerpt_context',
      format: 'plain_text',
      scope: 'referenced_excerpt',
      revisionId: 'revision-synthetic-7',
      text: 'Synthetic bounded document excerpt\nwith a second line.',
      truncated: false,
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

function attachmentItem(overrides = {}) {
  return {
    source: reference({
      objectType: 'attachment',
      externalId: 'file_synthetic_context',
    }),
    title: 'Synthetic attachment',
    content: {
      kind: 'feishu_attachment_context',
      name: 'synthetic-notes.txt',
      mediaType: 'text/plain',
      sizeBytes: 128,
      body: {
        status: 'excerpt',
        text: 'Synthetic bounded attachment excerpt',
        bytesRead: 128,
        truncated: false,
      },
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

function response(overrides = {}) {
  return {
    kind: 'feishu_context_read_result',
    schemaVersion: 1,
    identityType: 'user',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    tenantKey: 'tenant_synthetic',
    userPrincipalId: 'ou_synthetic_user',
    reference: reference(),
    status: 'complete',
    items: [conversationItem(), documentItem(), attachmentItem()],
    hasMoreConversation: false,
    problems: [],
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

/**
 * @param {(request: import('../packages/plugin-feishu/dist/index.js').FeishuContextReadRequest, signal: AbortSignal) => Promise<unknown>} read
 * @param {Record<string, unknown>} [options]
 */
function retriever(read, options = {}) {
  return new FeishuContextRetriever(
    configuration(),
    { read },
    {
      tenantKey: 'tenant_synthetic',
      ...options,
    },
  )
}

test('context retrieval is User-bound, bounded, read-only, and complete when every source is available', async () => {
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuContextReadRequest | undefined} */
  let clientRequest
  const result = await retriever(async (request, signal) => {
    signal.throwIfAborted()
    clientRequest = request
    return response()
  }).getContext(contextRequest(), new AbortController().signal)

  assert.equal(FEISHU_CONTEXT_RETRIEVAL_VERSION, 1)
  assert.deepEqual(clientRequest, {
    identityType: 'user',
    accountId: 'feishu-account:synthetic',
    appId: 'cli_synthetic_twindesk',
    tenantKey: 'tenant_synthetic',
    userPrincipalId: 'ou_synthetic_user',
    reference: reference(),
    purpose: 'Draft a synthetic reply with cited context',
    maxItems: 10,
    before: OBSERVED_AT,
    conversation: {
      order: 'desc',
      includeReactions: false,
      pageSize: 10,
    },
    documents: {
      detail: 'simple',
      scope: 'referenced_excerpt',
      maxCharacters: 20_000,
    },
    attachments: {
      mode: 'text_excerpt_or_metadata',
      downloadBinary: false,
      maxBytes: 256 * 1024,
      maxTextCharacters: 8_000,
    },
  })
  assert.deepEqual(result.availability, { status: 'complete' })
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0]?.source.objectType, 'message')
  assert.equal(result.items[1]?.source.objectType, 'document')
  assert.equal(result.items[2]?.source.objectType, 'attachment')
  assert.equal(result.issues.length, 0)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.items), true)
  assert.equal(Object.isFrozen(result.items[2]?.content), true)
})

test('bounded conversation, document, and attachment gaps become explicit partial context', async () => {
  const result = await retriever(async () =>
    response({
      status: 'partial',
      hasMoreConversation: true,
      items: [
        conversationItem(),
        documentItem({ content: { ...documentItem().content, truncated: true } }),
        attachmentItem({
          content: {
            ...attachmentItem().content,
            body: { status: 'metadata_only', reason: 'binary' },
          },
        }),
      ],
      problems: [{ code: 'document_network', affectedCount: 1 }],
    }),
  ).getContext(contextRequest(), new AbortController().signal)

  assert.deepEqual(result.availability, {
    status: 'partial',
    missing: [
      'conversation history beyond the requested bound',
      'document content beyond the excerpt bound',
      'attachment body unavailable',
      'document context network failure',
    ],
  })
  assert.deepEqual(result.issues, [
    {
      code: 'document_network',
      message: 'Some Feishu document context failed over the network.',
      retryable: true,
    },
  ])
  assert.equal(result.items.length, 3)
})

test('an authorized empty failure is unavailable rather than an empty success', async () => {
  const result = await retriever(async () =>
    response({
      status: 'unavailable',
      items: [],
      problems: [{ code: 'attachment_not_authorized', affectedCount: 1 }],
    }),
  ).getContext(contextRequest(), new AbortController().signal)

  assert.deepEqual(result.availability, {
    status: 'unavailable',
    reason: 'Feishu context is unavailable for the authorized User identity.',
    retryable: false,
  })
  assert.deepEqual(result.issues, [
    {
      code: 'attachment_not_authorized',
      message: 'Some Feishu attachment context is not authorized.',
      retryable: false,
    },
  ])

  const retryable = await retriever(async () =>
    response({
      status: 'unavailable',
      items: [],
      problems: [{ code: 'conversation_network', affectedCount: 1 }],
    }),
  ).getContext(contextRequest(), new AbortController().signal)
  assert.equal(retryable.availability.status, 'unavailable')
  assert.equal(retryable.availability.retryable, true)
})

test('message, thread, document, and attachment anchors remain exact', async () => {
  const directDocument = reference({
    objectType: 'document',
    externalId: 'docx_synthetic_context',
  })
  const directAttachment = reference({
    objectType: 'attachment',
    externalId: 'file_synthetic_context',
  })
  const directThread = reference({
    objectType: 'thread',
    externalId: 'omt_synthetic_thread',
  })
  const cases = [
    { anchor: reference(), items: [conversationItem()] },
    {
      anchor: directThread,
      items: [
        conversationItem({
          content: {
            ...conversationItem().content,
            relation: 'reply',
            threadId: directThread.externalId,
          },
        }),
      ],
    },
    { anchor: directDocument, items: [documentItem()] },
    { anchor: directAttachment, items: [attachmentItem()] },
  ]
  for (const fixture of cases) {
    const result = await retriever(async () =>
      response({ reference: fixture.anchor, items: fixture.items }),
    ).getContext(contextRequest({ reference: fixture.anchor }), new AbortController().signal)
    assert.deepEqual(result.availability, { status: 'complete' })
  }
})

test('request and response identity mismatches fail closed', async () => {
  let calls = 0
  const active = retriever(async () => {
    calls += 1
    return response()
  })
  await assert.rejects(
    active.getContext(
      contextRequest({ reference: reference({ accountId: 'different-account' }) }),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuContextError && error.code === 'identity_mismatch',
  )
  assert.equal(calls, 0)

  for (const mismatch of [
    response({ identityType: 'bot' }),
    response({ tenantKey: 'different-tenant' }),
    response({ reference: reference({ externalId: 'om_different_anchor' }) }),
    response({ items: [conversationItem({ source: reference({ externalId: 'om_unrelated' }) })] }),
  ]) {
    await assert.rejects(
      retriever(async () => mismatch).getContext(contextRequest(), new AbortController().signal),
      (error) => error instanceof FeishuContextError && error.code === 'identity_mismatch',
    )
  }
})

test('bounds, duplicate sources, binary payload fields, and inconsistent states are rejected', async () => {
  const cases = [
    response({ items: [conversationItem(), conversationItem()] }),
    response({ status: 'partial' }),
    response({ items: [] }),
    response({
      items: [
        conversationItem({
          source: reference({ sourceTimestamp: '2026-08-27T09:00:01.000Z' }),
        }),
      ],
    }),
    response({
      items: [
        attachmentItem({
          content: {
            ...attachmentItem().content,
            body: {
              ...attachmentItem().content.body,
              bytes: 'synthetic-binary-must-not-cross-the-boundary',
            },
          },
        }),
      ],
    }),
    response({
      items: [
        conversationItem(),
        attachmentItem({
          content: {
            ...attachmentItem().content,
            mediaType: 'image/png',
          },
        }),
      ],
    }),
    response({
      items: [
        conversationItem({
          content: { ...conversationItem().content, relation: 'reply' },
        }),
      ],
    }),
    response({
      status: 'partial',
      items: [conversationItem()],
      problems: [{ code: 'document_network', affectedCount: 10 }],
    }),
    response({
      items: [
        documentItem({
          content: { ...documentItem().content, text: 'x'.repeat(20_001) },
        }),
      ],
    }),
  ]
  for (const invalid of cases) {
    await assert.rejects(
      retriever(async () => invalid).getContext(contextRequest(), new AbortController().signal),
      (error) => error instanceof FeishuContextError && error.code === 'invalid_response',
    )
  }

  await assert.rejects(
    retriever(async () => response()).getContext(
      contextRequest({ maxItems: 2 }),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuContextError && error.code === 'invalid_response',
  )
})

test('sparse and accessor-backed client arrays fail without evaluating private values', async () => {
  const privateValue = 'synthetic-private-context-value'
  const sparseItems = new Array(1)
  await assert.rejects(
    retriever(async () => response({ items: sparseItems })).getContext(
      contextRequest(),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuContextError && !error.message.includes(privateValue),
  )

  let accesses = 0
  const accessorItems = Object.defineProperty(/** @type {any[]} */ ([]), '0', {
    enumerable: true,
    get() {
      accesses += 1
      return { privateValue }
    },
  })
  Object.defineProperty(accessorItems, 'length', { value: 1 })
  await assert.rejects(
    retriever(async () => response({ items: accessorItems })).getContext(
      contextRequest(),
      new AbortController().signal,
    ),
    (error) => error instanceof FeishuContextError && !error.message.includes(privateValue),
  )
  assert.equal(accesses, 0)
})

test('cancellation and adapter failures remain typed and payload-free', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    retriever(async () => response()).getContext(contextRequest(), cancelled.signal),
    { name: 'AbortError' },
  )

  const privateValue = 'synthetic-private-client-failure'
  await assert.rejects(
    retriever(async () => {
      throw new Error(privateValue)
    }).getContext(contextRequest(), new AbortController().signal),
    (error) =>
      error instanceof FeishuContextError &&
      error.code === 'client_failure' &&
      error.retryable &&
      !error.message.includes(privateValue),
  )
  await assert.rejects(
    retriever(async () => {
      throw new FeishuContextClientError('scope_missing')
    }).getContext(contextRequest(), new AbortController().signal),
    (error) =>
      error instanceof FeishuContextError && error.code === 'scope_missing' && !error.retryable,
  )
})

test('custom context bounds are validated and forwarded without enabling binary downloads', async () => {
  /** @type {import('../packages/plugin-feishu/dist/index.js').FeishuContextReadRequest | undefined} */
  let received
  await retriever(
    async (request) => {
      received = request
      return response({ items: [conversationItem()] })
    },
    {
      maximumDocumentCharacters: 1_000,
      maximumAttachmentBytes: 2_000,
      maximumAttachmentTextCharacters: 500,
    },
  ).getContext(contextRequest(), new AbortController().signal)
  assert.equal(received?.documents.maxCharacters, 1_000)
  assert.equal(received?.attachments.maxBytes, 2_000)
  assert.equal(received?.attachments.maxTextCharacters, 500)
  assert.equal(received?.attachments.downloadBinary, false)

  assert.throws(
    () =>
      retriever(async () => response(), {
        maximumAttachmentBytes: 100,
        maximumAttachmentTextCharacters: 101,
      }),
    (error) => error instanceof FeishuContextError && error.code === 'invalid_request',
  )

  const uppercaseText = attachmentItem({
    content: { ...attachmentItem().content, mediaType: 'Text/Plain' },
  })
  const directAttachment = uppercaseText.source
  const uppercaseResult = await retriever(async () =>
    response({ reference: directAttachment, items: [uppercaseText] }),
  ).getContext(
    contextRequest({ reference: directAttachment, maxItems: 1 }),
    new AbortController().signal,
  )
  assert.deepEqual(uppercaseResult.availability, { status: 'complete' })
})
