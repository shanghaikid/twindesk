# TwinDesk TODO

This is the execution tracker for the roadmap in `docs/ROADMAP.md`. Product scope and safety boundaries remain authoritative in `docs/PRODUCT_GOALS.md`; architecture constraints remain authoritative in `docs/ARCHITECTURE.md`.

## Status Rules

- `[ ]` not started
- `[x]` completed and verified
- Add `Status: In progress` below an unchecked task while it is actively being worked on.
- Move intentionally deferred or removed work to **Explicitly Deferred** with a reason.

Update this file in the same change that completes, defers, or materially re-scopes a task. Do not mark a task complete when only scaffolding exists; its stated completion checks must pass.

## Project Foundation

- [x] **TD-001 — Initialize the TwinDesk repository**
  - Repository uses `main` and tracks `origin/main`.
  - Initial documentation is committed with DCO sign-off.
- [x] **TD-002 — Define product goals and boundaries**
  - Product vision, personas, Skills, approval levels, connector limitations, MVP scope, non-goals, and acceptance criteria are documented.
- [x] **TD-003 — Define the initial architecture and roadmap**
  - Plugin boundaries, persistence boundaries, security model, Harness strategy, and staged delivery plan are documented.
- [x] **TD-004 — Add repository-wide Agent instructions**
  - Root `AGENTS.md` defines safety, architecture, testing, documentation, and Git rules.
  - Repository documentation is required to be written in English.

## Current Milestone: Stage 0 — Harness Compatibility Validation

Goal: prove that TwinDesk can be built primarily as out-of-tree DeepSeek Harness plugins before product implementation begins.

### Baseline and Workspace

- [x] **TD-010 — Select and pin the current latest Harness release**
  - Record the exact release or commit and its license.
  - Record the required Node and package-manager versions.
  - Document how the dependency is obtained locally and in CI.
  - Resolve `latest` only during an intentional upgrade, then commit an exact package version and Git revision.
  - Verification record: `docs/HARNESS_VERSION.md` pins `@deepseek-ai/dsh@0.1.1-rc.2` and commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
  - Completion check: a clean environment resolves the same Harness revision without following a floating branch.

- [x] **TD-011 — Scaffold the TwinDesk monorepo**
  - Create a pnpm workspace and TypeScript project references.
  - Add initial package directories without implementing product behavior.
  - Add formatting, type-check, unit-test, and repository-check commands.
  - Add an `.env.example` containing names only, never real credentials.
  - Depends on: TD-010.
  - Verification record: the frozen install and combined `pnpm run check` pass from a clean temporary copy.
  - Completion check: install, type-check, test, and build commands pass from a clean checkout.

- [x] **TD-012 — Define the Harness adapter boundary**
  - Create an adapter package that owns Harness and Cordis imports.
  - Keep `@twindesk/domain` free of Harness, Cordis, Feishu, Jira, UI, and model SDK dependencies.
  - Add a dependency-boundary test or static check.
  - Depends on: TD-011.
  - Verification record: static import/dependency checks, built declaration checks, and a runtime import-denial test protect the boundary.
  - Completion check: domain tests run without loading Harness packages.

### Server-Side Plugin Validation

- [x] **TD-020 — Create a minimal Profile Bundle**
  - Compose the pinned Harness base and Web application bundles.
  - Add one TwinDesk Host plugin through the Profile rather than a core patch.
  - Document local launch and configuration inspection commands.
  - Depends on: TD-011.
  - Verification record: a clean temporary copy installs the local Bundle and Host plugin through the Profile, dumps the expected entry, starts the Web surface on a temporary loopback port, and shuts down normally.
  - Completion check: the Profile starts from a clean checkout and appears in the dumped effective configuration.

