# Work Hub Action Execution Host

## Scope

`WorkHubActionExecutionHost` is the Connector-neutral Host boundary between a
durable approved proposal and a Connector-owned execution client. It owns the
ordering of approval consumption, execution start, durable dispatch
reservation, receipt persistence, and append-only Audit completion.

The Host accepts only an Approval ID and its exact proposal ID. It reads the
durable records, recomputes all approval bindings, and obtains the opaque
`ApprovedAction` only from `@twindesk/storage-sqlite`. A caller cannot supply an
identity, target, content, idempotency key, receipt, or authority context.

## Exclusive Ownership

Every operation runs inside an injected `withExclusiveOperation()` callback.
The ownership value is passed only to the injected Connector executor. For
Feishu, the composition root must implement this callback with
`FeishuRuntimeLeaseManager.withLease()` and pass its callback-owned
`FeishuRuntimeLease` to the reply adapter.

Failure or cancellation before ownership is acquired consumes no approval,
starts no execution, reserves no dispatch, and writes no Audit record. The Host
does not acquire a Connector lease itself and does not weaken Connector scope or
credential checks.

## Durable Order

The normal path is:

```text
acquire exclusive Connector ownership
  -> load exact proposal and approved ApprovalRecord
  -> consume the approval once and obtain ApprovedAction
  -> append the deterministic approval-consumption Audit record
  -> begin durable execution
  -> let the Connector executor request a durable dispatch reservation
  -> execute the Connector operation
  -> atomically persist receipt, proposal state, and dispatch settlement
  -> append the deterministic execution Audit record
```

The Connector executor receives only one Host callback for dispatch
reservation. It cannot treat Persona configuration, a proposal, or an in-memory
lease as approval evidence.

## Recovery and Audit

Approval consumption and its Audit append are separate transactions, but the
Host does not begin execution or expose the dispatch callback until that Audit
record is durable. If approval Audit append fails, restart repairs it first; an
approval that expired meanwhile remains non-executable.

Receipt persistence and execution Audit append are also separate transactions.
The receipt is authoritative for resend safety. If the process stops after a
receipt commits but before execution Audit completes, the next Host invocation
validates the exact durable approval/proposal/receipt bindings and appends only
the missing deterministic record. A terminal receipt is recoverable for Audit
after approval expiration and never invokes the Connector executor again.

For a retryable receipt, the Host repairs that attempt's Audit before allowing a
new execution. Each immutable execution Audit ID includes a digest of the
canonical persisted receipt, so a later same-key attempt creates a distinct
history record. The approval-consumption Audit remains one stable record.

Audit details retain only normalized action type, Connector and identity type,
outcome, retry disposition, and authority effect. They exclude proposal text,
targets, external message IDs, idempotency keys, credential references, tokens,
raw Connector payloads, and thrown adapter data.

## Verification

Synthetic SQLite tests prove:

- ownership failure and pre-start cancellation have no durable or external
  side effect;
- approval Audit failure blocks execution, repairs after restart, and cannot
  revive an approval that expired meanwhile;
- one dispatch reservation precedes one simulated external write;
- a receipt survives an Audit failure and restart;
- after approval expiration, Audit repair performs no second external write;
- `retry_same_key` first audits the failed attempt, then uses dispatch ordinal
  two and retains both execution Audit records;
- private thrown values do not enter Host errors.

## Remaining Work

The [Workbench Feishu Reply Runtime](WORKBENCH_FEISHU_REPLY_RUNTIME.md) now binds
this Host boundary to the real Feishu runtime lease, `FeishuReplyExecutor`, and
`FeishuReplyExecutionAdapter`. The binding passes a synthetic full-stack test;
it is not yet a hosted or live Connector. The User reply adapter now runs
durable token rotation under that same ownership callback before scope and send
checks. The Workbench Inbox now invokes this boundary only after a separate
approval and execution click, and its durable presentation restores after
refresh. Hosted ingestion or polling, credential-healthy model acceptance, and
a real authorized account acceptance run remain open.
