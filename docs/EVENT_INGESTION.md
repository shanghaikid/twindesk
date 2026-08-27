# External Event Ingestion

## Scope

TD-103 adds idempotent, transactional ExternalEvent ingestion to
`@twindesk/storage-sqlite`. It accepts normalized TwinDesk records, validates
every record again at the storage boundary, and writes no Connector raw
payloads or credentials.

Standalone ingestion deliberately does not advance a Connector cursor. Work
Hub synchronization must use the atomic boundary documented in
[Durable Synchronization Cursors](SYNC_CURSORS.md); a successful Connector
fetch alone does not make a candidate cursor durable.

## Batch Contract

`TwinDeskDatabase.ingestExternalEvents()` returns one disposition for every
input record:

| Disposition | Meaning |
|---|---|
| `inserted` | No stored event has the same stable record ID or idempotency key |
| `duplicate` | The stable identities and immutable business content match |
| typed conflict | An ID or idempotency key maps to different immutable business content; the entire batch is rolled back |

All input records are parsed before SQLite begins a transaction. The write then
uses `BEGIN IMMEDIATE`, so concurrent writers cannot both pass the deduplication
check. A validation error, identity conflict, constraint failure, lock failure,
or interrupted commit leaves no subset of the batch durable.

## Replay Semantics

Duplicate comparison covers schema version, record ID, idempotency key, source
identity and timestamp, event type, source occurrence time, context state, and
normalized content. Object key order and partial-context missing-item order do
not affect equality. A replay may carry a later local `receivedAt`; TwinDesk
keeps the timestamp from the first durable arrival instead of treating that
local observation difference as a new source event.

Events do not need to arrive in source-time order. SQLite stores the immutable
timestamps and future projections must order or rebuild from those timestamps
rather than insertion order.

## Failure and Privacy Behavior

`EventIngestionError` exposes a bounded code, input index, and conflicting
stable-key category (`id`, `idempotency_key`, or `both`). It never includes the
actual stable key, normalized content, source payload, SQLite path, or SQL error
text. Malformed incoming domain records retain the existing payload-free domain
validation diagnostics.

The implementation stores canonical normalized JSON only. The privacy and
retention constraints in [TwinDesk SQLite Storage](STORAGE_SQLITE.md) continue
to apply. The TD-110 shared redactor now removes normalized business content
from diagnostics and credentials from every boundary; this ingestion module
does not itself emit a diagnostic or export payload.

## Verification

`tests/event-ingestion.test.mjs` covers:

- duplicates inside one batch;
- replay after a cold database restart;
- semantic replay with reordered JSON and a later local receive time;
- newer-before-older source events;
- ID and idempotency-key conflicts;
- full rollback when a later batch item conflicts;
- full rollback after an injected SQLite write interruption;
- validation before transaction start;
- closed database handles and payload-free diagnostics.
