import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuReplyExecutionHost } from '../packages/bundle-workbench/dist/index.js'
import {
  parseDraft,
  parseExternalEvent,
  parseExternalThread,
  parseWorkItem,
} from '../packages/domain/dist/index.js'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FeishuReplyHttpClient,
  FeishuReplyProposer,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'
import {
  computeActionApprovalBindings,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').Draft} Draft */
/** @typedef {import('../packages/domain/src/model.ts').ExternalEvent} ExternalEvent */
/** @typedef {import('../packages/domain/src/model.ts').ExternalThread} ExternalThread */
/** @typedef {import('../packages/domain/src/model.ts').IsoTimestamp} IsoTimestamp */
/** @typedef {import('../packages/domain/src/model.ts').WorkItem} WorkItem */
/** @typedef {import('../packages/plugin-work-hub/src/action-execution-host.ts').WorkHubActionExecutionRequest} WorkHubActionExecutionRequest */

const ACCOUNT_ID = 'feishu-account:synthetic-workbench-runtime'
const APP_ID = 'cli_synthetic_workbench_runtime'
const USER_PRINCIPAL_ID = 'ou_synthetic_workbench_runtime_user'
const MESSAGE_ID = 'om_synthetic_workbench_runtime_target'
const RESULT_MESSAGE_ID = 'om_synthetic_workbench_runtime_result'
const PRIVATE_ACCESS_TOKEN = 'u-synthetic-private-workbench-access-token'
const PRIVATE_REFRESH_TOKEN = 'synthetic-private-workbench-refresh-token'
const PRIVATE_CLIENT_SECRET = 'synthetic-private-workbench-client-secret'
const SOURCE_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:00:00.000Z')
const DRAFTED_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:01:00.000Z')
const PROPOSED_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:02:00.000Z')
const REQUESTED_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:03:00.000Z')
const APPROVED_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:04:00.000Z')
const EXECUTED_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:05:00.000Z')
const EXPIRES_AT = /** @type {IsoTimestamp} */ ('2026-08-31T08:30:00.000Z')
const AFTER_EXPIRY = /** @type {IsoTimestamp} */ ('2026-08-31T09:00:00.000Z')

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    appId: APP_ID,
    user: {
      identityType: 'user',
      displayName: 'Synthetic Workbench User',
      principalId: USER_PRINCIPAL_ID,
      credentialReference: {
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-workbench-user',
        store: 'system_keychain',
        purpose: 'connector_oauth',
      },
    },
  }
}

function clock() {
  let value = Date.parse(SOURCE_AT)
  return {
    now: () => value,
    /** @param {IsoTimestamp} timestamp */
    set(timestamp) {
      value = Date.parse(timestamp)
    },
  }
}

/** @param {unknown} value */
function encoded(value) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

/** @param {Uint8Array} value */
function decoded(value) {
  return new TextDecoder().decode(value)
}

