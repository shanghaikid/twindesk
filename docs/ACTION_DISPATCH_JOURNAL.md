# Durable Action Dispatch Journal

## Purpose

TwinDesk must not infer that an external write did not happen merely because a
process stopped before its `ActionReceipt` was persisted. The version 1 action
dispatch journal closes that local ambiguity window for Connector executors.

The Feishu reply executor reconciles first when its client exposes an exact
idempotency-key lookup. Feishu reply history does not expose request `uuid`, so
a send-only client instead relies on this journal as its first-dispatch proof.
Immediately before any client may call `send()`, it must obtain a durable
reservation for the exact approved action. If no reservation coordinator is
installed, the reservation fails, or any unretryable reservation already
exists, the executor does not send and returns a normalized `uncertain`
receipt.

## Persistence Contract

SQLite migration 6 adds `action_dispatches`. Each row records:

- the stable execution-attempt ID and monotonically increasing dispatch
  ordinal;
- the exact proposal, Connector, account, and idempotency-key bindings;
- the trusted local reservation timestamp; and
- an optional normalized settlement copied from the current `ActionReceipt`.

`reserveActionDispatch()` runs in an immediate transaction. It revalidates the
durable consumed approval, proposal bindings, `executing` state, approval
lifetime, and trusted clock before inserting the next row. A new ordinal is
allowed only when there is no earlier dispatch or the latest dispatch has a
durable `failed` settlement with `retry_same_key`. An unsettled, uncertain,
successful, or terminally failed dispatch returns `blocked` and cannot authorize
another network call.

`recordActionExecutionReceipt()` updates the receipt projection, proposal
state, and latest dispatch settlement in one transaction. An interrupted write
therefore cannot leave a receipt or terminal proposal state without the matching
dispatch settlement. Dispatch identity fields and reservation time cannot be
updated.

## Restart and Uncertain Results

After restart, `getLatestActionDispatch()` restores the latest durable evidence.
If a process stopped after reservation but before the remote result and receipt
were durable, a subsequent execution cannot reserve another send. A client with
exact lookup may reconcile and settle a remote match as success. A send-only
client reports reconciliation as unsupported, and absent or unavailable exact
evidence remains uncertain.

This is deliberately conservative: a crash after reservation but before the
HTTP request can leave a false-positive uncertain dispatch. That may require
user-visible recovery rather than an automatic resend. Preventing a duplicate
external write is more important than silently retrying an unproven result.

## Export, Deletion, and Privacy

Thread export includes versioned dispatch records. Thread deletion counts and
deletes them through the ActionProposal foreign-key boundary. Deletion receipts
created before migration 6 remain readable and report zero dispatch rows.

The journal stores no message content, raw HTTP request or response, credential
reference, credential value, principal ID, token, cookie, or hidden reasoning.
It contains stable local IDs, Connector/account IDs, the opaque idempotency key,
timestamps, and normalized settlement state. Normal export redaction still
applies.

## Current Limits

- The journal is Connector-neutral storage, while only the Feishu reply
  executor currently consumes the reservation callback.
- Production composition must pass `reserveActionDispatch()` through the
  executor callback. The default without that callback is fail-closed.
- The Workbench composition root now binds the lease-held credential, scope,
  token, and reply HTTP client to the Connector-neutral Host operation under
  the actual Feishu lease. It still must include User rotation. Synthetic
  composition does not make this durability evidence a live-account guarantee.
- User-visible recovery controls remain required for the complete Stage 2
  experience.
