# Feishu Reply Execution and Reconciliation

## Scope

TD-207 implements the first external-write execution boundary for an approved
Feishu plain-text reply. It keeps the Connector adapter, approval capability,
and durable execution state separate:

- `FeishuReplyExecutor` accepts only the opaque `ApprovedAction` created by the
  one-time approval policy.
- `FeishuReplyExecutionClient` is the credential-resolving adapter boundary. It
  receives an exact non-secret credential reference, identity, target, content,
  and idempotency key; secrets and raw Feishu payloads never cross back into the
  executor.
- `@twindesk/storage-sqlite` atomically records the normalized ActionReceipt and
  advances the ActionProposal execution state.

The repository contains an isolated production macOS Keychain reader, a
versioned credential-bundle parser, and a bounded OAuth v3 Fetch transport, but
no atomic Keychain rotation, production dispatch composition, or Feishu reply
HTTP client. Execution tests use a synthetic client. A composed adapter must resolve
the supplied `SecretReference`, recheck the minimum send scope for the selected
Bot or User identity, and preserve the exact request key.

## Exact Execution Binding

Before any client call, the executor revalidates:

- `actionType: feishu.reply` and `risk: write`;
- the configured Connector, account, Bot/User slot, display identity, principal,
  and credential-reference purpose;
- the exact timestamped source message target;
- plain-text content and its canonical SHA-256 digest;
- the ApprovalRecord identity, target, content, responder, and expiration;
- the deterministic execution-attempt ID derived from the Approval ID.

The proposal idempotency key contains a salted SHA-256 fingerprint of the
proposal ID, configured app, principal, and complete SecretReference metadata.
New proposals persist a 46-character `tdfr1:` key, which fits the Feishu reply
request limit of 50 characters. The executor recomputes the fingerprint before
obtaining the client request, so a principal or credential rotation invalidates
the old approved action even when account, identity type, and display name are
unchanged. Only the hash is persisted with the proposal. The executor retains
no fallback for the longer format emitted before this constraint was enforced:
those proposals cannot satisfy the platform limit and must be replaced by a new
preview and explicit approval. Over-limit, malformed, or proposal-mismatched
keys fail before the credential-resolving client is accessed.
Successful reconciliation also requires an exact Connector/account response and
a remote message timestamp no earlier than proposal creation and no more than a
bounded five-minute clock skew ahead of local observation.

An ActionIdentity still carries no credential or scope authority. The executor
projects the already configured principal and credential reference only after
all approval bindings match. A changed configuration, target, content, approval,
or attempt fails before reconciliation or sending.

## Reconcile Before Send

Every `execute()` call follows the same order:

```text
validate exact ApprovedAction
  -> reconcile the exact idempotency key
     -> found: return succeeded without sending
     -> confirmed absent: send once with the same key
     -> unavailable or malformed: return uncertain, do not send
```

This order also applies to the first attempt. It deliberately spends one read
to close the crash window between a remote send and local receipt persistence.
If the process stops in that window, the durable consumed approval and
`executing` state identify the same attempt after restart; reconciliation finds
the remote message and no duplicate send occurs.

A rate limit that is known to reject the request produces `failed` with
`retry_same_key`. Authorization, missing scope, or explicit rejection produces
`failed` with `do_not_retry`. A network failure, unknown adapter failure,
identity-inconsistent response, or malformed post-send response produces
`uncertain` with `reconcile_first`. All issue codes and summaries are bounded,
normalized values and never contain a response payload.

## Durable State and Recovery

`beginActionExecution()` verifies the durable consumed ApprovalRecord, exact
proposal, execution-attempt ID, trusted clock, current receipt, and retry state
before atomically moving the proposal to `executing`. It refuses a succeeded or
non-retryable failed attempt and refuses a new send after approval expiration.

`recordActionExecutionReceipt()` validates the receipt against the exact
proposal identity, external Connector/account, idempotency key, attempt, and
execution chronology. Receipt persistence
and the proposal transition to `succeeded`, `failed`, or `uncertain` share one
transaction. An interruption rolls back both. Exact replay is a duplicate;
only `uncertain` or `retry_same_key` evidence may advance under the same attempt.

Immediately before `send()`, `execute()` now requires its injected dispatch
coordinator to durably reserve the exact attempt. Missing or failed reservation
and an existing unsettled/uncertain reservation all send nothing. SQLite
migration 6 records ordered reservations and settles the latest reservation in
the same transaction as its receipt and proposal state. Only a durable
`retry_same_key` failure permits another reservation. See
[Durable Action Dispatch Journal](ACTION_DISPATCH_JOURNAL.md).

`recoverActionExecution()` reconstructs only a previously consumed,
non-terminal attempt from durable proposal, approval, and receipt state. After
expiration, the recovered capability is accepted by `reconcile()` but rejected
by `execute()`: an existing uncertain result can still be inspected, while an
expired approval cannot authorize a new send.

The current `action_receipts` row is a normalized result projection for one
stable execution attempt. Reconciliation may replace `uncertain` or retryable
failure state with its later result. TD-209 must append the user-visible Audit
events around execution and reconciliation so the complete history remains
visible even when the receipt projection advances.

## Privacy and Failure Handling

Persistence includes stable local IDs, Connector/account IDs, the hash-based
idempotency key, normalized outcome and issue metadata, and the successful
external message reference. It does not include access or refresh tokens,
application secrets, cookies, raw API requests or responses, credential values,
or rejected payloads. The reply content remains in the already approved
ActionProposal and is not duplicated into the receipt.

Cancellation is checked before validation, reconciliation, and sending. Client
failures are converted into fixed typed outcomes without a raw cause. SQLite
errors are likewise normalized and cannot expose SQL, paths, content, or remote
data.

## Remaining Work

- Authorization-code/PKCE exchange composed with verified initial Keychain
  persistence, exclusive Connector ownership, Feishu operation HTTP, and
  runtime composition are still required; the system-Keychain reader,
  credential parser, refresh and user-info transports, and durable dispatch
  boundary alone are not an execution adapter.
- TD-208 now adds identity health, exact scope visibility, rate-limit state,
  and cursor diagnostics; execution still fails closed when its adapter reports
  missing authorization or scope. See
  [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).
- TD-209 now proves the injected-client local contract from Inbox through an
  edited Draft revision, approval, execution, receipt, restart verification, and Audit.
  The acceptance test completes the missing deterministic Audit trace; no
  automatic repair service exists. Product UI and real-account execution remain required for the live exit gate;
  see [Stage 2 Exit Gate](STAGE_2_EXIT_GATE.md).

## Verification

Synthetic end-to-end tests start with a Feishu message, Work Item, Persona,
ready-for-review Draft, preview proposal, and one-time approval. They cover one
successful send, exact idempotency-key reuse, restart recovery, post-send
network uncertainty, expired-approval reconciliation without resend, missing
scope, failed reconciliation without send, malformed response redaction,
terminal replay, closed handles, and an injected receipt/proposal rollback.
No real credential or external service is used.
