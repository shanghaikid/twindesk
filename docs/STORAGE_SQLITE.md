# TwinDesk SQLite Storage

## Scope

`@twindesk/storage-sqlite` owns the local TwinDesk business database. It uses
the Node.js 24 built-in `node:sqlite` driver and does not add a native package
dependency. The package currently owns schema creation, forward migration, and
database lifecycle only. Repository writes and queries begin in TD-103.

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

## Version 1 Tables

| Area | Tables | Purpose |
|---|---|---|
| Migration metadata | `twindesk_schema_migrations` | Version and checksum verification |
| Immutable sources | `external_events` | Normalized, idempotent Connector events |
| Threads | `external_threads`, `thread_external_references`, `thread_events` | Stable source grouping |
| Inbox projection | `work_items`, `work_item_events` | Rebuildable Work Item state and source links |
| Draft and policy | `drafts`, `action_proposals`, `approval_records` | Persona drafts and exact approval bindings |
| Connector recovery | `connector_cursors` | Per-account, per-stream durable positions |
| Execution | `action_receipts` | Success, failure, or uncertain external results |
| Audit | `audit_records`, `audit_references` | User-visible business timeline and references |

Every business table stores a version discriminator. `STRICT` tables, foreign
keys, uniqueness constraints, state checks, identity-to-target checks, approval
checks, JSON validity checks, and chronology checks enforce the invariants that
can be expressed safely in SQLite. External events and audit records cannot be
updated. They remain deletable so future explicit retention and Thread deletion
transactions can satisfy product deletion requirements.

## Privacy and Retention Review

The schema contains no token, API key, cookie, private-key, or credential
column. Connector credentials must remain in Keychain or a dedicated encrypted
secret store; future tables may persist only opaque secret references.

The following fields may contain synthetic or authorized company/personal
content and therefore require the TD-110 shared redactor before diagnostic
logging or export: normalized event JSON, Work Item text, draft content and
rationale, target display names, receipt issue summaries, and audit summaries
or details. Version 1 stores normalized fields rather than raw Connector
payloads. TD-111 will define deletion, export, and retention transactions; the
schema alone does not claim those behaviors are implemented.

## Verification

`tests/storage-sqlite.test.mjs` verifies:

- fresh initialization, expected tables, file identity, WAL mode, and integrity;
- restart recovery without duplicate migration application or data loss;
- rejection of a Harness-like or otherwise unowned SQLite file without mutation;
- rejection of future schema versions and tampered migration history;
- rollback of an interrupted or conflicting migration;
- immutable external events and safe open-option validation.

TD-103 and TD-104 must add transactional tests for duplicate and out-of-order
events, replay, interrupted event writes, and cursor advancement only after all
preceding events are durable.
