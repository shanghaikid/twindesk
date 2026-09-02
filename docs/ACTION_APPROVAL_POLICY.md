# One-Time Action Approval Policy

## Scope

TD-206 implements the local policy boundary between a durable
`ActionProposal` and the opaque `ApprovedAction` accepted by a Connector. It
stores and decides one version 1 `ApprovalRecord`, verifies the exact proposal
bindings again at consumption time, and marks the approval consumed in one
transaction. It invokes no Connector, resolves no credential, performs no
scope request, and creates no external effect or `ActionReceipt`.

The API is product-owned and Connector-neutral. TD-205 supplies the first
Feishu reply proposal, but a Persona, Skill, Tool, Connector configuration, or
proposal state cannot mint approval by itself.

## Request and Binding

`requestActionApproval()` accepts a versioned request containing a stable
Approval ID, durable proposal ID, request time, and exact expiration. The
proposal must still be `proposed`, and the request cannot precede it. The
policy computes and stores three canonical SHA-256 bindings:

- identity: Connector, account, Bot/User type, and displayed identity name;
- target: Connector, account, object type, external ID, and source timestamp;
- content: the proposal's already verified media type and exact text digest.

The expiration must be later than the request and no more than 24 hours away.
The storage handle compares request, decision, and consumption timestamps with
its trusted local clock; caller-supplied backdated timestamps cannot revive an
expired approval or create a premature expiration decision.
Requesting approval atomically inserts the pending `ApprovalRecord`, appends
the existing local `proposed -> awaiting_approval` transition, and updates the
proposal projection. An interruption rolls all three changes back. Only one
ApprovalRecord may be created through this boundary for a proposal; exact
replay is a duplicate, while ID or proposal reuse with changed values fails
closed.

The Workbench UI now shows the proposal's exact account, sending identity,
target, expiration, and final content before it submits a decision. This
storage boundary supplies the bound values and digests; the separate product
composition is documented in
[Workbench Feishu Reply Approval UI](WORKBENCH_FEISHU_REPLY_APPROVAL_UI.md).

## Decisions and Expiration

`decideActionApproval()` requires the Approval and proposal IDs plus all three
binding digests originally shown to the responder. `approved`, `rejected`, and
`cancelled` decisions require a non-empty responder user ID. Automatic
`expired` decisions must not claim a responder and cannot occur before the
expiration time.

Approval, rejection, and cancellation must occur no later than expiration. The
decision atomically updates both records:

```text
pending + awaiting_approval
  -> approved + approved
  -> rejected + rejected
  -> cancelled + cancelled
  -> expired + cancelled
```

The ApprovalRecord is the evidence for approval-derived proposal states;
low-level local proposal transitions remain unable to create `approved`.
Changed identity, target, content, responder, chronology, or decision data
fails without partial state. Exact decision replay remains idempotent after
restart.

## One-Time Consumption

`consumeActionApproval()` is the only TD-206 operation that returns an opaque
`ApprovedAction`. It requires an approved, unexpired, unconsumed
ApprovalRecord; an `approved` proposal; and the exact three binding digests.
The transaction writes `consumedAt` once before returning the capability.
Rejected, cancelled, expired, missing, mismatched, or late approvals cannot be
consumed.

The execution-attempt ID is deterministically derived from the Approval ID,
and the capability preserves the proposal's exact idempotency key. A replay of
consumption after restart may recover only that same execution attempt. It
does not create a second authorization or key. TD-207 must check the durable
receipt/reconciliation state before re-invoking a Connector; repeated API calls
under the same attempt are allowed only before the approval expires and as
idempotent recovery of an interruption or uncertain result. After expiration,
the policy returns no executable capability; TD-207 may only inspect receipts
or reconcile an already uncertain external result.

Consumption itself does not move the proposal to `executing` and does not call
Feishu. TD-207 now owns the separate execution-state, credential/scope client,
Connector invocation, receipt persistence, recovery, and uncertain-result
boundaries. See [Feishu Reply Execution](FEISHU_REPLY_EXECUTION.md).

## Privacy, Retention, and Audit

Approval records retain only stable local IDs, decisions, exact times,
responder user IDs, and digests. Identity display values, target IDs, and
content remain in the bound proposal rather than being copied into the
ApprovalRecord. Errors expose fixed messages and bounded codes without values,
SQL, paths, or underlying SQLite failures.

ApprovalRecords are already included in redacted Thread export, local deletion,
and Audit reference validation. `consumedAt` is part of that record and is
deleted with its owning Thread. The storage boundary does not automatically
append Audit records. The Workbench approval controller now appends
user-visible request and decision Audit records with restart repair, while the
composed execution flow owns consumption and receipt Audit ordering. TD-209
must still verify the complete source-to-receipt trace.

## Remaining Work

- The product UI stops after persisting the decision. It does not consume the
  approval or expose execution yet.
- The Connector-neutral Work Hub Host now composes approval consumption,
  durable dispatch, receipt, and recoverable Audit ordering inside an injected
  exclusive-operation callback. The Workbench Feishu reply runtime binds that
  Host to Keychain rotation and the lease-held reply adapter, and the product UI
  invokes it only through a separate explicit execution action; neither
  boundary grants execution authority by itself. See
  [Work Hub Action Execution Host](ACTION_EXECUTION_HOST.md).
- TD-209 local acceptance integrates the complete Audit trace; live-account
  acceptance remains required.

## Verification

`tests/approval-state.test.mjs` starts with a synthetic Feishu message,
ready-for-review Draft, and preview proposal. It covers atomic approval request,
restart replay, exact identity/target/content bindings, approval and one-time
consumption, stable execution-attempt recovery, zero receipts at the approval
boundary,
rejection, cancellation, automatic expiration, missing responders, expired
and backdated decisions or consumption, binding mismatch, hostile accessors,
interrupted decision rollback, closed handles, and payload-free errors. All
fixtures are synthetic and no Connector or external service is called.
