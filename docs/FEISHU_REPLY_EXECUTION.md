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

The repository contains production Keychain, credential rotation, scope-probe,
durable dispatch, and bounded reply HTTP primitives. The
`FeishuReplyHttpClient` sends one fixed-endpoint plain-text reply and returns
only its remote message ID and timestamp. It deliberately does not implement
the execution client's reconciliation method because Feishu history does not
expose the request UUID. `FeishuReplyExecutionAdapter` now composes that
send-only boundary with an already-held runtime lease, exact Bot/User scope
probes, Keychain credential callbacks, and Bot tenant-token acquisition. The
Connector-neutral Work Hub Host owns approval, dispatch, receipt, and Audit
ordering under exclusive ownership. The Workbench composition root now binds
these boundaries under the real runtime lease. See
[Feishu Reply HTTP Client](FEISHU_REPLY_HTTP_CLIENT.md) and
[Feishu Reply Execution Adapter](FEISHU_REPLY_EXECUTION_ADAPTER.md) and
[Work Hub Action Execution Host](ACTION_EXECUTION_HOST.md) and
[Workbench Feishu Reply Runtime](WORKBENCH_FEISHU_REPLY_RUNTIME.md).

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

## Reconciliation and First Dispatch

When the injected client supports an exact idempotency-key lookup, `execute()`
retains the original order:

```text
validate exact ApprovedAction
  -> reconcile the exact idempotency key
     -> found: return succeeded without sending
     -> confirmed absent: send once with the same key
     -> unavailable or malformed: return uncertain, do not send
```

Feishu reply history does not expose the request `uuid`, so the production HTTP
primitive cannot truthfully implement that lookup. `reconcile` is therefore an
optional client capability. For a send-only client, `execute()` skips no safety
boundary: it must durably create the first dispatch reservation before calling
`send()`. If any reservation already exists, it sends nothing. An unsettled or
uncertain reservation stays blocked, and explicit `reconcile()` returns a fixed
`feishu_reconciliation_unsupported` uncertain receipt rather than inventing an
`absent` result.

This means a crash after reservation but before the HTTP request can require
manual recovery, and a crash after a successful HTTP request but before receipt
persistence cannot be confirmed automatically. Both cases prefer a visible
false-positive uncertainty over a duplicate external reply. A durably settled
`rate_limited` rejection remains the sole automatic same-key retry path after a
Feishu reply call starts because it explicitly proves that Feishu did not
accept that call. Proven pre-reply preflight failures may also retry the same
key.

A rate limit that is known to reject the request produces `failed` with
`retry_same_key`. Authorization, missing scope, required reauthorization,
uncertain credential rotation, or explicit rejection produces `failed` with
`do_not_retry`. A network failure, unknown adapter failure,
identity-inconsistent response, or malformed post-send response produces
`uncertain` with `reconcile_first`. Its error is retryable only when exact
reconciliation is available; otherwise an operator or future exact platform
mechanism must resolve it. All issue codes and summaries are bounded,
normalized values and never contain a response payload.

A production preflight failure that proves reply HTTP was never reached also
produces `failed` with `retry_same_key`. This covers temporarily unavailable
scope evidence, a pending or pre-reservation-unavailable User rotation, or
lease loss before reply HTTP. A required rotation is attempted under the lease;
its uncertain or reauthorization-required outcomes are terminal instead. This
is distinct from post-POST network ambiguity.

The optional client `prepare()` phase runs after exact reconciliation but
before durable reply dispatch reservation. The production adapter uses it only
for lease-held User credential rotation. A process stop during OAuth rotation
therefore leaves no false-positive reply dispatch; restart follows the separate
rotation journal before a reply reservation can exist.

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
expiration, the recovered capability is accepted by exact `reconcile()` but
rejected by `execute()`: an existing uncertain result can still be inspected
when the adapter supports lookup, while an expired approval cannot authorize a
new send. A send-only adapter reports reconciliation as unsupported.

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

- Authorization-code/PKCE exchange through verified initial Keychain persistence
  and the exclusive Host lease pass synthetic contracts. The send-only reply
  adapter now composes the system-Keychain reader, parser, concrete scope probes,
  tenant-token acquisition, and reply HTTP primitive while requiring the Host
  lease to remain held. The Connector-neutral Host operation composes
  approval consumption, execution start, durable dispatch, receipt settlement,
  and Audit completion; the Workbench composition root now binds the two
  boundaries. See [Feishu Reply Execution Adapter](FEISHU_REPLY_EXECUTION_ADAPTER.md),
  [Work Hub Action Execution Host](ACTION_EXECUTION_HOST.md), and
  [Workbench Feishu Reply Runtime](WORKBENCH_FEISHU_REPLY_RUNTIME.md).
- Fixed Bot and User reply scope policies gate a fresh identity-bound
  observation before the adapter re-resolves its actual send credential. See
  [Feishu User Credential Scope Probe](FEISHU_USER_CREDENTIAL_SCOPE_PROBE.md)
  and [Feishu Bot Keychain Scope Probe](FEISHU_BOT_KEYCHAIN_SCOPE_PROBE.md).
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
successful send, exact idempotency-key reuse, send-only first dispatch,
send-only restart blocking, explicit unsupported reconciliation, safe same-key
rate-limit retry, hostile capability access, restart recovery, post-send network
uncertainty, expired-approval reconciliation without resend, missing scope,
failed reconciliation without send, malformed response redaction, terminal
replay, closed handles, and an injected receipt/proposal rollback. No real
credential or external service is used.
