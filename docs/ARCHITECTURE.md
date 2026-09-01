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
- WorkItemUserAction
- ExternalThread
- Draft
- ActionProposal
- ApprovalRecord
- ConnectorCursor
- AuditRecord
- SecretReference

Every persisted business record starts with `kind` and `schemaVersion: 1`.
`@twindesk/domain` exposes boundary parsers that reject unknown fields,
unsupported versions, invalid UTC timestamps, duplicate stable references,
non-finite JSON values, accessor properties, and internally inconsistent
identity, target, approval, or partial-context data. Parsed records are deeply
immutable. Validation errors identify only the rejected field path and
expectation; they do not serialize the input value. Pure Draft and
ActionProposal transition functions enforce the local TD-108 state graphs;
approval and execution states remain unavailable without separate evidence.
The same package owns the dependency-free shared redactor. Diagnostic policies
retain only bounded structured metadata text; model-context and export policies
may retain authorized business content, but every policy removes credentials,
opaque secret locators, supplied secret values, and hidden reasoning. Current
Work Hub Tool renderers use this boundary before returning model context. See
[Secret References and Shared Redaction](SECRET_REFERENCES_AND_REDACTION.md).

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
database. Versioned Thread export reads a consistent aggregate and applies the
shared export redactor. Revision-bound Thread deletion atomically removes
Thread-owned business records and orphaned events while retaining shared
events, Connector cursors, and a hash-and-count-only tombstone receipt. It
removes TwinDesk's opaque Harness links but does not modify or claim deletion of
the separate Session store. See [TwinDesk SQLite Storage](STORAGE_SQLITE.md) and
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md).

### `@twindesk/plugin-work-hub`

The core Host-side service:

- Connector registry;
- event normalization and deduplication;
- Work Item routing;
- Stage 1 fixture ingestion and presentation-safe Inbox and Audit reads;
- Persona selection;
- fail-closed mapping of versioned built-in Persona configuration to installed Presets;
- association between Runs and external objects;
- post-approval action dispatch;
- audit writes.

The Stage 0 Host lifecycle effect remains as compatibility evidence. TD-106
adds a product-owned fixture Inbox service that seeds normalized synthetic
records through `@twindesk/storage-sqlite` and exposes a narrow read model to
the local Web server. TD-109 extends that boundary with immutable synthetic
business Audit records and a presentation-safe timeline while keeping Harness
Session data in its own store. TD-107 maps the exact two installed Persona
configurations to TwinDesk-owned Preset identifiers and observable composition
metadata without importing Harness types or producing authority. TD-112
completes the deterministic Stage 1 fixture path by persisting two
`ready_for_review` Drafts and Persona-attributed Audit records across restart.
It does not invoke Harness, create Session or Run references, or grant
Connector authority. TD-209 now adds a Connector-neutral action execution Host
that holds an injected exclusive-operation callback across approval consumption,
execution start, durable dispatch, receipt persistence, and deterministic Audit
completion. A committed receipt repairs missing Audit after restart without
another external effect. Connector registry, real event routing, Run
association, dynamic Personas, and live Connector composition remain open. See
[Work Hub Action Execution Host](ACTION_EXECUTION_HOST.md).

### `@twindesk/plugin-feishu`

- versioned, separately typed Bot application and User OAuth identities that
  persist only distinct SecretReferences;
- message event consumption and incremental queries;
- message, conversation, and document context retrieval;
- replies, sends, and idempotency keys;
- Feishu Tools and Skills;
- scope checks, rate limiting, and synchronization diagnostics.

