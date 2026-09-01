import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOMAIN_SCHEMA_VERSION,
  DomainValidationError,
  DomainStateTransitionError,
  applyActionProposalStateTransition,
  applyDraftStateTransition,
  parseActionProposal,
  parseActionProposalStateTransition,
  parseApprovalRecord,
  parseAuditRecord,
  parseDomainRecord,
  parseDraft,
  parseExternalEvent,
  parseDraftStateTransition,
  parseSecretReference,
  parseWorkItem,
  parseWorkItemUserAction,
} from '../packages/domain/dist/index.js'

const firstTimestamp = '2026-08-26T08:00:00Z'
const secondTimestamp = '2026-08-26T08:01:00Z'
const thirdTimestamp = '2026-08-26T08:02:00Z'
const digest = `sha256:${'0'.repeat(64)}`
const source = {
  connectorId: 'feishu',
  accountId: 'synthetic-account',
  objectType: 'message',
  externalId: 'synthetic-message-1',
  sourceTimestamp: firstTimestamp,
}

const records = [
  {
    kind: 'external_event',
    schemaVersion: 1,
    id: 'event-1',
    idempotencyKey: 'feishu:synthetic-account:message:synthetic-message-1:v1',
    source,
    eventType: 'message.mentioned',
    occurredAt: firstTimestamp,
    receivedAt: secondTimestamp,
    context: { status: 'partial', missing: ['jira issue context'] },
    normalized: { text: 'Synthetic fixture', mentionsUser: true },
  },
  {
    kind: 'external_thread',
    schemaVersion: 1,
    id: 'thread-1',
    subject: 'Synthetic release question',
    externalReferences: [source],
    sourceEventIds: ['event-1'],
    createdAt: firstTimestamp,
    updatedAt: secondTimestamp,
  },
  {
    kind: 'work_item',
    schemaVersion: 1,
    id: 'work-item-1',
    threadId: 'thread-1',
    sourceEventIds: ['event-1'],
    inboxState: 'needs_reply',
    title: 'Reply to release question',
    summary: 'A synthetic stakeholder requested a release update.',
    attentionReason: 'Direct mention requires a reply.',
    selectedPersonaId: 'communication',
    createdAt: firstTimestamp,
    updatedAt: secondTimestamp,
  },
  {
    kind: 'draft',
    schemaVersion: 1,
    id: 'draft-1',
    workItemId: 'work-item-1',
    personaId: 'communication',
    sessionId: 'session-1',
    runId: 'run-1',
    revision: 1,
    state: 'ready_for_review',
    content: { mediaType: 'text/plain', text: 'Synthetic reply draft.' },
    rationale: 'Uses only verified fixture context.',
    createdAt: firstTimestamp,
    updatedAt: secondTimestamp,
  },
  {
    kind: 'action_proposal',
    schemaVersion: 1,
    id: 'proposal-1',
    workItemId: 'work-item-1',
    draftId: 'draft-1',
    actionType: 'feishu.reply',
    risk: 'write',
    identity: {
      connectorId: 'feishu',
      accountId: 'synthetic-account',
      identityType: 'user',
      displayName: 'Synthetic User',
    },
    target: source,
    content: { mediaType: 'text/plain', text: 'Synthetic reply draft.' },
    contentDigest: digest,
    idempotencyKey: 'proposal-1:attempt-1',
    state: 'awaiting_approval',
    createdAt: firstTimestamp,
    updatedAt: secondTimestamp,
  },
  {
    kind: 'approval_record',
    schemaVersion: 1,
    id: 'approval-1',
    proposalId: 'proposal-1',
    decision: 'approved',
    identityDigest: digest,
    targetDigest: digest,
    contentDigest: digest,
    requestedAt: firstTimestamp,
    expiresAt: '2026-08-26T08:10:00Z',
    decidedAt: secondTimestamp,
    responderUserId: 'local-user',
  },
  {
    kind: 'connector_cursor',
    schemaVersion: 1,
    id: 'cursor-1',
    connectorId: 'feishu',
    accountId: 'synthetic-account',
    stream: 'message-events',
    position: 'fixture-position-1',
    committedThrough: secondTimestamp,
    updatedAt: secondTimestamp,
  },
  {
    kind: 'audit_record',
    schemaVersion: 1,
    id: 'audit-1',
    category: 'approval',
    outcome: 'success',
    actor: { type: 'user', id: 'local-user' },
    summary: 'Synthetic proposal approved.',
    references: [
      { kind: 'work_item', id: 'work-item-1' },
      { kind: 'action_proposal', id: 'proposal-1' },
    ],
    details: { decision: 'approved' },
    occurredAt: secondTimestamp,
  },
  {
    kind: 'work_item_user_action',
    schemaVersion: 1,
    id: 'work-item-action-1',
    workItemId: 'work-item-1',
    revision: 1,
    action: 'set_inbox_state',
    inboxState: 'waiting',
    occurredAt: secondTimestamp,
  },
  {
    kind: 'draft_state_transition',
    schemaVersion: 1,
    id: 'draft-transition-1',
    draftId: 'draft-1',
    fromState: 'ready_for_review',
    toState: 'cancelled',
    occurredAt: thirdTimestamp,
  },
  {
    kind: 'action_proposal_state_transition',
    schemaVersion: 1,
    id: 'proposal-transition-1',
    proposalId: 'proposal-1',
    fromState: 'awaiting_approval',
    toState: 'rejected',
    occurredAt: thirdTimestamp,
  },
  {
    kind: 'secret_reference',
    schemaVersion: 1,
    id: 'secret-ref:synthetic-feishu-user-oauth',
    store: 'system_keychain',
    purpose: 'connector_oauth',
  },
]

