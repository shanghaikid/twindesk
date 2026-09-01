# Thread Export and Deletion

## Scope

TD-111 implements authorized export and explicit deletion for one selected
Thread in the TwinDesk business store. The operations are narrow methods on
`TwinDeskDatabase`; callers do not receive a raw SQLite handle.

This feature does not modify the separate Harness Session store. A TwinDesk
deletion removes opaque Session, Run, and Tool-call links from Drafts and Audit
records, but it does not claim that Harness JSONL records or derived Session
indexes were deleted. Cross-store Session retention and deletion require a
future coordinator behind the Harness adapter.

## Versioned Export

`exportThread()` accepts an exact version 1 `thread_export_request`. It reads a
consistent SQLite snapshot containing:

- the Thread, normalized ExternalEvents, and external references;
- current Work Items, event-derived projection bases, and immutable user
  actions;
- Drafts, ActionProposals, their creation snapshots, and transition histories;
- ApprovalRecords and ActionReceipts;
- related immutable business Audit records, including opaque Harness
  identifiers referenced by those records.

The returned version 1 `thread_export` document always passes through the
shared `exports` redaction policy before leaving the storage boundary. The
policy removes credential fields, SecretReference locators, supplied in-memory
secret values, recognizable inline credentials, and hidden reasoning while
retaining authorized business content. Callers that have resolved credentials
in memory must supply those exact values through `knownSecrets`; the values are
never persisted or returned. Export authorization remains a product policy and
UI responsibility—calling the redactor alone does not authorize disclosure.

An Audit record spanning another Thread makes export fail closed instead of
leaking the other Thread. New Audit writes are also rejected when their Work
Item references span multiple Threads.
Connector-only maintenance Audit records have no implicit Thread ownership, so
they are neither exported with nor deleted alongside an unrelated Thread.
Their versioned maintenance-operation rows are retained by the same rule.

## Revision-Bound Deletion

`deleteThread()` accepts an exact version 1 `thread_deletion_request` with a
request identity, selected Thread ID, expected `updatedAt`, and request time.
The expected revision prevents a stale confirmation from deleting a Thread
that changed after the user reviewed it.

One `BEGIN IMMEDIATE` transaction:

1. recognizes a durable retry or rejects an idempotency conflict;
2. verifies the Thread and exact revision;
3. calculates Thread-owned Audit records and events that will become orphaned;
4. deletes related Audit records;
5. deletes the Thread, cascading Work Items, projection inputs, user actions,
   Draft and ActionProposal histories, approvals, and receipts;
6. deletes only ExternalEvents with no remaining Thread or Work Item owner;
7. stores an immutable deletion receipt and commits all changes together.

An interruption rolls the entire operation back. An exact retry after restart
returns `duplicate`; a new request for an already-deleted Thread returns
`already_deleted`. The receipt stores SHA-256 request and Thread identity
digests, the confirmed revision, request timestamp, and count-only results. It
contains no raw Thread ID, source reference, business content, credential, or
Harness identifier.

## Retention Policy

`THREAD_RETENTION_POLICY_V1` records the implemented behavior:

| Data | Behavior after Thread deletion |
|---|---|
| Thread-owned TwinDesk records | Deleted atomically |
| ExternalEvent used only by the selected Thread | Deleted |
| ExternalEvent still referenced by another Thread or Work Item | Retained |
| Account/stream Connector cursor | Retained as a synchronization checkpoint |
| Connector-only maintenance Audit | Retained unless an explicit future Connector retention action removes it |
| Connector maintenance operation journal | Retained with its request/result Audit for restart repair |
| TwinDesk Audit records owned by the Thread | Deleted |
| Opaque Session, Run, and Tool-call links in TwinDesk | Deleted with their owning records |
| Harness Session data | Separate store; not modified or claimed deleted |
| Deletion receipt | Hashes, timestamps, and counts retained without raw identity or content |

The retained Thread digest acts as a tombstone. A normal projection cannot
silently recreate the deleted Thread; restoration requires a future explicit
user flow. Retaining the Connector cursor also prevents normal incremental
sync from rewinding merely because local business data was deleted. Deletion
does not reverse an external action that already succeeded.

## Verification

Synthetic tests cover complete and redacted exports, hidden-reasoning removal,
all persisted Thread-owned record classes, shared-event retention, orphan-event
deletion, cursor retention, revision conflicts, hostile accessors, interrupted
transaction rollback, closed handles, immutable hash-only receipts, restart
replay, tombstone enforcement, and forward migration from earlier databases.
