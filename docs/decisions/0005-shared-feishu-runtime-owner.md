# ADR 0005: Shared Feishu Runtime Owner

- Status: Accepted
- Date: 2026-09-03
- Decision owner: TwinDesk maintainers
- Tracker: TD-209

## Context

The production-shaped User polling runtime holds the exclusive Feishu Host
lease for its full supervised run. Starting it beside OAuth authorization,
reauthorization, reconciliation, diagnostics, or reply compositions that each
acquire the same kernel endpoint would make those operations correctly exclude
one another. Disabling that cross-process lease or giving polling a separate
lease identity would permit two TwinDesk processes to use the same Connector
credentials concurrently.

## Decision

The Cordis Feishu lifecycle acquires the existing kernel-backed runtime lease
once for the configured identity. It creates a shared manager view bound to the
exact normalized identity configuration and passes that view to User polling
and every Web-composed OAuth, reconciliation, and reply operation.

The shared manager never binds another endpoint and grants no authority. Every
borrower must still provide the exact configuration and run its existing
identity, scope, approval, idempotency, recovery, and lease assertions. A
different configuration, a cancelled request, lease loss, or work submitted
after shutdown fails closed.

Owner shutdown stops accepting new callbacks, waits for current callbacks to
finish, and only then releases the kernel lease. Cordis therefore cancels and
awaits polling, closes the Web server and its active operations, closes the
polling database handle, and finally closes the owner.

Internal callbacks may overlap while sharing the same process owner. This lease
is a cross-process ownership boundary, not an in-process mutex. Durable OAuth
reservations, ActionProposal approval and dispatch state, SQLite transactions,
scope checks, and idempotency rules remain responsible for operation-level
coordination.

## Consequences

- Polling no longer blocks the same Cordis Host's approved reply and OAuth
  recovery paths by attempting a second kernel acquisition.
- A competing TwinDesk process remains excluded for the complete active Cordis
  Feishu lifecycle.
- The owner is bound to one exact identity snapshot. Product-mediated identity
  creation or replacement reconstructs the lifecycle before new delegated work.
- Polling is enabled only by a Host-supplied tenant key and an existing User
  identity at Cordis startup. It does not infer tenant identity from browser
  data.
- A terminal polling failure stays stopped until an explicit successful product
  Settings, authorization, reauthorization, or reconciliation operation requests
  refresh. Direct out-of-process file or Keychain changes require a Host restart.
- This decision does not prove a live Feishu credential, remote message search,
  or reply.

## Verification

Synthetic tests prove one parent acquisition, exact-configuration delegation,
concurrent callback draining, cancellation, hostile-option rejection, no new
work after close, and idempotent release. Cordis tests persist a synthetic User
identity, observe one polling page through the concrete adapter composition,
and verify one acquisition plus normal release. The separate real lease suite
retains cross-process exclusion, restart, and process-death coverage. No live
credential or external request is used.
