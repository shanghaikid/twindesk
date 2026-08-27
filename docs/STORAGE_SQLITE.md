# TwinDesk SQLite Storage

## Scope

`@twindesk/storage-sqlite` owns the local TwinDesk business database. It uses
the Node.js 24 built-in `node:sqlite` driver and does not add a native package
dependency. The package currently owns schema creation, forward migration,
database lifecycle, idempotent ExternalEvent ingestion, durable atomic
Connector cursors, Work Item projections, Inbox queries, and local Draft and
ActionProposal transitions, immutable business Audit records and timeline
queries, plus versioned Thread export and revision-bound deletion. Approval
decisions and external execution write paths begin in later tasks.

This database is not a Harness Session store. It never creates, updates, or
queries Harness Session tables, JSONL artifacts, or Session query indexes.

## File Identity and Open Policy

Every initialized database carries three independent identity signals:

- SQLite `application_id` `0x54574e44` (`TWND`);
- SQLite `user_version`, matching the latest applied schema migration;
- `twindesk_schema_migrations`, containing the migration name, SHA-256
  checksum, and application time for every applied version.

Opening fails closed when the file belongs to another application, an unowned
file already contains application objects, the schema is newer than the
running build, or migration history does not match the checked-in migrations.
An empty SQLite file and a `:memory:` database may be initialized. TwinDesk
does not adopt an existing Harness or arbitrary SQLite database.

The public `TwinDeskDatabase` handle intentionally does not expose the raw
SQLite connection. Later storage repositories will provide narrow,
transactional business operations instead of allowing callers to bypass
invariants.

## Connection Policy

`openTwinDeskDatabase()` configures:

- foreign keys enabled;
- extension loading disabled;
- double-quoted string literals disabled;
- SQLite defensive mode enabled;
- trusted schema disabled;
- full synchronous durability;
- WAL journaling for file-backed databases;
- a bounded lock timeout, five seconds by default.

The handle supports explicit and idempotent `close()` plus JavaScript explicit
resource management through `Symbol.dispose`.

## Forward Migration Protocol

Migrations are append-only and numbered consecutively. Opening a database:

1. verifies ownership and rejects a future schema version;
2. verifies names and SHA-256 checksums for every recorded migration;
3. applies each missing migration inside its own `BEGIN IMMEDIATE` transaction;
4. records migration history and advances `application_id` and `user_version`
   in the same transaction;
5. rolls back the entire migration on any failure.

There are no downgrade migrations and no recovery path that deletes a user's
database. A newer application build must add a new migration rather than edit
an already released migration.

## Schema Tables

| Area | Tables | Purpose |
|---|---|---|
| Migration metadata | `twindesk_schema_migrations` | Version and checksum verification |
| Immutable sources | `external_events` | Normalized, idempotent Connector events |
| Threads | `external_threads`, `thread_external_references`, `thread_events` | Stable source grouping |
| Inbox projection | `work_items`, `work_item_events` | Rebuildable Work Item state and source links |
| Projection inputs | `work_item_projection_bases`, `work_item_projection_base_events`, `work_item_user_actions` | Event-anchored bases and immutable explicit user actions |
| Draft and proposal state | `drafts`, `draft_creation_records`, `draft_state_transitions`, `action_proposals`, `action_proposal_creation_records`, `action_proposal_state_transitions` | Original requests, current local state, and immutable transition history |
| Policy | `approval_records` | Exact identity, target, content, expiry, decision, and one-time consumption bindings |
| Connector recovery | `connector_cursors` | Per-account, per-stream durable positions |
| Execution | `action_receipts` | Success, failure, or uncertain external results |
| Audit | `audit_records`, `audit_references` | User-visible business timeline and references |
| Retention | `thread_deletion_receipts` | Immutable hash-and-count-only deletion tombstones |

Every business table stores a version discriminator. `STRICT` tables, foreign
keys, uniqueness constraints, state checks, identity-to-target checks, approval
checks, JSON validity checks, and chronology checks enforce the invariants that
can be expressed safely in SQLite. External events and audit records cannot be
updated. They remain deletable so future explicit retention and Thread deletion
transactions can satisfy product deletion requirements.

Migration 2 adds versioned Work Item projection inputs and transactionally
backfills existing version 1 Work Items and event links. It does not delete or
recreate the existing projection, Thread, event, Draft, or audit tables.

Migration 3 adds versioned, immutable Draft and ActionProposal creation
snapshots plus their local transition histories. Existing rows are snapshotted
at their current state during migration; new writes preserve their true initial
state. The transition API updates history and current state in one transaction.
See [Draft and ActionProposal Transitions](DRAFT_ACTION_TRANSITIONS.md).

Migration 4 adds the Audit reference lookup index, prevents Audit reference
updates, and rejects invalid timestamps before insert. The narrow Audit API
validates local reference existence, ownership, and chronology before its
transaction commits. Harness Session, Run, and Tool-call payloads remain in
the separate Harness Session store; TwinDesk persists only their opaque IDs as
business timeline links. See [Local Audit Timeline](AUDIT_TIMELINE.md).

Migration 5 adds immutable Thread deletion receipts. It stores only SHA-256
request and Thread identity digests, the exact confirmed revision, a request
timestamp, and count-only results. A retained digest prevents silent projection
resurrection and makes deletion retries durable without retaining the raw
Thread ID or business content. See
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md).

## Privacy and Retention Review

The schema contains no token, API key, cookie, private-key, or credential
column. Connector credentials must remain in Keychain or a dedicated encrypted
secret store. The versioned domain `SecretReference` can identify such a store
without containing its value, but TD-110 adds no credential table to this
business database. Future Connector configuration may persist only the opaque
reference.

The following fields may contain synthetic or authorized company/personal
content and must pass through the TD-110 shared redactor before diagnostic
logging or export: normalized event JSON, Work Item text, draft content and
rationale, target display names, receipt issue summaries, and audit summaries
or details. Diagnostic policies remove these business-content fields; an
authorized export may retain them while still removing credentials, secret
locators, and hidden reasoning. Version 1 stores normalized fields rather than
raw Connector payloads. `exportThread()` applies that policy to the complete
authorized aggregate. `deleteThread()` removes Thread-owned records and
orphaned events in one transaction while retaining shared events, account-level
Connector cursors, and a content-free deletion tombstone. Harness Session data
remains outside this database and is not modified or claimed deleted.

## Verification

`tests/storage-sqlite.test.mjs` verifies:

- fresh initialization, expected tables, file identity, WAL mode, and integrity;
- restart recovery without duplicate migration application or data loss;
- rejection of a Harness-like or otherwise unowned SQLite file without mutation;
- rejection of future schema versions and tampered migration history;
- rollback of an interrupted or conflicting migration;
- immutable external events and safe open-option validation.

[External Event Ingestion](EVENT_INGESTION.md) and
[Durable Synchronization Cursors](SYNC_CURSORS.md) record the implemented write,
replay, and restart semantics and their tests. [Work Item Projections](WORK_ITEM_PROJECTIONS.md)
records rebuild and Inbox-query behavior. [Local Audit Timeline](AUDIT_TIMELINE.md)
records immutable append, cross-store reference, and query behavior.
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md) records aggregate
contents, idempotent deletion, tombstone behavior, and the explicit retention
boundary.