/**
 * @template Value
 * @param {Value} value
 * @returns {Value}
 */
function copy(value) {
  return structuredClone(value)
}

test('all version 1 domain records parse into deeply immutable values', () => {
  assert.equal(DOMAIN_SCHEMA_VERSION, 1)
  for (const fixture of records) {
    const parsed = parseDomainRecord(copy(fixture))
    assert.equal(parsed.kind, fixture.kind)
    assert.equal(parsed.schemaVersion, DOMAIN_SCHEMA_VERSION)
    assert.equal(Object.isFrozen(parsed), true)
    for (const nested of Object.values(parsed)) {
      if (typeof nested === 'object' && nested !== null) assert.equal(Object.isFrozen(nested), true)
    }
  }
})

test('external events require stable identity, chronology, and explicit partial context', () => {
  const fixture = records[0]

  assert.throws(
    () => parseExternalEvent({ ...copy(fixture), schemaVersion: 2 }),
    /schemaVersion must equal 1/u,
  )
  assert.throws(
    () => parseExternalEvent({ ...copy(fixture), receivedAt: '2026-08-26T07:59:00Z' }),
    /receivedAt must not be earlier/u,
  )
  assert.throws(
    () => parseExternalEvent({ ...copy(fixture), receivedAt: '2026-02-31T08:01:00Z' }),
    /receivedAt must be a valid timestamp/u,
  )
  assert.throws(
    () => parseExternalEvent({ ...copy(fixture), context: { status: 'partial', missing: [] } }),
    /context\.missing must not be empty/u,
  )
  assert.throws(
    () => parseExternalEvent({ ...copy(fixture), normalized: { score: Number.NaN } }),
    /must contain only finite numbers/u,
  )
})

test('derived records require unique source references and valid timestamps', () => {
  const fixture = records[2]
  assert.throws(
    () => parseWorkItem({ ...copy(fixture), sourceEventIds: ['event-1', 'event-1'] }),
    /sourceEventIds must not contain duplicates/u,
  )
  assert.throws(
    () => parseWorkItem({ ...copy(fixture), updatedAt: 'not-a-time' }),
    /updatedAt must be a UTC ISO-8601 timestamp/u,
  )
  assert.throws(
    () => parseWorkItem({ ...copy(fixture), selectedPersonaId: undefined }),
    /selectedPersonaId must be a non-empty string/u,
  )
})