TD-200 implements the identity configuration boundary. Its atomic local
store rejects secret values, mixed identity slots, incompatible credential
purposes, symbolic links, and unsupported versions. A credential-free
ActionIdentity projection records the selected principal without granting
scope or execution authority. TD-201 adds a separate Bot message callback
boundary: raw-body signature verification, encrypted-envelope support, exact
direct-message/mention filtering, and an append-only hash receipt journal. It
does not host a callback, resolve its Encrypt Key, normalize ExternalEvents, or
grant execution authority. TD-202 adds bounded User-identity search windows and
opaque candidate cursor positions; it always reports partial coverage and
leaves durable event/cursor commit to TD-204. TD-203 adds a User-bound context
adapter boundary for bounded conversation messages, simple document excerpts,
and attachment text or metadata; partial and unavailable sources remain
explicit and binary values are rejected. TD-204 canonicalizes verified Bot and
bounded User messages into replay-safe ExternalEvents and conversation-scoped
Work Items. Event ingestion, projections, and the optional User cursor commit
atomically; late source states extend history without regressing Inbox
presentation. Concrete Feishu API adapters, runtime composition, scopes, and
writes remain later Stage 2 work. TD-205 adds a side-effect-free reply proposal
boundary: it requires an existing Draft identity, exact configured Bot/User
identity, current message target, plain-text content digest, and opaque
idempotency key, then stops at `proposed`. TD-206 adds the Connector-neutral
policy boundary: a pending ApprovalRecord binds canonical identity, target, and
content digests plus an expiration; responder decisions atomically advance the
proposal; one-time consumption yields only one stable execution-attempt
identity and performs no Connector call. See
[Feishu Bot and User Identities](FEISHU_IDENTITIES.md) and
[Feishu Bot Event Ingestion](FEISHU_BOT_EVENT_INGESTION.md), and
[Feishu User Message Discovery](FEISHU_USER_MESSAGE_DISCOVERY.md), and
[Feishu Context Retrieval](FEISHU_CONTEXT_RETRIEVAL.md), and
[Feishu Message Normalization](FEISHU_MESSAGE_NORMALIZATION.md), and
[Feishu Reply Proposal](FEISHU_REPLY_PROPOSAL.md), and
[One-Time Action Approval Policy](ACTION_APPROVAL_POLICY.md).

TD-207 adds the Feishu execution adapter and durable result boundary without
coupling either to Persona behavior. The executor revalidates the exact
ApprovedAction and configured identity. It reconciles the proposal's stable
idempotency key before sending when an adapter exposes an exact lookup. A
send-only adapter may make its first call only after the durable dispatch
journal proves there is no earlier reservation; it never treats unavailable
remote lookup as confirmed absence. SQLite records the normalized receipt and
proposal outcome atomically; consumed non-terminal attempts recover across
restart, while expired recovery permits exact reconciliation but no new send.
Migration 6 adds a Connector-neutral dispatch journal. The Feishu executor must
reserve the exact attempt immediately before `send()`, and receipt persistence
settles that reservation in the same transaction as proposal state.
TD-209 now includes a Connector-owned macOS Keychain reader that resolves only
validated Feishu Bot/User SecretReferences through a fixed generic-password
service and zeroes the bounded byte buffer after callback use. A versioned
parser binds application and OAuth bundles to the exact configured identity,
classifies refresh state, and zeroes derived secret buffers after callback use.
An OAuth v3 boundary additionally validates exact refresh form bytes, rotating
responses, server lifetimes and scopes, and reauthorization failures. Its
production Fetch transport fixes the endpoint, rejects redirects, and bounds
streamed responses. A version 1 rotated-bundle encoder and stdin-only Keychain
replacement primitive now preserve the same secret and identity boundary, but
do not independently coordinate refresh. A Connector-owned append-only journal
and single-Host coordinator now reserve before remote access, compose those
primitives, recover a provably newer Keychain bundle after restart, and block
every unproven use of the old single-use token. Authorization-code principal
verification now has an exact post-exchange `open_id` boundary plus a
fixed-endpoint, bounded production user-info Fetch client. An in-memory,
state-bound S256 PKCE flow now creates the authorization request, consumes the
exact callback once, and exchanges it through the bounded OAuth v3 transport.
The verified initial-persistence composition then requires the exact configured
`open_id`, encodes the first version 1 User bundle, and replaces only its
configured Keychain reference. An exclusive
kernel-backed Host lease now prevents two processes from operating Feishu at
once and survives abrupt owner death without stale recovery files. Explicit
reauthorization now replaces only a durably blocked credential and
records a distinct version 2 `reauthorized` event while preserving version 1
journal history. A bounded fixed-endpoint reply HTTP primitive now preserves
post-send ambiguity without inventing remote reconciliation, and the durable
dispatch reservation already blocks blind restart sends. A send-only production
adapter now composes an already-held lease with concrete Bot/User scope probes,
exact Keychain credential callbacks, Bot tenant-token acquisition, and that HTTP
primitive. The Connector-neutral Work Hub Host operation owns approval,
dispatch, receipt, and recoverable Audit ordering under exclusive ownership.
The Workbench composition root now binds both boundaries with the real runtime
lease in a production-shaped API and synthetic end-to-end test. Hosting that
API and placing every polling and refresh boundary under the same lease remain
TD-209 work. See
[Feishu Credential Bundles](FEISHU_CREDENTIAL_BUNDLES.md) and
[Feishu OAuth v3 Refresh](FEISHU_OAUTH_V3_REFRESH.md) and
[Feishu OAuth Authorization Code and PKCE](FEISHU_OAUTH_AUTHORIZATION_CODE.md) and
[Feishu OAuth Verified Initial Persistence](FEISHU_OAUTH_INITIAL_PERSISTENCE.md) and
[Feishu OAuth Reauthorization Replacement](FEISHU_OAUTH_REAUTHORIZATION.md) and
[Feishu Operation Scope Authorization](FEISHU_OPERATION_SCOPE_AUTHORIZATION.md) and
[Feishu Reply HTTP Client](FEISHU_REPLY_HTTP_CLIENT.md) and
[Feishu Reply Execution Adapter](FEISHU_REPLY_EXECUTION_ADAPTER.md) and
[Work Hub Action Execution Host](ACTION_EXECUTION_HOST.md) and
[Workbench Feishu Reply Runtime](WORKBENCH_FEISHU_REPLY_RUNTIME.md) and
[Feishu User Credential Scope Probe](FEISHU_USER_CREDENTIAL_SCOPE_PROBE.md) and
[Feishu Runtime Lease](FEISHU_RUNTIME_LEASE.md) and
[Feishu OAuth Rotation Coordinator](FEISHU_OAUTH_ROTATION_COORDINATOR.md) and
[Feishu OAuth User Principal Verification](FEISHU_OAUTH_PRINCIPAL_VERIFICATION.md) and
[Feishu Reply Execution](FEISHU_REPLY_EXECUTION.md).

