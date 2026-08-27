# Work Item Projections

## Scope

TD-105 adds the storage and query boundary for the local Work Inbox. Work Hub
derives a versioned ExternalThread and WorkItem from normalized ExternalEvents,
then calls `TwinDeskDatabase.putWorkItemProjection()`. SQLite validates that
every referenced source event is already durable and that its stable source
identity appears in the Thread before committing the projection.

This task does not define Connector-specific routing or decide which arbitrary
event requires attention. TD-106 supplies the first fixture routing path, and
later Connector plugins remain responsible for normalized event content. The
projection boundary never reads raw Connector payloads or credentials.

## Rebuild Model

SQLite separates three layers:

1. immutable ExternalEvents are the source records;
2. `work_item_projection_bases` store the latest versioned Work Hub projection
   anchored to those event IDs, while `work_item_user_actions` store explicit
   user changes in strict revision order;
3. `work_items` and `work_item_events` are the current Inbox projection.

`rebuildWorkItemProjection()` recreates layer 3 in place from the durable base
and actions. It does not delete the Work Item, so future Draft, proposal, and
audit foreign-key relationships remain intact. Replaying an exact base is
unchanged even when object fields arrive in another order. Stable Thread and
Work Item identities cannot be rebound, timestamps cannot regress, and a newer
base cannot remove an already associated source event, reference, or source
timestamp. A Thread reference timestamp must cover the timestamp retained by
each linked durable event and cannot move backward.

An event-derived base supersedes actions that occurred before its `updatedAt`.
Actions at or after that timestamp apply in contiguous revision order. This
allows a newer incoming message to reopen an item previously marked Done while
preserving the user-action history. Supported version 1 actions are:

- `set_inbox_state` for Needs reply, Needs review, Waiting, or Done;
- `select_persona` for an explicit Persona choice;
- `clear_persona` to return to event-derived routing.

Persona selection records identity and routing intent only. It grants no model,
Skill, Tool, Connector, scope, or external-write authority.

## Inbox Query Contract

`getWorkItem()` returns one deeply immutable domain record.
`queryInbox()` accepts an optional non-empty state filter, a limit from 1 to
100, and an optional keyset cursor. Results order by the actual timestamp value
descending and then stable Work Item ID ascending. Timestamp comparison uses
SQLite date semantics rather than raw text order, so timestamps with no
fractional seconds and timestamps with one to three fractional digits paginate
consistently.

Each Work Item read and Inbox page uses one SQLite read transaction, so the row
and its event associations come from the same snapshot even while background
synchronization is committing another projection.

The page cursor contains only the last returned `updatedAt` and Work Item ID.
Queries reject unknown fields, duplicate states, malformed cursors, accessors,
and closed database handles with payload-free typed errors.

## Migration, Failure, and Recovery

Forward migration 2 creates the projection-base and user-action tables, then
copies existing Work Items and event links into bases in the same migration
transaction. It never asks the user to delete a database. A write interruption,
missing source event, source mismatch, identity conflict, stale projection, or
action conflict rolls back the entire Thread/base/current-projection change.

An exact action retry is a duplicate. A reused action ID or revision with
different content is a conflict. New actions must use the next revision and
cannot precede the latest event-derived base or previous action.

## Privacy and Retention Review

Titles, summaries, attention reasons, Persona IDs, Thread subjects, and source
references may contain authorized company or personal data. They remain local
business data. The TD-110 diagnostic policies redact these fields; an
authorized model-context or export policy may retain required business text
while still removing credentials, secret locators, and hidden reasoning. Error
objects expose only bounded codes and generic messages, never identifiers or
content. This projection module emits no diagnostic or export payload. TD-111
must delete projection bases and user actions as part of the same explicit
Thread-retention transaction; this task does not claim retention or export is
complete.

## Verification

`tests/work-item-projection.test.mjs` and `tests/storage-sqlite.test.mjs` cover:

- exact replay, reordered fields, cold restart, and immutable results;
- durable event and Thread-reference validation;
- user-action replay, revision and identity conflicts, and chronology;
- a newer event-derived base superseding an older Done action;
- repair of damaged current rows and event links from durable inputs;
- rollback after an injected projection write interruption;
- chronological filtering and keyset pagination across timestamp precision;
- closed handles, strict request validation, and payload-free failures;
- version 1 to version 2 migration and projection-base backfill.
