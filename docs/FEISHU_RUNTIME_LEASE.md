# Feishu Runtime Lease

## Scope

TD-209 adds `FeishuRuntimeLeaseManager`, an OS-backed cross-process ownership
boundary for the Feishu Connector runtime. Before a Host starts Feishu polling,
credential refresh, diagnostics that consume rate capacity, or external writes,
it must acquire this lease and retain it for the complete Feishu runtime
lifetime.

The current boundary is intentionally Host-wide rather than account-wide. One
TwinDesk Host may operate all of the local user's configured Feishu accounts
under one lease, while a second Host cannot operate any Feishu account at the
same time. This conservative rule avoids split ownership during configuration
changes and credential rotation.

## Kernel Ownership

The manager binds one deterministic high TCP port on literal loopback
`127.0.0.1`. The endpoint is derived only from a permanent TwinDesk ownership
namespace; no account, application, principal, or credential identifier appears
in the address. That namespace is a cross-release safety identity, not a schema
version: future implementations must keep acquiring this endpoint while any
previously released build may run. Accepted connections are immediately closed
and carry no protocol or product data.

The listening socket remains referenced for the full callback lifetime. A
competing process receives `lease_unavailable` and never enters its runtime
callback. Normal callback completion or failure closes the socket. Abrupt
process death releases the kernel binding automatically, so recovery needs no
PID file, timeout, heartbeat, filesystem deletion, or stale-owner guess.

A different local application could already own the deterministic endpoint.
TwinDesk treats that indistinguishably from another Host and fails closed. It
does not probe, kill, or replace the owner. The user can retry after the owner
exits; automatic selection of another port would break cross-process agreement
and is therefore not allowed.

## Authority and Operation Guard

The lease is coordination, not authorization. It does not grant connector
scopes, select Bot or User identity, approve a proposal, validate target or
content, or replace the dispatch and OAuth rotation journals. Child Agents,
Personas, Workflows, and Teams cannot acquire broader authority through it.

`withLease()` validates a non-secret Feishu identity configuration, acquires the
kernel owner, checks ownership, invokes one callback, and releases in `finally`.
The callback receives only `assertHeld()`. Runtime composition must call that
guard immediately before each polling request, token refresh, or external
write. A lost lease produces `stop_connector`; completed external effects
remain governed by their existing uncertain-result and idempotency recovery
rules rather than being declared safe to repeat.

Cancellation before ownership is acquired returns a fixed payload-free error
and invokes no callback. Cancellation during the callback is handled by the
runtime and operation-specific cancellation signals; the lease stays held until
the callback actually unwinds, preventing another Host from overlapping an
operation that ignored or had not yet observed cancellation.

## Verification and Remaining Work

Synthetic tests use real loopback bindings to prove same-process and
cross-process exclusion, conservative exclusion across different configured
accounts, release after success and callback failure, payload-free invalid input
and cancellation, reacquisition after restart, and automatic kernel release
after a child Host is terminated with `SIGKILL`. They use no live Feishu account,
credential, Keychain item, or external network request.

The Workbench reply composition now holds this lease across durable approval,
User rotation, dispatch reservation, scope and credential checks, reply HTTP,
receipt, and Audit, with `assertHeld()` at the adapter's operation boundaries.
The User polling runtime separately proves one long-lived lease across
restart-safe page commits and bounded retry. Its production constructor creates
the OAuth/Keychain/HTTP search adapter only within that already-held lease.
These two compositions are not activated concurrently: the production Cordis
runtime must acquire the Host lease once and place polling, authorization,
recovery, diagnostics, and external writes beneath that owner instead of letting
each operation reacquire it. Remaining TD-209 work includes that shared
activation, hosted ingestion, and live-account acceptance.