- [x] **TD-021 — Register a read-only TwinDesk Tool**
  - Implement a synthetic `twindesk_status` or equivalent Tool in an out-of-tree Host plugin.
  - Return structured, deterministic data with no network or filesystem writes.
  - Verify Tool registration, invocation, cancellation, and plugin disposal.
  - Depends on: TD-020.
  - Verification record: a keyless scripted Agent receives `twindesk_status`, records a successful `tool/call` and `tool/result` pair in its Session, and the same composition verifies structured output, pre-dispatch cancellation, and registry cleanup on plugin disposal.
  - Completion check: an Agent invokes the Tool successfully and the invocation appears in the Session trace.

- [x] **TD-022 — Validate plugin-owned settings**
  - Register one non-secret settings namespace and schema.
  - Confirm values survive restart.
  - Confirm secret fields are excluded or redacted at every browser and diagnostic boundary.
  - Depends on: TD-020.
  - Verification record: the `twindesk-work-hub` namespace updates `includeRoadmapStage` live, persists through the file-backed provider, and recovers in a fresh Context; an undeclared synthetic secret-like field is rejected before persistence and is absent from the redacted browser descriptor, rejection diagnostic, and stored YAML.
  - Completion check: settings can be read and updated through the supported plugin contract without modifying Harness core.

### Client Plugin and Inbox Extension Validation

- [x] **TD-030 — Build and load a Client plugin**
  - Produce the required `dsh.client` bundle format outside the Harness repository.
  - Mount a small TwinDesk settings card or diagnostic component.
  - Verify production build, source maps, loading failure diagnostics, and reload behavior.
  - Depends on: TD-020.
  - Verification record: the installed `@twindesk/plugin-ui` package registers a Work Hub diagnostic card from an external lazy-CJS bundle; tests execute and dispose the production factory across reload, reject missing or malformed artifacts with actionable diagnostics, and fetch a stable boot-graph row plus the bundle and embedded-source map from a live Profile.
  - Completion check: the component loads from the installed Profile in a clean production build.

- [x] **TD-031 — Spike a top-level Inbox surface**
  - Attempt to add an Inbox route, sidebar entry, and empty-state page using supported Client extension points.
  - Do not add Work Hub business logic during this spike.
  - Record every internal or unstable API required.
  - Depends on: TD-030.
  - Verification record: the external Client plugin owns a `#/inbox` deep link, contributes a `sidebar.footer.action`, and temporarily shadows the top-level `conversation` slot with a static empty page; the pinned SlotCore probe and production bundle lifecycle test verify shadow, restore, direct-route load, listener cleanup, disposal, and reload behavior, while `docs/INBOX_EXTENSION_SPIKE.md` records the absence of a public Router and primary navigation list.
  - Completion check: either the route works entirely out of tree, or a written gap report identifies the smallest generic Harness UI Slot required.

- [x] **TD-032 — Decide the core-patch policy for the Inbox**
  - Choose one of: no core change, upstream a generic extension point, or maintain a minimal temporary patch.
  - Record the decision as an ADR with upgrade and ownership consequences.
  - Depends on: TD-031.
  - Verification record: ADR 0001 selects a product-neutral upstream primary-navigation and keyed-page contract, rejects a TwinDesk Harness fork or temporary patch, assigns generic lifecycle and routing ownership to Harness and all Inbox behavior to the external TwinDesk plugin, and defines upgrade gates and a superseding-decision requirement if upstream support is unavailable.
  - Completion check: the chosen path keeps TwinDesk domain logic outside Harness core.

### Personas, Persistence, and Delegation

- [ ] **TD-040 — Create two distinct Agent Presets**
  - Create a technical-lead Persona and a communication Persona.
  - Give them visibly different instructions and Tool/Skill exposure.
  - Keep external writes disabled.
  - Depends on: TD-020, TD-021.
  - Completion check: the same fixture request produces behavior consistent with each Persona's configuration and authority.

- [ ] **TD-041 — Validate Session persistence and restart recovery**
  - Select JSONL or SQLite explicitly for the spike and document why.
  - Persist a Session containing messages, a Tool call, and Persona identity.
  - Restart the Host and resume the Session.
  - Depends on: TD-020, TD-040.
  - Completion check: the resumed Session preserves history, Persona identity, and Tool trace without duplicate events.

