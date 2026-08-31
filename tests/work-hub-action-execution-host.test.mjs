import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseActionProposal } from '../packages/domain/dist/index.js'
import {
  WorkHubActionExecutionError,
  WorkHubActionExecutionHost,
} from '../packages/plugin-work-hub/dist/index.js'
import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import {
  computeActionApprovalBindings,
  computeDraftContentDigest,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

/** @typedef {import('../packages/domain/src/model.ts').ActionProposal} ActionProposal */
/** @typedef {import('../packages/domain/src/model.ts').DraftContent} DraftContent */
/** @typedef {import('../packages/domain/src/model.ts').IsoTimestamp} IsoTimestamp */
/** @typedef {import('../packages/plugin-work-hub/src/action-execution-host.ts').WorkHubActionExecutionRequest} WorkHubActionExecutionRequest */

const CREATED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:00:00.000Z')
const REQUESTED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:01:00.000Z')
const APPROVED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:02:00.000Z')
const STARTED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:03:00.000Z')
const FIRST_ATTEMPTED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:04:00.000Z')
const SECOND_ATTEMPTED_AT = /** @type {IsoTimestamp} */ ('2026-08-28T08:05:00.000Z')
const EXPIRES_AT = /** @type {IsoTimestamp} */ ('2026-08-28T09:00:00.000Z')
const AFTER_EXPIRY = /** @type {IsoTimestamp} */ ('2026-08-28T10:00:00.000Z')

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const directory = await mkdtemp(join(tmpdir(), 'twindesk-work-hub-execution-'))
  context.after(async () => {
    await rm(directory, { recursive: true })
  })
  return join(directory, 'twindesk.sqlite')
}

function clock() {
  let value = Date.parse(CREATED_AT)
  return {
    now: () => value,
    /** @param {string} timestamp */
    set(timestamp) {
      value = Date.parse(timestamp)
    },
  }
}

/** @param {string} path @param {ReturnType<typeof clock>} currentClock @param {string} suffix */
function approvedFixture(path, currentClock, suffix) {
  createFixtureInboxService(path).close()
  const database = openTwinDeskDatabase(path, { now: currentClock.now })
  const workItem = database.queryInbox({ limit: 1 }).items[0]
  assert.ok(workItem !== undefined)
  const thread = database.getThread(workItem.threadId)
  assert.ok(thread !== undefined)
  const target = thread.externalReferences[0]
  assert.ok(target !== undefined)
  const content = /** @type {DraftContent} */ ({
    mediaType: 'text/plain',
    text: `Synthetic approved Host reply ${suffix}.`,
  })
  const proposal = /** @type {ActionProposal} */ (
    /** @type {unknown} */ (
      parseActionProposal({
        kind: 'action_proposal',
        schemaVersion: 1,
        id: `proposal-host-execution-${suffix}`,
        workItemId: workItem.id,
        actionType: 'feishu.reply',
        risk: 'write',
        identity: {
          connectorId: target.connectorId,
          accountId: target.accountId,
          identityType: 'user',
          displayName: 'Synthetic Host User',
        },
        target,
        content,
        contentDigest: computeDraftContentDigest(content),
        idempotencyKey: `tdfr1:${suffix.padEnd(40, 'a').slice(0, 40)}`,
        state: 'proposed',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      })
    )
  )
  database.createActionProposal(proposal)
  currentClock.set(REQUESTED_AT)
  const pending = database.requestActionApproval({
    kind: 'action_approval_request',
    schemaVersion: 1,
    id: /** @type {import('../packages/domain/src/model.ts').ApprovalRecordId} */ (
      `approval-host-execution-${suffix}`
    ),
    proposalId: proposal.id,
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  })
  const bindings = computeActionApprovalBindings(proposal)
  currentClock.set(APPROVED_AT)
  const approved = database.decideActionApproval({
    kind: 'action_approval_decision',
    schemaVersion: 1,
    approvalId: pending.approval.id,
    proposalId: proposal.id,
    decision: 'approved',
    ...bindings,
    decidedAt: APPROVED_AT,
    responderUserId: 'user:synthetic-host-owner',
  })
  currentClock.set(STARTED_AT)
  return { database, proposal, approval: approved.approval }
}

/**
 * @param {import('../packages/storage-sqlite/dist/index.js').TwinDeskDatabase} database
 * @param {number} failureCall
 */
