# Durable Synchronization Cursors

## Scope

TD-104 adds the Work Hub persistence boundary for a Connector synchronization
batch. `@twindesk/storage-sqlite` stores normalized ExternalEvents and the
Connector's candidate cursor in one transaction. It does not store raw
Connector payloads, credentials, or SDK objects.

Standalone `ingestExternalEvents()` remains available for sources that do not
produce a cursor. A cursor-producing synchronization path must use
`commitConnectorSyncBatch()` instead of committing events and a checkpoint in
separate operations.

## Atomic Commit Contract

`TwinDeskDatabase.commitConnectorSyncBatch()` accepts an explicit Connector,
account, and stream identity, an event batch, and an optional candidate cursor.
It:

1. validates the complete request and all normalized records;
2. verifies that every event and the candidate cursor match the request
   identity;
3. begins a serialized `BEGIN IMMEDIATE` transaction;
4. performs idempotent event ingestion;
5. inserts or advances the candidate cursor;
6. commits both durable states together.

Validation, event conflict, cursor conflict, regression, SQLite failure, or
commit failure rolls back the entire transaction. A fetched candidate is not
durable merely because the Connector returned it.

An absent candidate returns `not_provided` and does not alter the stored
cursor. An empty event batch may still insert or advance a candidate because a
Connector can make progress without emitting a normalized event.

## Identity and Replay Semantics

A cursor has both a stable record ID and a unique Connector/account/stream
identity. A stored ID cannot be rebound to another stream, and a stream cannot
be rebound to another stable ID. Either conflict fails closed.

The exact same position and `committedThrough` watermark is an unchanged
replay. TwinDesk preserves the first durable `updatedAt` instead of replacing
it with a later observation time. A genuinely different checkpoint must have
a nondecreasing `updatedAt`. Once a `committedThrough` watermark exists, a
candidate cannot remove it or move it backward.

`position` is an opaque Connector value. TwinDesk cannot infer whether two
arbitrary positions are semantically ordered, so each Connector must emit
positions consistently and use `committedThrough` when it can provide a
source-time watermark. A future Connector-specific adapter may add stronger
ordering checks without changing this storage boundary.

## Recovery, Failure, and Privacy

`getConnectorCursor()` reads the checkpoint by Connector/account/stream after
a cold restart. Callers resume from only that durable value; an in-memory
candidate from an interrupted attempt must be discarded and fetched again.

`SyncCursorError` exposes only a bounded error code, optional input index, and
identity-mismatch category. It does not expose Connector or account values,
positions, event content, database paths, SQL text, or underlying SQLite error
messages. Domain validation diagnostics remain payload-free. The redaction and
retention constraints in [TwinDesk SQLite Storage](STORAGE_SQLITE.md) continue
to apply.

## Verification

`tests/sync-cursor.test.mjs` covers:

- atomic event and cursor persistence across cold restart;
- duplicate replay and preservation of the first durable timestamp;
- empty-batch advancement and event-only commits;
- Connector, account, and stream boundary validation;
- request accessor rejection without invoking the accessor;
- event conflicts, stable cursor identity conflicts, and watermark removal or regression;
- rollback when the cursor write is interrupted after event insertion;
- closed database handles and payload-free typed failures.