- [ ] **TD-042 — Validate Codex as a specialist Subagent**
  - Install and configure `subagent-codex` through the Profile.
  - Delegate one bounded, read-only repository task.
  - Verify cancellation, depth limits, Tool filtering, and result attribution.
  - Depends on: TD-020.
  - Completion check: the Lead receives a traceable result while the child cannot exceed the delegated authority.

### Compatibility and Stage Exit

- [ ] **TD-050 — Build the Harness compatibility smoke suite**
  - Cover Profile boot, Host plugin activation, Tool registration, Client plugin loading, Persona selection, Session resume, and Codex delegation.
  - Pin expected public interfaces and fail clearly on incompatible upgrades.
  - Depends on: TD-021, TD-030, TD-040, TD-041, TD-042.
  - Completion check: one command runs all compatibility checks in CI and locally.

- [ ] **TD-051 — Publish the Stage 0 compatibility report**
  - Record the validated Harness revision and supported extension points.
  - List gaps, unstable APIs, required patches, and upgrade risks.
  - Estimate only the implementation surface, not speculative delivery dates.
  - Depends on: TD-032, TD-050.
  - Completion check: the report makes a clear go/no-go recommendation for Stage 1.

- [ ] **TD-052 — Pass the Stage 0 exit gate**
  - Product experience is viable without a fork, or with only a minimal generic UI extension point.
  - No TwinDesk domain logic is placed in Harness core.
  - Compatibility tests cover every selected unstable boundary.
  - All Stage 0 security and restart checks pass.
  - Depends on: TD-051.

## Stage 1 Backlog — Local Work Hub

Do not start Stage 1 implementation before TD-052 is complete.

- [ ] **TD-100 — Define versioned domain types** for ExternalEvent, WorkItem, ExternalThread, Draft, ActionProposal, ApprovalRecord, ConnectorCursor, and AuditRecord.
- [ ] **TD-101 — Define the Connector contract** with lifecycle, synchronization, context, proposal, execution, and health semantics.
- [ ] **TD-102 — Design the TwinDesk SQLite schema and forward migrations** without using Harness Session tables.
- [ ] **TD-103 — Implement idempotent event ingestion** for duplicates, out-of-order events, and replay.
- [ ] **TD-104 — Implement durable synchronization cursors** that advance only after event commits.
- [ ] **TD-105 — Build Work Item projections and Inbox queries** that are rebuildable from events and user actions.
- [ ] **TD-106 — Build the fixture-driven Inbox page** with Needs reply, Needs review, Waiting, and Done states.
- [ ] **TD-107 — Map Persona configuration to Harness Presets** without granting permissions implicitly.
- [ ] **TD-108 — Implement Draft and ActionProposal state transitions** with no external side effects.
- [ ] **TD-109 — Implement the local Audit Timeline** linking Work Items, Sessions, Runs, Tool calls, approvals, and receipts.
- [ ] **TD-110 — Implement secret references and a shared redactor** for logs, model context, errors, telemetry, and exports.
- [ ] **TD-111 — Implement Thread export and deletion** with explicit retention behavior.
- [ ] **TD-112 — Pass the Stage 1 exit gate:** fixture events complete Inbox → Persona → Draft → Audit across restart.

## Stage 2 Backlog — Feishu Closed-Loop MVP

Do not start write operations before the approval and audit path exists.