TD-208 adds a read-only Feishu diagnostics service behind the Connector health
contract. It probes configured Bot/User identities independently, computes
missing operation scopes, normalizes rate-limit observations, and classifies
durable cursor freshness without exposing credentials, principals, raw
responses, or opaque cursor positions. Health does not grant authority and may
be stale by execution time; TD-207 still validates every write. Production
probe composition and the real closed-loop acceptance flow remain TD-209 work.
See [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).

TD-209 now has a local contract-level acceptance path spanning normalized Bot
input, atomic Inbox projection, User-bound context, explicit Persona selection,
an edited Draft revision, exact approval, reconcile-before-send execution,
durable receipt, restart verification, and reference-validated Audit records. This is
composition evidence, not a live Connector path: its acceptance fixture
resolves no live credential and calls no real Feishu API. The production reply
client now composes the held lease, exact scope probes, Keychain, token, and HTTP
boundaries under injected tests. The Workbench composition root now wires the
durable Host operation to the real lease, User rotation coordinator, and
production reply adapter, while injecting only synthetic Keychain and Fetch
boundaries for its full-stack test. A separate Workbench reauthorization
runtime now holds that same lease from blocked journal inspection through the
registered-loopback callback, code exchange, verified Keychain replacement,
and journal settlement. A restart-loaded factory composes the bounded
production HTTP, verifier, Keychain, Settings, and supplied-journal boundaries;
it neither retries a reply nor exposes a product action yet. The Workbench also
owns fixed private macOS product paths for
the Connector-owned identity and OAuth authorization Settings stores plus the
separate secret-free OAuth rotation journal. It does not place credentials,
Harness Sessions, or TwinDesk business tables in those files. A Workbench
presentation service projects the Settings stores into a
versioned identity-minimized status that the Web server revalidates before the
Connectors page consumes it. The projection omits application, account,
principal, SecretReference, and filesystem identifiers and does not claim
credential or connectivity health. The Workbench Web launcher owns default-path
store construction and injection while `@twindesk/web` remains independent of
Connector persistence. A separate Workbench OAuth Settings editor derives the
app from the existing User identity and writes only the literal-loopback
callback plus requested scopes. The Web composition exposes that writer behind
exact Host/Origin/Fetch-Metadata/CSRF/media/body/schema checks; the read-only
presenter never gains mutation authority. A separate create-only User identity
bootstrapper either creates the first local Feishu connection or preserves an
existing Bot connection while adding its User slot. It generates the internal
account and Keychain-reference locators inside Workbench, accepts no credential,
and uses the same Web request-forgery boundary without adding identifiers to the
status body. A separate memory-only authorization controller composes the
restart-loaded, lease-held initial OAuth Host and exposes only minimized states
to Web. The loopback server accepts a bounded transient app-secret body behind
the same Host/Origin/Fetch-Metadata/CSRF boundary, clears its copy, validates the
exact Feishu/PKCE presentation, and requires an explicit browser click. It does
not expose credentials or imply connectivity. A second read-only Workbench
presenter maps the secret-free rotation journal to five fixed recovery states.
Web revalidates only `version`, `connectorId`, and `state`; the Connectors page
and authorization-start endpoint block a new initial authorization while
recovery evidence is unavailable, active, or unresolved. The server check
precedes app-secret body consumption and Host invocation. This status does not
inspect Keychain and grants no reauthorization or reconciliation action. Cordis
activation remains open. See
[Workbench Feishu OAuth Settings Editing](WORKBENCH_FEISHU_OAUTH_SETTINGS_EDITING.md),
[Workbench Feishu User Identity Bootstrap](WORKBENCH_FEISHU_USER_IDENTITY_BOOTSTRAP.md),
[Workbench Feishu Settings Presentation](WORKBENCH_FEISHU_SETTINGS_PRESENTATION.md),
[Workbench Feishu OAuth Authorization UI](WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_UI.md),
[Workbench Feishu OAuth Recovery Presentation](WORKBENCH_FEISHU_OAUTH_RECOVERY_PRESENTATION.md),
[ADR 0003](decisions/0003-macos-local-data-root.md), and
[ADR 0004](decisions/0004-feishu-oauth-recovery-journal-path.md). The Stage 2
exit remains open until the
production runtime hosts ingestion, polling, and credential-recovery
lifecycles, and passes product editing/approval UI, model-run linkage, and
live-account acceptance boundaries. See
[Workbench Feishu OAuth Reauthorization Runtime](WORKBENCH_FEISHU_OAUTH_REAUTHORIZATION_RUNTIME.md)
and [Stage 2 Exit Gate](STAGE_2_EXIT_GATE.md).

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
- consumes the loopback Work Hub Inbox and Audit APIs rather than Harness or
  database internals;
