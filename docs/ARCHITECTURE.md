# TwinDesk Architecture

## 1. Architecture Decision

The first TwinDesk version uses DeepSeek Harness as its Agent Runtime and extends business capabilities through formally installed Cordis plugins. TwinDesk will not initially fork Harness. If the product-level Inbox cannot be implemented through existing client extension points, the project will add only the smallest generic UI Slot while keeping all TwinDesk domain logic outside the Harness repository.

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
               TwinDesk Web UI
          inbox / drafts / approvals / traces
```

## 3. Plugin and Package Boundaries

### `@twindesk/domain`

Pure TypeScript domain types and rules with no Cordis dependency:

- ExternalEvent
- WorkItem
- ExternalThread
- Draft
- ActionProposal
- ApprovalRecord
- ConnectorCursor
- AuditRecord

### `@twindesk/storage-sqlite`

The TwinDesk business database:

- schema and migrations;
- Inbox and Thread queries;
- idempotent external event writes;
- synchronization cursors;
- drafts, approvals, and execution results;
- data deletion and export.

It never writes directly into the Harness Session SQLite schema.

### `@twindesk/plugin-work-hub`

The core Host-side service:

- Connector registry;
- event normalization and deduplication;
- Work Item routing;
- Persona selection;
- association between Runs and external objects;
- post-approval action dispatch;
- audit writes.

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

A dual-sided Host and Client plugin:

- Inbox page;
- Persona and Skill settings;
- draft editing and approvals;
- Connector status;
- Run, Tool, and Audit timelines.

### `@twindesk/bundle-workbench`

A Profile Bundle that composes the plugins above, default Agent Presets, model Tools, and configuration overlays.

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

### 5.3 Two Persistence Boundaries

- Harness Session Store: model messages, Tool events, approval events, and Subagent or Team history.
- TwinDesk Store: external events, Inbox state, synchronization cursors, business audit data, and retention policy state.

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

## 7. Connector Interface Draft

```ts
interface Connector {
  readonly id: string

  start(signal: AbortSignal): Promise<void>
  sync(cursor: ConnectorCursor | undefined, signal: AbortSignal): Promise<SyncBatch>
  getContext(ref: ExternalRef, request: ContextRequest, signal: AbortSignal): Promise<ContextBundle>
  propose(action: ActionRequest): Promise<ActionProposal>
  execute(approved: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt>
  health(): Promise<ConnectorHealth>
}
```

`propose()` has no external side effects. `execute()` accepts only an `ApprovedAction` bound to an approval record, target, and content digest.

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

- Can a Client Plugin reliably add a top-level Inbox route and sidebar entry?
- Has the client bundle preset required to build external plugins been formally published?
- What is the complete installation, upgrade, and version-pinning experience for third-party Profile plugins?
- What latency results from running Session SQLite and business SQLite concurrently in one process?
- Can a Host Service continue synchronization reliably when no browser is connected to the Web UI?
- What are the visibility, rate-limit, and incremental-query boundaries for Feishu messages under User identity?
- What deployment and company security approvals are required for a Jira Cloud Webhook Relay?