function failAuditCall(database, failureCall) {
  let calls = 0
  return new Proxy(database, {
    get(target, property) {
      if (property === 'appendAuditRecords') {
        /** @param {readonly import('../packages/domain/src/model.ts').AuditRecord[]} records */
        return (records) => {
          calls += 1
          if (calls === failureCall) {
            throw new Error('synthetic private audit failure')
          }
          return target.appendAuditRecords(records)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** @param {string} approvalId @param {string} proposalId @returns {WorkHubActionExecutionRequest} */
function executionRequest(approvalId, proposalId) {
  return {
    kind: 'work_hub_action_execution_request',
    schemaVersion: 1,
    approvalId,
    proposalId,
  }
}

test('a durable receipt repairs missing Audit after restart and expiry without another send', async (context) => {
  const path = await temporaryDatabase(context)
  const currentClock = clock()
  let { database, proposal, approval } = approvedFixture(path, currentClock, 'auditrepair')
  let ownershipCalls = 0
  let externalWrites = 0
  /** @type {import('../packages/plugin-work-hub/src/action-execution-host.ts').WorkHubOwnedActionExecutor<{lease: string}>} */
  const execute = async (action, ownership, _signal, reserveDispatch) => {
    assert.deepEqual(ownership, { lease: 'synthetic-held' })
    currentClock.set(FIRST_ATTEMPTED_AT)
    assert.equal(reserveDispatch(action, FIRST_ATTEMPTED_AT), 'reserved')
    externalWrites += 1
    return {
      proposalId: action.proposal.id,
      connectorId: action.proposal.identity.connectorId,
      accountId: action.proposal.identity.accountId,
      idempotencyKey: action.proposal.idempotencyKey,
      attemptedAt: FIRST_ATTEMPTED_AT,
      outcome: 'succeeded',
      externalReference: {
        connectorId: action.proposal.identity.connectorId,
        accountId: action.proposal.identity.accountId,
        objectType: 'message',
        externalId: 'om_synthetic_host_success',
        sourceTimestamp: FIRST_ATTEMPTED_AT,
      },
    }
  }
  const host = new WorkHubActionExecutionHost({
    database: failAuditCall(database, 2),
    now: currentClock.now,
    async withExclusiveOperation(_signal, operation) {
      ownershipCalls += 1
      return operation({ lease: 'synthetic-held' })
    },
    execute,
  })
  await assert.rejects(
    host.execute(executionRequest(approval.id, proposal.id), new AbortController().signal),
    (error) =>
      error instanceof WorkHubActionExecutionError &&
      error.code === 'audit_incomplete' &&
      !error.message.includes('synthetic private audit failure'),
  )
  assert.equal(externalWrites, 1)
  assert.equal(database.queryAuditTimeline({ limit: 100 }).records.length, 1)
  assert.equal(database.getActionProposal(proposal.id)?.state, 'succeeded')
  database.close()

  currentClock.set(AFTER_EXPIRY)
  database = openTwinDeskDatabase(path, { now: currentClock.now })
  const recovered = await new WorkHubActionExecutionHost({
    database,
    now: currentClock.now,
    async withExclusiveOperation(_signal, operation) {
      ownershipCalls += 1
      return operation({ lease: 'synthetic-held' })
    },
    execute,
  }).execute(executionRequest(approval.id, proposal.id), new AbortController().signal)

  assert.equal(recovered.source, 'recovered')
  assert.equal(recovered.receipt.outcome, 'succeeded')
  assert.equal(recovered.receiptDisposition, 'existing')
  assert.equal(recovered.auditInsertedCount, 1)
  assert.equal(recovered.auditDuplicateCount, 1)
  assert.equal(externalWrites, 1)
  assert.equal(ownershipCalls, 2)
  assert.deepEqual(
    new Set(database.queryAuditTimeline({ limit: 100 }).records.map(({ category }) => category)),
    new Set(['approval', 'execution']),
  )
  database.close()
})

test('approval Audit failure blocks dispatch and repairs after expiry without reviving authority', async (context) => {
  const path = await temporaryDatabase(context)
  const currentClock = clock()
  let { database, proposal, approval } = approvedFixture(path, currentClock, 'approvalaudit')
  let executionCalls = 0
  const execute = async () => {
    executionCalls += 1
    assert.fail('execution must not start before durable approval Audit')
  }
  const request = executionRequest(approval.id, proposal.id)
  await assert.rejects(
    new WorkHubActionExecutionHost({
      database: failAuditCall(database, 1),
      now: currentClock.now,
      async withExclusiveOperation(_signal, operation) {
        return operation({ lease: 'synthetic-held' })
      },
      execute,
    }).execute(request, new AbortController().signal),
    (error) => error instanceof WorkHubActionExecutionError && error.code === 'audit_incomplete',
  )
  assert.equal(executionCalls, 0)
  assert.ok(database.getActionApproval(approval.id)?.consumedAt !== undefined)
  assert.equal(database.getActionProposal(proposal.id)?.state, 'approved')
  assert.equal(database.queryAuditTimeline({ limit: 100 }).records.length, 0)
  database.close()

  currentClock.set(AFTER_EXPIRY)
  database = openTwinDeskDatabase(path, { now: currentClock.now })
  await assert.rejects(
    new WorkHubActionExecutionHost({
      database,
      now: currentClock.now,
      async withExclusiveOperation(_signal, operation) {
        return operation({ lease: 'synthetic-held' })
      },
      execute,
    }).execute(request, new AbortController().signal),
    (error) =>
      error instanceof WorkHubActionExecutionError && error.code === 'approval_unavailable',
  )
  assert.equal(executionCalls, 0)
  assert.equal(database.getActionProposal(proposal.id)?.state, 'approved')
  const audits = database.queryAuditTimeline({ limit: 100 }).records
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.category, 'approval')
  database.close()
})

test('ownership failure and cancellation occur before approval consumption or dispatch', async (context) => {
  const path = await temporaryDatabase(context)
  const currentClock = clock()
  const { database, proposal, approval } = approvedFixture(path, currentClock, 'ownership')
  let ownershipCalls = 0
  let executionCalls = 0
  const host = new WorkHubActionExecutionHost({
    database,
    now: currentClock.now,
    async withExclusiveOperation() {
      ownershipCalls += 1
      throw new Error('synthetic private ownership failure')
    },
    async execute() {
      executionCalls += 1
      assert.fail('execution must not start')
    },
  })
  await assert.rejects(
    host.execute(executionRequest(approval.id, proposal.id), new AbortController().signal),
    (error) =>
      error instanceof WorkHubActionExecutionError &&
      error.code === 'ownership_unavailable' &&
      !error.message.includes('synthetic private ownership failure'),
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    host.execute(executionRequest(approval.id, proposal.id), controller.signal),
    {
      name: 'AbortError',
    },
  )
  assert.equal(ownershipCalls, 1)
  assert.equal(executionCalls, 0)
  assert.equal(database.getActionApproval(approval.id)?.consumedAt, undefined)
  assert.equal(database.getActionProposal(proposal.id)?.state, 'approved')
  assert.equal(database.queryAuditTimeline({ limit: 100 }).records.length, 0)
  database.close()
})

test('a retryable preflight receipt is audited before a new durable dispatch ordinal', async (context) => {
  const path = await temporaryDatabase(context)
  const currentClock = clock()
  const { database, proposal, approval } = approvedFixture(path, currentClock, 'retryhost')
  let attempts = 0
  const host = new WorkHubActionExecutionHost({
    database,
    now: currentClock.now,
    async withExclusiveOperation(_signal, operation) {
      return operation({ lease: 'synthetic-held' })
    },
    async execute(action, _ownership, _signal, reserveDispatch) {
      attempts += 1
      const attemptedAt = attempts === 1 ? FIRST_ATTEMPTED_AT : SECOND_ATTEMPTED_AT
      currentClock.set(attemptedAt)
      assert.equal(reserveDispatch(action, attemptedAt), 'reserved')
      if (attempts === 1) {
        return {
          proposalId: action.proposal.id,
          connectorId: action.proposal.identity.connectorId,
          accountId: action.proposal.identity.accountId,
          idempotencyKey: action.proposal.idempotencyKey,
          attemptedAt,
          outcome: 'failed',
          error: {
            code: 'feishu_preflight_unavailable',
            message: 'The Feishu reply preflight is temporarily unavailable.',
            retryable: true,
          },
          retryDisposition: 'retry_same_key',
        }
      }
      return {
        proposalId: action.proposal.id,
        connectorId: action.proposal.identity.connectorId,
        accountId: action.proposal.identity.accountId,
        idempotencyKey: action.proposal.idempotencyKey,
        attemptedAt,
        outcome: 'succeeded',
        externalReference: {
          connectorId: action.proposal.identity.connectorId,
          accountId: action.proposal.identity.accountId,
          objectType: 'message',
          externalId: 'om_synthetic_host_retry_success',
          sourceTimestamp: attemptedAt,
        },
      }
    },
  })
  const request = executionRequest(approval.id, proposal.id)
  const first = await host.execute(request, new AbortController().signal)
  assert.equal(first.receipt.outcome, 'failed')
  assert.equal(first.auditInsertedCount, 2)

  const second = await host.execute(request, new AbortController().signal)
  assert.equal(second.receipt.outcome, 'succeeded')
  assert.equal(second.auditInsertedCount, 1)
  assert.equal(second.auditDuplicateCount, 2)
  assert.equal(attempts, 2)
  assert.equal(database.getLatestActionDispatch(second.executionAttemptId)?.ordinal, 2)
  const audits = database.queryAuditTimeline({ limit: 100 }).records
  assert.equal(audits.filter(({ category }) => category === 'approval').length, 1)
  assert.equal(audits.filter(({ category }) => category === 'execution').length, 2)
  database.close()
})