- [ ] **TD-200 — Define separate Feishu Bot and User identities** and store only credential references.
- [ ] **TD-201 — Consume Bot direct-message and mention events** with signature validation and deduplication.
- [ ] **TD-202 — Incrementally discover messages visible under User identity** without claiming complete account coverage.
- [ ] **TD-203 — Retrieve bounded conversation, document, and attachment context** with explicit partial-result states.
- [ ] **TD-204 — Normalize Feishu sources into ExternalEvents and Work Items.**
- [ ] **TD-205 — Implement a preview-only Feishu reply proposal.**
- [ ] **TD-206 — Bind one-time approval to sending identity, target, content digest, and expiration.**
- [ ] **TD-207 — Implement idempotent Feishu reply execution** and uncertain-result handling.
- [ ] **TD-208 — Add Connector health, scope, rate-limit, and cursor diagnostics.**
- [ ] **TD-209 — Pass the Feishu closed-loop MVP acceptance tests** from ingestion through local audit.

## Stage 3 Backlog — Jira Context

- [ ] **TD-300 — Add Jira OAuth support and development-only API Token support.**
- [ ] **TD-301 — Incrementally synchronize user-relevant Issues and Comments.**
- [ ] **TD-302 — Implement a read-only JQL search Tool.**
- [ ] **TD-303 — Associate Jira Issues with Feishu Threads and TwinDesk Work Items.**
- [ ] **TD-304 — Surface incomplete Jira context without blocking Feishu drafts.**
- [ ] **TD-305 — Keep Jira writes disabled or feature-flagged until a later stage.**
- [ ] **TD-306 — Pass the Stage 3 exit gate:** drafts can cite verifiable Jira facts and degrade safely.

## Stage 4 Backlog — Personas and Specialist Subagents

- [ ] **TD-400 — Build the Persona editor.**
- [ ] **TD-401 — Visualize layered Skill selection and overrides.**
- [ ] **TD-402 — Configure Tool and data scopes independently from Persona identity.**
- [ ] **TD-403 — Configure autonomy, time, token, Tool-call, and delegation budgets.**
- [ ] **TD-404 — Productize Codex as a code and repository specialist.**
- [ ] **TD-405 — Add one-shot Drafter and Critic Subagents.**
- [ ] **TD-406 — Compare single-Agent and delegated run cost, latency, and outcomes.**
- [ ] **TD-407 — Pass the Stage 4 exit gate:** users can predict each Persona's identity, capability, and authority boundaries.

## Stage 5 Backlog — Teams, Automation, and Desktop Experience

Do not begin this stage before real MVP usage feedback exists.

- [ ] **TD-500 — Define and validate Team Templates.**
- [ ] **TD-501 — Add dynamic Workflows with bounded execution.**
- [ ] **TD-502 — Evaluate experimental Agent Teams outside the critical path.**
- [ ] **TD-503 — Enable approved Jira comment and transition operations.**
- [ ] **TD-504 — Add allowlisted low-risk automation.**
- [ ] **TD-505 — Design an optional stateless Webhook Relay.**
- [ ] **TD-506 — Add a desktop shell, system tray, notifications, and quick actions.**

## Cross-Cutting Gates

Apply these gates to every relevant task:

- [ ] Every persisted feature has a restart recovery test.
- [ ] Every external write has an idempotency and uncertain-result test.
- [ ] Every Connector path tests duplicate and out-of-order events.
- [ ] Every sensitive field has redaction, retention, and export coverage.
- [ ] Every approval path fails closed on rejection, cancellation, missing identity, missing scope, or missing responder.
- [ ] Every Subagent or Team path enforces equal-or-narrower authority and explicit budgets.
- [ ] Every Harness upgrade runs the compatibility smoke suite.
- [ ] Every repository document remains in English.
- [ ] Every pull-request commit contains a matching DCO sign-off.

## Explicitly Deferred

- **Multi-user SaaS and organization administration** — outside the initial product boundary.
- **Plugin marketplace** — premature before a stable plugin contract and real usage.
- **Mobile client** — not required for the first closed loop.
- **Vector database** — deferred until measured retrieval needs exceed SQLite and explicit references.
- **Automatic replies without confirmation** — conflicts with the MVP `draft_only` default.
- **Arbitrary third-party code installation by Agents** — conflicts with the security model.
- **Experimental Agent Teams on the MVP critical path** — deferred until Subagent and Workflow behavior is proven.