test('Work Item user actions are versioned, exact, and revisioned', () => {
  const fixture = records[8]
  assert.equal(fixture?.kind, 'work_item_user_action')
  assert.throws(
    () => parseWorkItemUserAction({ ...copy(fixture), revision: 0 }),
    /revision must be a positive safe integer/u,
  )
  assert.throws(
    () => parseWorkItemUserAction({ ...copy(fixture), personaId: 'unexpected' }),
    /personaId is not supported/u,
  )
  assert.throws(() => {
    const { inboxState: _inboxState, ...selectPersona } = copy(fixture)
    return parseWorkItemUserAction({ ...selectPersona, action: 'select_persona', personaId: '' })
  }, /personaId must be a non-empty string/u)
})

test('external action proposals bind identity, target, content digest, and idempotency key', () => {
  const fixture = records[4]
  assert.ok(fixture?.identity)
  assert.throws(
    () =>
      parseActionProposal({
        ...copy(fixture),
        identity: { ...copy(fixture.identity), accountId: 'different-account' },
      }),
    /identity must match the target connector and account/u,
  )
  assert.throws(
    () => parseActionProposal({ ...copy(fixture), contentDigest: 'not-a-digest' }),
    /contentDigest must be a lowercase sha256 digest/u,
  )
  assert.throws(
    () => parseActionProposal({ ...copy(fixture), idempotencyKey: ' ' }),
    /idempotencyKey must be a non-empty string/u,
  )
})

test('local state transitions are exact, chronological, and cannot imply approval', () => {
  const draft = parseDraftStateTransition(copy(records[9]))
  const proposal = parseActionProposalStateTransition(copy(records[10]))
  const draftRecord = parseDraft(copy(records[3]))
  const proposalRecord = parseActionProposal(copy(records[4]))
  assert.equal(applyDraftStateTransition(draftRecord, draft).state, 'cancelled')
  assert.equal(applyActionProposalStateTransition(proposalRecord, proposal).state, 'rejected')

  assert.throws(
    () =>
      parseActionProposalStateTransition({
        ...copy(records[10]),
        toState: 'approved',
      }),
    /not available without the required approval or execution evidence/u,
  )
  assert.throws(
    () =>
      applyDraftStateTransition(
        draftRecord,
        parseDraftStateTransition({ ...draft, draftId: 'different-draft' }),
      ),
    (error) => error instanceof DomainStateTransitionError && error.code === 'identity_mismatch',
  )
  assert.throws(
    () =>
      applyActionProposalStateTransition(
        proposalRecord,
        parseActionProposalStateTransition({ ...proposal, occurredAt: firstTimestamp }),
      ),
    (error) => error instanceof DomainStateTransitionError && error.code === 'chronology',
  )
})

test('approval records fail closed around decisions and one-time consumption', () => {
  const fixture = records[5]
  assert.ok(fixture)
  assert.throws(
    () =>
      parseApprovalRecord({
        ...copy(fixture),
        decision: 'pending',
      }),
    /pending approval must not contain a decision response/u,
  )
  const withoutResponder = copy(fixture)
  Reflect.deleteProperty(withoutResponder, 'responderUserId')
  assert.throws(
    () => parseApprovalRecord(withoutResponder),
    /responderUserId is required when decision is approved/u,
  )
  assert.throws(
    () =>
      parseApprovalRecord({
        ...copy(fixture),
        decision: 'rejected',
        consumedAt: '2026-08-26T08:02:00Z',
      }),
    /consumedAt is allowed only for an approved action/u,
  )
  assert.throws(
    () =>
      parseApprovalRecord({
        ...copy(fixture),
        expiresAt: '2026-08-26T08:00:30Z',
      }),
    /decidedAt must not be later than expiresAt for approval/u,
  )
  assert.throws(
    () =>
      parseApprovalRecord({
        ...copy(fixture),
        consumedAt: '2026-08-26T08:11:00Z',
      }),
    /consumedAt must not be later than expiresAt/u,
  )
})

