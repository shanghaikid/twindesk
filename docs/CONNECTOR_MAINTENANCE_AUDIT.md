# Connector Maintenance Audit Protocol

## Scope

SQLite Migration 8 introduces a Connector-neutral durability protocol for a
user-requested credential reconciliation and its business Audit. The Workbench
Feishu reconciliation runtime now uses this protocol around its existing local
Keychain comparison. The storage layer itself does not invoke a Connector,
read Keychain, repair a credential, contact a remote service, or expose a
browser action.

## Durable ordering

One maintenance attempt has a stable caller-generated operation ID and exactly
one Connector identity. The protocol uses two transactions around the effect:

1. `beginConnectorMaintenance()` atomically appends a fixed, Connector-scoped
   pending Audit record and inserts the pending operation.
2. The composition root may perform the separately authorized Connector effect
   outside the SQLite transaction.
3. `settleConnectorMaintenance()` atomically appends the fixed result Audit and
   stores `reconciled`, `still_required`, `cancelled`, or `failed` settlement.

There may be at most one pending credential reconciliation per Connector. An
exact request or settlement replay is a duplicate. Reusing an operation ID with
different request or result evidence fails closed. A terminal settlement is
immutable.

If the process stops after step 1, or after the Connector effect but before step
3, the operation remains explicitly pending. A fresh process can retrieve it
with `getPendingConnectorMaintenance()` and settle it from current durable
Connector evidence without repeating the effect. The protocol does not itself
decide that evidence. Workbench maps terminal Feishu journal evidence recorded
at or after the request to `reconciled`, unresolved crash-visible evidence to
`still_required`, and missing, older, or incompatible evidence to `failed`
while holding the Host lease.

## Audit shape and authority

The request Audit attributes the explicit action to the fixed local-user actor.
The result Audit is attributed to TwinDesk system evaluation. Both contain only
the operation type, stable operation ID, phase, result, canonical timestamp,
and `{ kind: "connector", id: connectorId }` reference. Summaries are fixed.

These records contain no account, application, principal, display name,
SecretReference, credential, scope, journal sequence, filesystem path, raw
Connector response, or hidden reasoning. An Audit record and its operation row
commit or roll back together. The protocol grants no Connector scope, Keychain
access, network authority, or external-write approval.

## Retention

Connector maintenance operations and their Connector-only Audit records have
no implicit Thread ownership. Unrelated Thread export omits them and Thread
deletion retains them. A future explicit Connector disconnect/deletion policy
must define their retention separately.

## Verification

Synthetic tests cover request/result atomicity, exact replay, competing pending
operations, identity and settlement conflicts, restart discovery, interrupted
result Audit repair, terminal immutability, malformed and hostile input,
payload-free errors, closed handles, schema migration, Thread export/deletion,
and absence of credential-identifying fields. Workbench tests additionally
cover request-before-Keychain ordering, successful settlement, restart repair,
zero Keychain reads during repair, historical-terminal rejection, authoritative
success over late cancellation, shared database lifecycle, default composition,
and Audit presentation. They perform no network or live-account operation.
