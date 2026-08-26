# TwinDesk Architecture

## 1. Architecture Decision

The first TwinDesk version uses DeepSeek Harness as its replaceable Agent
Runtime and extends Host capabilities through formally installed Cordis
plugins. TwinDesk owns a standalone local Web product shell; Harness Web UI and
the Stage 0 Client plugin remain diagnostic surfaces only. [ADR 0002](decisions/0002-twindesk-owned-product-web-shell.md)
supersedes the earlier upstream-dependent UI path. TwinDesk will not fork or
patch Harness for product navigation, and all domain logic stays outside the
Harness repository.

DeepSeek Harness is replaceable infrastructure, not the TwinDesk domain model.

## 2. System Boundary

```text
Feishu API / Events       Jira API / Webhooks
          │                         │
          ▼                         ▼
   Feishu Connector          Jira Connector
          └──────────┬──────────────┘
                     ▼
             Work Hub Service
        normalize / dedupe / route / sync
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   TwinDesk SQLite        DeepSeek Harness
  inbox/audit/cursors     sessions/agents/tools
          │                     │
          └──────────┬──────────┘
                     ▼
           TwinDesk Work Hub API
                     │
                     ▼
          TwinDesk-owned Web UI
          inbox / drafts / approvals / traces
```

## 3. Plugin and Package Boundaries

### `@twindesk/domain`

Pure TypeScript domain types and rules with no Harness, Cordis, Connector, UI,
or model SDK dependency:

- ExternalEvent
- WorkItem
- ExternalThread
- Draft
- ActionProposal
- ApprovalRecord
- ConnectorCursor
- AuditRecord

Every persisted business record starts with `kind` and `schemaVersion: 1`.
`@twindesk/domain` exposes boundary parsers that reject unknown fields,
unsupported versions, invalid UTC timestamps, duplicate stable references,
non-finite JSON values, accessor properties, and internally inconsistent
identity, target, approval, or partial-context data. Parsed records are deeply
immutable. Validation errors identify only the rejected field path and
expectation; they do not serialize the input value. State transition functions
remain TD-108 work rather than being implied by these record shapes.

### `@twindesk/harness-adapter`

The replaceable runtime boundary:

- owns all source imports from Harness and Cordis packages;
- pins and probes the public upstream contracts used by TwinDesk;
- exports only TwinDesk-owned compatibility types and errors;
- prevents generated declarations from exposing upstream package types;
- contains no TwinDesk domain or Connector business logic.

Profile Bundle manifests may declare pinned Harness packages as installation
dependencies, but TwinDesk source code outside this adapter must not import
their runtime or types directly.

### `@twindesk/storage-sqlite`

The TwinDesk business database:

- schema and migrations;
- a distinct SQLite application ID, schema version, and checksummed migration history;
- Inbox and Thread queries;
- idempotent external event writes;
- synchronization cursors;
- drafts, approvals, and execution results;
- data deletion and export.

It never writes directly into Harness Session artifacts or derived Session
query indexes. Opening an unowned or Harness-shaped SQLite file fails closed;
forward migrations are transactional and never rely on deleting a user's
database. See [TwinDesk SQLite Storage](STORAGE_SQLITE.md).

### `@twindesk/plugin-work-hub`

The core Host-side service:

- Connector registry;
- event normalization and deduplication;
- Work Item routing;
- Persona selection;
- association between Runs and external objects;
- post-approval action dispatch;
- audit writes.

During TD-020 this package contains only a disposable Host lifecycle effect.
The service behavior above remains later-stage work; the minimal plugin exists
only to prove out-of-tree Profile installation and activation.

### `@twindesk/plugin-feishu`

- Bot and User OAuth identities;
- message event consumption and incremental queries;
- message, conversation, and document context retrieval;
- replies, sends, and idempotency keys;
- Feishu Tools and Skills;
- scope checks, rate limiting, and synchronization diagnostics.

### `@twindesk/plugin-jira`

- OAuth 2.0 or an API token during personal development;
- incremental Issue and Comment synchronization;
- JQL queries;
- comments and status transitions;
- optional Webhook Relay integration;
- Jira Tools and Skills.

### `@twindesk/plugin-ui`

A Harness diagnostic Client plugin:

- proves external Client loading and lifecycle compatibility;
- exposes a static diagnostic Inbox spike and settings card;
- does not own product navigation or render product business data.

### `@twindesk/web`

The local product presentation boundary:

- owns Inbox, Personas, Connectors, Audit, and Settings routes;
- serves only on loopback and applies restrictive browser security headers;
- consumes a future Work Hub API rather than Harness or database internals;
- presents drafts, approvals, execution receipts, and partial context without
  implying authority from Persona or page visibility.

### `@twindesk/bundle-workbench`

A Profile Bundle that composes the plugins above, default Agent Presets, model Tools, and configuration overlays.

The Stage 0 bundle inserts `@twindesk/plugin-work-hub` and
`@twindesk/plugin-ui` after the pinned Harness base and Web application
bundles. They currently expose only a synthetic Tool, one non-secret setting,
a Client diagnostic card, a static out-of-tree Inbox extension spike, and two
versioned draft-only Agent Presets with different scoped Skills and read-only
Tool exposure. The technical Preset alone receives a foreground Codex
specialist Tool backed by an isolated native read-only sandbox; the child does
not inherit parent Harness context or Tools. Preset identity controls behavior and composition only; it does
not grant policy authority. The Stage 0 persistence probe keeps the pinned
base Bundle's append-only JSONL Session backend; SQLite remains a disposable
search projection, not an authoritative store. The Codex compatibility probe
stays behind the adapter and moves no TwinDesk business logic into Harness core.
All selected Stage 0 seams run through the ordered
[`Harness Compatibility Suite`](HARNESS_COMPATIBILITY_SUITE.md); its manifest
and built adapter checks fail loudly on an unsupported upstream change.
The resulting [Stage 0 report](STAGE_0_COMPATIBILITY_REPORT.md) records the
validated runtime seams. The standalone Web shell removes the upstream
product-shell dependency without weakening the Harness compatibility gate.

## 4. Harness Capability Mapping

| TwinDesk Requirement | Harness Capability | Usage |
|---|---|---|
| Work personas | Agent Preset | Each Persona generates or references a Preset |
| Custom Skills | Skill Registry | Layered global, Persona, and workspace providers |
| Tools | Tool Registry | Connectors register read and write Tools |
| Complex delegation | Subagent | Enable after MVP and before relying on experimental Teams |
| Agent Team | Agent Teams / Workflow | Non-critical path with enforced budgets |
| Approval | Approval Service | TwinDesk write Tools call it before execution |
| Session trace | Session Persistence | Stores Agent events and model trajectories |
| Background work | Host Service / Jobs | Connectors use Host lifecycle; Agent tasks may use Jobs |
| Scheduled reminders | Session Schedule | Session reminders only, never global Connector synchronization |
| Codex | `subagent-codex` | Code and repository specialist only |

## 5. Data Model Principles

### 5.1 External Objects Do Not Directly Become Agent Sessions

A Feishu message or Jira Issue first becomes an ExternalEvent, then aggregates into a WorkItem. TwinDesk creates or associates a Harness Session only when the user or a rule begins processing that Work Item.

This prevents every noisy event from producing a model call and Session.

### 5.2 Source Events Are Immutable, Derived State Is Rebuildable

Each Connector calculates a stable idempotency key for every external event:

```text
connector + tenant/account + object type + external id + version/update time
```

Received ExternalEvents are append-only. Inbox state, Thread associations, and unread counts are derived from events and explicit user actions.

The SQLite ingestion boundary validates the full batch before opening a write
transaction, serializes deduplication with `BEGIN IMMEDIATE`, and treats an
exact replay as a duplicate. Stable ID or idempotency-key reuse with different
immutable business content fails the whole batch closed. Source-time ordering
is never inferred from insertion order. A later local receive time on replay
does not replace the timestamp of the first durable arrival. See
[External Event Ingestion](EVENT_INGESTION.md).

### 5.3 Two Persistence Boundaries

- Harness Session Store: model messages, Tool events, approval events, and Subagent or Team history.
- TwinDesk Store: external events, Inbox state, synchronization cursors, business audit data, and retention policy state.

For Stage 0, the Harness Session Store is the pinned append-only JSONL backend.
Its default physical encoding is Zstandard. The independent SQLite Session
query service is a rebuildable search projection and must never be treated as
the source of truth or combined with TwinDesk business tables.

The stores are associated through stable `session_id`, `run_id`, `work_item_id`, and external references.

## 6. Event Processing Flow

```text
receive/poll
  → validate source
  → normalize
  → redact forbidden fields
  → idempotent append
  → update Work Item projection
  → route Persona
  → decide: notify / draft / ignore
  → build bounded context
  → run Agent or Workflow
  → save Draft / ActionProposal
  → request approval when required
  → execute through Connector
  → persist result and external receipt
```