test('audit validation requires attributable actors and does not echo rejected values', () => {
  const fixture = records[7]
  const connectorAudit = parseAuditRecord({
    ...copy(fixture),
    id: 'audit-connector-maintenance-1',
    category: 'system',
    actor: { type: 'connector', id: 'feishu' },
    references: [{ kind: 'connector', id: 'feishu' }],
  })
  assert.deepEqual(connectorAudit.references, [{ kind: 'connector', id: 'feishu' }])
  assert.throws(
    () => parseAuditRecord({ ...copy(fixture), actor: { type: 'connector' } }),
    /actor\.id is required when actor type is connector/u,
  )
  assert.throws(
    () => parseAuditRecord({ ...copy(fixture), actor: { type: 'system', id: 'unexpected' } }),
    /actor\.id is not allowed when actor type is system/u,
  )
  assert.throws(
    () =>
      parseAuditRecord({
        ...copy(fixture),
        references: [{ kind: 'unsupported', id: 'fixture-reference' }],
      }),
    /references\[0\]\.kind must be one of/u,
  )
  assert.throws(
    () =>
      parseAuditRecord({
        ...copy(fixture),
        references: [
          { kind: 'work_item', id: 'work-item-1' },
          { kind: 'work_item', id: 'work-item-1' },
        ],
      }),
    /references must not contain duplicates/u,
  )

  const secretLikeValue = 'synthetic-private-value'
  assert.throws(
    () => parseDomainRecord({ ...copy(fixture), unsupported: secretLikeValue }),
    (error) => {
      assert.ok(error instanceof DomainValidationError)
      assert.equal(error.message.includes(secretLikeValue), false)
      assert.equal(error.path, 'audit_record.unsupported')
      return true
    },
  )
  assert.throws(
    () => parseDomainRecord({ kind: 'unknown_record' }),
    /record\.kind is not a supported TwinDesk record kind/u,
  )

  const accessorFixture = copy(fixture)
  Object.defineProperty(accessorFixture, 'summary', { enumerable: true, get: () => 'computed' })
  assert.throws(
    () => parseAuditRecord(accessorFixture),
    /audit_record\.summary must be a data field/u,
  )
})

test('secret references accept only opaque locators and never secret material', () => {
  const fixture = records[11]
  assert.equal(fixture?.kind, 'secret_reference')
  assert.equal(parseSecretReference(copy(fixture)).id, fixture.id)
  assert.equal(
    parseSecretReference({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-feishu-bot-app',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    }).purpose,
    'connector_app_credential',
  )

  const secret = 'synthetic-secret-material-that-must-not-echo'
  for (const malformed of [
    { ...copy(fixture), id: secret },
    { ...copy(fixture), id: 'secret-ref:Uppercase' },
    { ...copy(fixture), store: 'plaintext' },
    { ...copy(fixture), purpose: 'grants_connector_scope' },
    { ...copy(fixture), value: secret },
  ]) {
    assert.throws(
      () => parseSecretReference(malformed),
      (error) => {
        assert.ok(error instanceof DomainValidationError)
        assert.equal(error.message.includes(secret), false)
        return true
      },
    )
  }

  const symbolField = /** @type {any} */ (copy(fixture))
  symbolField[Symbol('secret')] = secret
  assert.throws(() => parseSecretReference(symbolField), /must not contain symbol fields/u)

  const proxy = new Proxy(copy(fixture), {
    getPrototypeOf() {
      throw new Error(secret)
    },
  })
  assert.throws(
    () => parseSecretReference(proxy),
    (error) => error instanceof DomainValidationError && !error.message.includes(secret),
  )
})
