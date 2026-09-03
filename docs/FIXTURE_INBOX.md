# Fixture-driven Inbox

TD-106 connects the Stage 1 product Inbox to durable TwinDesk projections
without connecting a real account or enabling an external write.

## Data flow

```text
synthetic definitions
  -> validated ExternalEvent / ExternalThread / WorkItem records
  -> idempotent TwinDesk SQLite ingestion and projections
  -> optional immutable synthetic routing AuditRecords
  -> optional exact Persona mapping and deterministic ready_for_review Drafts
  -> optional immutable synthetic Draft AuditRecords
  -> Work Hub presentation service over every durable Work Item
  -> loopback GET /api/inbox and /api/audit
  -> TwinDesk Web Inbox and Audit pages
```

`@twindesk/plugin-work-hub` owns fixture seeding and the presentation-safe read
model. The read model now pages every durable Work Item, including normalized
Feishu items, rather than matching only the four fixture IDs. `@twindesk/web`
does not expose raw normalized event payloads. The browser receives only Work
Item fields needed by the page, a minimized synthetic or Feishu source label,
context completeness, source count, and optional Persona display metadata.
Account IDs and external object IDs are not returned.

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
the local Inbox → Persona → Draft → Audit path, not a claim that a model Run,
approval, Connector execution, or external action has occurred. The Web shell
enables four routing AuditRecords plus two Persona-attributed Draft
AuditRecords.

The Inbox API is read-only. Other product endpoints implement separately
CSRF-bound Draft, proposal, approval, and execution states. Persona metadata
remains identity and behavior only; it grants no authority.

## Persistence and local startup

The exported fixture service accepts either an in-memory or file-backed
TwinDesk database. Seeding is idempotent, so opening the same file after restart
does not duplicate events, Work Items, Drafts, or Audit records. If a Draft
insert sequence or Draft Audit append is interrupted, reopening repairs the
missing records without duplicating the already durable Drafts. The Web server defaults to
in-memory storage for isolated embedding and tests. The CLI uses the ignored
local path `.twindesk/twindesk.sqlite3` by default:

```sh
pnpm web:build
pnpm web:start
```

The server remains loopback-only. Use `--database <path>` to select another
local TwinDesk database and `--port <port>` to change the port.

## Limitations

- Fixture definitions provide richer synthetic context labels. Non-fixture
  Work Items receive a minimized source label and explicit partial-context
  presentation until a bounded context projection is composed.
- Draft, proposal, approval, and execution controls remain separate Host-owned
  endpoints; listing a durable Work Item grants none of those capabilities.
- Fixture Drafts do not invoke a model or Harness Run and have no Session or Run
  association. Real Persona execution remains later work.
- Fixture timestamps and content are synthetic repository data. No company
  messages, credentials, or real external identifiers are included.
