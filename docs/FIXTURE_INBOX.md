# Fixture-driven Inbox

TD-106 connects the Stage 1 product Inbox to durable TwinDesk projections
without connecting a real account or enabling an external write.

## Data flow

```text
synthetic definitions
  -> validated ExternalEvent / ExternalThread / WorkItem records
  -> idempotent TwinDesk SQLite ingestion and projections
  -> optional immutable synthetic routing AuditRecords
  -> Work Hub fixture presentation service
  -> loopback GET /api/inbox and /api/audit
  -> TwinDesk Web Inbox and Audit pages
```

`@twindesk/plugin-work-hub` owns fixture seeding and the presentation-safe read
model. `@twindesk/web` does not import SQLite or expose raw normalized event
payloads. The browser receives only Work Item fields needed by the page, a
synthetic source label, context completeness, source count, and optional
Persona display metadata. Account IDs and external object IDs are not returned.

## States and interaction

The fixture set contains one item in each Inbox state:

- `needs_reply`
- `needs_review`
- `waiting`
- `done`

Each tab requests `GET /api/inbox?state=<state>`. The response keeps counts for
all four states while returning items only for the selected state. Selecting an
item shows its summary, attention reason, Persona, synthetic source, context
status, and update time. The browser validates the version, counts, state,
identity metadata, context completeness, source count, canonical timestamp, and
item uniqueness before rendering. All API-derived strings are escaped before
insertion into the page.

For the Web shell, the same service idempotently seeds one synthetic routing
AuditRecord per fixture Work Item. `GET /api/audit` returns only category,
outcome, a safe actor label, summary, reference kinds, and time. It omits Audit
record IDs, referenced IDs, actor IDs, and details. The browser validates the
entire versioned response before rendering it. This is fixture evidence for
the local Audit Timeline, not a claim that a model Run or external action has
occurred.

The API is read-only. The existing server-wide `GET` and `HEAD` restriction
rejects mutation methods, and the UI explicitly states that fixture data cannot
perform an external write. Persona metadata remains identity and behavior only;
it grants no authority.

## Persistence and local startup

The exported fixture service accepts either an in-memory or file-backed
TwinDesk database. Seeding is idempotent, so opening the same file after restart
does not duplicate events or Work Items. The Web server defaults to in-memory
storage for isolated embedding and tests. The CLI uses the ignored local path
`.twindesk/twindesk.sqlite3` by default:

```sh
pnpm web:build
pnpm web:start
```

The server remains loopback-only. Use `--database <path>` to select another
local TwinDesk database and `--port <port>` to change the port.

## Limitations

- The service deliberately returns only the four stable fixture IDs, even if
  its database later contains non-fixture Work Items.
- The pages do not edit state, select Personas, create drafts, approve, or
  execute actions. Those behaviors belong to later tasks.
- Fixture timestamps and content are synthetic repository data. No company
  messages, credentials, or real external identifiers are included.