- accepts a presentation-safe Feishu Settings service at the composition
  boundary, revalidates its minimized read response, and exposes only explicit
  CSRF-bound local OAuth and create-only User identity writers;
- accepts a separate initial-authorization controller, independently validates
  its minimized memory-only state and exact Feishu URL, and never gains direct
  Keychain or Connector-store access;
- presents drafts, approvals, execution receipts, and partial context without
  implying authority from Persona or page visibility.

### `@twindesk/bundle-workbench`

A Profile Bundle that composes the plugins above, default Agent Presets, model Tools, and configuration overlays.

Its exported Workbench Feishu reply runtime factory composes the exact durable
approval operation, real kernel-backed lease, production reply adapter, and
injected credential/scope/HTTP collaborators. It is production-shaped
composition evidence but is not activated as a hosted Cordis lifecycle yet.

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

Work Hub supplies a versioned Thread and Work Item projection anchored to
durable ExternalEvent IDs. SQLite stores that event-derived base separately
from immutable, revisioned `WorkItemUserAction` records. The current `work_items`
row and its event links can therefore be rebuilt in place without deleting
dependent business records. A later event-derived base supersedes older user
actions; actions at or after the base revision apply in strict revision order.
Persona selection changes routing identity only and never grants Tool or
Connector authority. See [Work Item Projections](WORK_ITEM_PROJECTIONS.md).

Draft and ActionProposal creation records preserve the original request while
immutable transition rows advance the current projection atomically. The local
API accepts no Connector or Tool and rejects approval or execution states.
ActionProposals bind exact content, Work Item, optional Draft, Connector
identity, target, digest, and idempotency key before later policy handling. See
[Draft and ActionProposal Transitions](DRAFT_ACTION_TRANSITIONS.md).

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

`SecretReference` records contain no secret material and do not grant data or
Tool scope. They identify either the system Keychain or a dedicated encrypted
store plus a purpose. Resolving those references remains a Connector-owned
operation; actual values must be short-lived and supplied to the redactor as
known secrets before any outbound boundary. Telemetry follows the same
diagnostic policy as logs and errors. The redactor is a final safety boundary,
not a substitute for data minimization or explicit model/export authorization.

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