/** @param {unknown} value */
function jsonResponse(value) {
  const body = new TextEncoder().encode(JSON.stringify(value))
  return {
    body,
    response: new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(body)
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    ),
  }
}

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const directory = await mkdtemp(join(tmpdir(), 'twindesk-workbench-feishu-runtime-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'twindesk.sqlite3')
}

/**
 * @param {import('../packages/storage-sqlite/src/database.ts').TwinDeskDatabase} database
 */
function putWorkItem(database) {
  const source = {
    connectorId: 'feishu',
    accountId: ACCOUNT_ID,
    objectType: 'message',
    externalId: MESSAGE_ID,
    sourceTimestamp: SOURCE_AT,
  }
  const event = /** @type {ExternalEvent} */ (
    /** @type {unknown} */ (
      parseExternalEvent({
        kind: 'external_event',
        schemaVersion: 1,
        id: 'event-workbench-feishu-runtime',
        idempotencyKey: 'feishu:synthetic-workbench-runtime:v1',
        source,
        eventType: 'message.received',
        occurredAt: SOURCE_AT,
        receivedAt: SOURCE_AT,
        context: { status: 'complete' },
        normalized: { synthetic: true },
      })
    )
  )
  const thread = /** @type {ExternalThread} */ (
    /** @type {unknown} */ (
      parseExternalThread({
        kind: 'external_thread',
        schemaVersion: 1,
        id: 'thread-workbench-feishu-runtime',
        subject: 'Synthetic Workbench reply target',
        externalReferences: [source],
        sourceEventIds: [event.id],
        createdAt: SOURCE_AT,
        updatedAt: SOURCE_AT,
      })
    )
  )
  const workItem = /** @type {WorkItem} */ (
    /** @type {unknown} */ (
      parseWorkItem({
        kind: 'work_item',
        schemaVersion: 1,
        id: 'work-item-workbench-feishu-runtime',
        threadId: thread.id,
        sourceEventIds: [event.id],
        inboxState: 'needs_reply',
        title: 'Reply to the synthetic Workbench message',
        summary: 'A bounded synthetic Feishu message needs a reply.',
        attentionReason: 'The sender asked for confirmation.',
        selectedPersonaId: 'communication',
        createdAt: SOURCE_AT,
        updatedAt: SOURCE_AT,
      })
    )
  )
  database.ingestExternalEvents([event])
  database.putWorkItemProjection({ thread, workItem })
  return { source, workItem }
}

test('Workbench binds one approved reply through the real Feishu lease and adapter', async (context) => {
  const currentClock = clock()
  const path = await temporaryDatabase(context)
  let database = openTwinDeskDatabase(path, {
    now: currentClock.now,
  })
  context.after(() => {
    if (database.isOpen) database.close()
  })
  const { source, workItem } = putWorkItem(database)
  const draft = /** @type {Draft} */ (
    /** @type {unknown} */ (
      parseDraft({
        kind: 'draft',
        schemaVersion: 1,
        id: 'draft-workbench-feishu-runtime',
        workItemId: workItem.id,
        personaId: 'communication',
        revision: 1,
        state: 'ready_for_review',
        content: {
          mediaType: 'text/plain',
          text: 'Confirmed: the synthetic Workbench reply path is ready.',
        },
        rationale: 'Synthetic complete context supports this exact response.',
        createdAt: DRAFTED_AT,
        updatedAt: DRAFTED_AT,
      })
    )
  )
  database.createDraft(draft)
  const identityConfiguration = configuration()
  const proposal = await new FeishuReplyProposer(identityConfiguration, {
    now: () => Date.parse(PROPOSED_AT),
    createNonce: () => 'synthetic-workbench-runtime-nonce',
  }).propose(
    {
      workItemId: workItem.id,
      draftId: draft.id,
      actionType: FEISHU_REPLY_ACTION_TYPE,
      identity: toFeishuActionIdentity(identityConfiguration, 'user'),
      target: source,
      content: draft.content,
    },
    new AbortController().signal,
  )
  database.createActionProposal(proposal)
  currentClock.set(REQUESTED_AT)
  const pending = database.requestActionApproval({
    kind: 'action_approval_request',
    schemaVersion: 1,
    id: /** @type {import('../packages/domain/src/model.ts').ApprovalRecordId} */ (
      'approval-workbench-feishu-runtime'
    ),
    proposalId: proposal.id,
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  })
  currentClock.set(APPROVED_AT)
  database.decideActionApproval({
    kind: 'action_approval_decision',
    schemaVersion: 1,
    approvalId: pending.approval.id,
    proposalId: proposal.id,
    decision: 'approved',
    ...computeActionApprovalBindings(proposal),
    decidedAt: APPROVED_AT,
    responderUserId: 'user:synthetic-local-owner',
  })

  /** @type {Uint8Array[]} */
  const secretBuffers = []
  let keychainReads = 0
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        keychainReads += 1
        const value = encoded({
          kind: 'feishu_user_oauth_credential_bundle',
          schemaVersion: 1,
          appId: APP_ID,
          principalId: USER_PRINCIPAL_ID,
          clientSecret: PRIVATE_CLIENT_SECRET,
          tokenType: 'Bearer',
          accessToken: PRIVATE_ACCESS_TOKEN,
          obtainedAt: '2026-08-31T07:00:00.000Z',
          accessTokenExpiresAt: '2026-08-31T10:00:00.000Z',
          refreshToken: PRIVATE_REFRESH_TOKEN,
          refreshTokenExpiresAt: '2026-09-07T07:00:00.000Z',
          scopes: ['im:message:send_as_user', 'offline_access'],
        })
        secretBuffers.push(value)
        return value
      },
    },
  })
  const userScopeProbe = new FeishuUserCredentialScopeProbe({
    configuration: identityConfiguration,
    resolver,
    now: currentClock.now,
  })
  /** @type {Uint8Array[]} */
  const responseBuffers = []
  let replyCalls = 0
  /** @type {string | null | undefined} */
  let authorization
  /** @type {unknown} */
  let sentBody
  /** @type {Uint8Array | undefined} */
  let requestBody
  const replyClient = new FeishuReplyHttpClient({
    fetch: async (_url, init) => {
      replyCalls += 1
      authorization = new Headers(init?.headers).get('authorization')
      assert.ok(init?.body instanceof Uint8Array)
      requestBody = init.body
      sentBody = JSON.parse(decoded(init.body))
      const current = jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          message_id: RESULT_MESSAGE_ID,
          create_time: String(Date.parse(EXECUTED_AT)),
        },
      })
      responseBuffers.push(current.body)
      return current.response
    },
  })
  let host = createWorkbenchFeishuReplyExecutionHost({
    database,
    configuration: identityConfiguration,
    resolver,
    replyClient,
    userScopeProbe,
    now: currentClock.now,
  })
  const request = /** @type {WorkHubActionExecutionRequest} */ ({
    kind: 'work_hub_action_execution_request',
    schemaVersion: 1,
    approvalId: pending.approval.id,
    proposalId: proposal.id,
  })
  currentClock.set(EXECUTED_AT)
  const executed = await host.execute(request, new AbortController().signal)

  assert.equal(executed.source, 'executed')
  assert.equal(executed.receipt.outcome, 'succeeded')
  assert.equal(executed.receipt.externalReference?.externalId, RESULT_MESSAGE_ID)
  assert.equal(executed.auditInsertedCount, 2)
  assert.equal(keychainReads, 2)
  assert.equal(replyCalls, 1)
  assert.equal(authorization, `Bearer ${PRIVATE_ACCESS_TOKEN}`)
  assert.deepEqual(sentBody, {
    content: JSON.stringify({ text: draft.content.text }),
    msg_type: 'text',
    uuid: proposal.idempotencyKey,
  })
  assert.equal(database.getActionProposal(proposal.id)?.state, 'succeeded')
  assert.equal(database.getLatestActionDispatch(executed.executionAttemptId)?.ordinal, 1)
  assert.equal(
    database.getActionExecutionReceipt(executed.executionAttemptId)?.receipt.outcome,
    'succeeded',
  )
  assert.deepEqual(
    new Set(database.queryAuditTimeline({ limit: 10 }).records.map(({ category }) => category)),
    new Set(['approval', 'execution']),
  )
  assert.ok(requestBody instanceof Uint8Array)
  for (const buffer of [...secretBuffers, ...responseBuffers, requestBody]) {
    assert.equal(
      buffer.every((byte) => byte === 0),
      true,
    )
  }

  database.close()
  database = openTwinDeskDatabase(path, { now: currentClock.now })
  host = createWorkbenchFeishuReplyExecutionHost({
    database,
    configuration: identityConfiguration,
    resolver,
    replyClient,
    userScopeProbe,
    now: currentClock.now,
  })
  currentClock.set(AFTER_EXPIRY)
  const recovered = await host.execute(request, new AbortController().signal)
  assert.equal(recovered.source, 'recovered')
  assert.equal(recovered.receipt.outcome, 'succeeded')
  assert.equal(recovered.receiptDisposition, 'existing')
  assert.equal(replyCalls, 1)
  assert.equal(keychainReads, 2)
})

