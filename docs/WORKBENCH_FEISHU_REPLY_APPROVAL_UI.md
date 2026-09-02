# Workbench Feishu Reply Approval UI

## Scope

The Workbench Inbox exposes the product UI for requesting and deciding one
exact Feishu User reply approval. It composes the existing Connector-neutral
TD-206 SQLite policy; this step does not consume the approval, invoke the
execution Host, resolve a credential, call Feishu, or create an ActionReceipt.

The visible flow remains explicitly separated:

```text
ready_for_review Draft
  -> exact reply preview
  -> request approval
  -> approve once | reject | cancel | expire
  -> separate execution step
```

## Host-Owned Binding

The browser submits only a version 1 Work Item ID and Draft revision when it
requests approval. A decision adds only `approved`, `rejected`, or `cancelled`.
The Host resolves the already durable proposal from the current configured
Feishu User identity, latest unique timestamped message target, and exact Draft.
It derives the stable ApprovalRecord ID, responder, timestamps, 15-minute
expiration, and identity, target, and content digests. The browser cannot
select or override those fields and cannot request automatic expiration.

Before a decision, the Inbox displays the exact configured account, User
identity label and type, message target and source time, write risk, expiration,
and final plain-text content. Approval is a one-time authorization record only;
the page states that it has not been consumed and no message has been sent.

## Recovery and Audit

The ApprovalRecord ID is a hash-only deterministic derivative of the proposal
ID. An interrupted request or decision can therefore replay the exact storage
operation after restart. The fixed request time, expiration, decision time,
and responder are recovered from the durable record rather than regenerated.
Changed replay data fails closed.

Request and decision each append a deterministic, content-free business Audit
record after the atomic policy transition. If the Audit append is interrupted,
the same UI operation repairs it without creating another approval or changing
the decision. Audit details record the action type, identity type, decision,
authority effect, and absence of execution; they exclude content, target IDs,
digests, principals, credential references, and Connector payloads.

## Expiration and Failure

The approval window is fixed at 15 minutes, below the TD-206 maximum of 24
hours. If a decision arrives after expiration, the Host records the policy's
automatic `expired` decision with a system actor and no responder. Rejection,
cancellation, expiration, conflicting decisions, changed configuration,
changed target resolution, missing Drafts, and cancellation all fail closed or
produce their explicit terminal state. None can create execution authority.

Both mutation endpoints require same-origin Fetch metadata, exact JSON, bounded
bodies, and a separate memory-only CSRF token. Responses are reparsed before
presentation and contain no ApprovalRecord ID, binding digest, responder ID,
principal, SecretReference, idempotency key, or credential value.

## Remaining Work

- The separate execution UI now consumes an approved capability only after a
  second explicit click; see
  [Workbench Feishu Reply Execution UI](WORKBENCH_FEISHU_REPLY_EXECUTION_UI.md).
- No hosted ingestion/polling lifecycle or live-account send is proven.
- The complete durable flow now restores after refresh; production polling and
  cross-window live updates remain open.

## Verification

The Workbench controller tests cover exact request, 15-minute expiration,
approval, rejection, cancellation, automatic expiration, restart replay,
conflicting decisions, hostile fields, cancellation, request/decision Audit
repair, zero consumption, and zero receipts. Web contract and loopback API tests
cover exact response chronology and state consistency, same-origin CSRF,
authority-field rejection, separate request/decision routes, unavailable
capability, and the plain Inbox controls.