Every write Tool must support an idempotency key. Retrying must not produce duplicate replies or duplicate Jira comments.

## 7. Connector Contract

`@twindesk/domain` owns Connector contract version 1. Concrete Feishu and Jira
plugins implement it without exposing their SDK types, credentials, or raw API
payloads to Work Hub. The Host validates the runtime surface before registry
installation.

```ts
interface Connector {
  readonly descriptor: ConnectorDescriptor

  start(signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
  sync(request: ConnectorSyncRequest, signal: AbortSignal): Promise<ConnectorSyncBatch>
  getContext(request: ConnectorContextRequest, signal: AbortSignal): Promise<ConnectorContextBundle>
  propose(request: ConnectorActionRequest, signal: AbortSignal): Promise<ActionProposal>
  execute(action: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt>
  health(signal: AbortSignal): Promise<ConnectorHealth>
}
```

`start()` and `stop()` are idempotent; shutdown stops new work before releasing
owned resources. Every operation observes cancellation. `sync()` returns an
uncommitted candidate cursor, and Work Hub persists it in the same SQLite
transaction that makes every preceding event durable. Connector, account, and
stream identity mismatches fail closed. Stable cursor identity conflicts and
timestamp or source-watermark regressions roll back the whole batch. Cursor
positions remain Connector-owned opaque values, so the Connector is responsible
for their semantic ordering. Context reports complete, partial, or unavailable
state explicitly. `propose()` has no external side effects. `execute()` accepts
only an opaque `ApprovedAction` created by the policy path and bound to the
exact approval, identity, target, content digest, and idempotency key. An
uncertain receipt requires reconciliation before any retry.

## 8. Security Model

### 8.1 Credentials

- Store OAuth refresh tokens and API tokens in the system Keychain or a dedicated encrypted Secret Store.
- Store only secret references in databases.
- Pass logs, errors, model context, and exports through a shared redactor.
- Configure and display Bot and User identities separately.

### 8.2 Tool Risk

Every Tool declares:

- a `read`, `write`, or `destructive` risk level;
- required Connector scopes;
- whether preview is supported;
- whether approval is required;
- its idempotency strategy;
- allowed accounts, chats, projects, and workspaces.

### 8.3 Agent Teams

- Child Agents inherit the same or narrower authority and cannot expand it themselves.
- Child Agents do not request user approval directly; the Lead aggregates proposed actions.
- Limit member count, concurrency, depth, time, tokens, and Tool calls.
- Team output remains a proposal, and external writes still pass through the shared ActionProposal path.

### 8.4 Dynamic Plugins

Treat Agent-generated Cordis plugins as high-trust code:

- do not use them for long-running Feishu or Jira Connectors;
- do not load credentials automatically;
- do not persist or restore them by default;
- require explicit user authorization before running them;
- deliver production features as versioned npm/Cordis plugins.

## 9. UI Information Architecture

```text
Inbox
├── Needs reply
├── Needs review
├── Waiting
└── Done

Personas
├── Instructions
├── Skills & tools
├── Data scope
├── Autonomy
└── Team policy

Drafts & approvals
Connectors
Skills
Runs & audit
Settings
```

The Work Item detail screen uses three columns: source and context, draft and actions, and the Run and audit timeline.

## 10. DeepSeek Harness Integration Strategy

Because Harness is in developer preview:

1. Pin an exact version or commit instead of tracking a floating version.
2. Keep all Harness types inside adapter packages.
3. Maintain real composition startup tests, not only unit tests.
4. Add compatibility contract tests for Agent Presets, Skills, approvals, Session Persistence, and Client Plugins.
5. Upgrade Harness in isolated commits that document breaking changes.
6. Do not depend directly on unexported source paths.
7. Keep experimental Agent Teams out of the MVP critical path.

## 11. Open Validation Questions

- Will a future public Harness page contract materially improve the diagnostic
  UI enough to adopt it without coupling the TwinDesk product shell to Harness?
- Has the client bundle preset required to build external plugins been formally published?
- What is the complete installation, upgrade, and version-pinning experience for third-party Profile plugins?
- What latency and backup behavior results from running append-only Session JSONL alongside the TwinDesk business SQLite database?
- Can a Host Service continue synchronization reliably when no browser is connected to the Web UI?
- What are the visibility, rate-limit, and incremental-query boundaries for Feishu messages under User identity?
- What deployment and company security approvals are required for a Jira Cloud Webhook Relay?