test('Workbench rejects incomplete runtime collaborators before execution', () => {
  const identityConfiguration = configuration()
  const resolver = new FeishuSystemKeychainSecretResolver({
    platform: 'darwin',
    runner: {
      async run() {
        return encoded({})
      },
    },
  })
  const replyClient = new FeishuReplyHttpClient({
    fetch: async () => new Response('{}'),
  })
  const userScopeProbe = new FeishuUserCredentialScopeProbe({
    configuration: identityConfiguration,
    resolver,
    now: () => Date.parse(EXECUTED_AT),
  })
  assert.throws(
    () =>
      createWorkbenchFeishuReplyExecutionHost(
        /** @type {any} */ ({
          database: {},
          configuration: identityConfiguration,
          resolver,
          replyClient,
        }),
      ),
    (error) =>
      error instanceof TypeError &&
      error.message === 'The Workbench Feishu reply runtime configuration is invalid.',
  )
  assert.throws(
    () =>
      createWorkbenchFeishuReplyExecutionHost(
        /** @type {any} */ ({
          database: {},
          configuration: identityConfiguration,
          resolver,
          replyClient,
          userScopeProbe,
        }),
      ),
    (error) =>
      error instanceof TypeError &&
      error.message === 'The Workbench Feishu reply runtime configuration is invalid.',
  )

  let accessorCalls = 0
  const hostileDatabase = Object.defineProperty({}, 'appendAuditRecords', {
    get() {
      accessorCalls += 1
      throw new Error(PRIVATE_ACCESS_TOKEN)
    },
  })
  assert.throws(
    () =>
      createWorkbenchFeishuReplyExecutionHost(
        /** @type {any} */ ({
          database: hostileDatabase,
          configuration: identityConfiguration,
          resolver,
          replyClient,
          userScopeProbe,
        }),
      ),
    (error) =>
      error instanceof TypeError &&
      error.message === 'The Workbench Feishu reply runtime configuration is invalid.',
  )
  assert.equal(accessorCalls, 0)
})
