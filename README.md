# TwinDesk

TwinDesk is a local-first personal work agent console. It brings information from Feishu, Jira, and other work systems into a unified Inbox, where multiple configurable work personas can understand context, prepare replies, advance tasks, and act within explicit permission boundaries.

> TwinDesk is a working name and has not yet undergone trademark or domain-name clearance.

## Product Positioning

TwinDesk is not an auto-reply bot or another general-purpose chat window. It is a user-controlled work console that:

- collects and organizes Feishu messages, document mentions, Jira issues, and comments;
- configures Personas, Skills, tool permissions, and memory scopes for different work identities;
- uses a single Agent for simple tasks and can dynamically assemble an Agent Team for complex work;
- produces drafts by default and executes external writes only after approval;
- stores sources, context, drafts, approvals, tool calls, and final outcomes locally;
- keeps the Agent Runtime, models, and external connectors replaceable.

## Current Technical Direction

The first version uses a TwinDesk-owned local Web shell and
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a
replaceable Agent Runtime:

- TwinDesk owns product navigation, the Work Inbox, external event model,
  Persona experience, approvals, business audit trail, and retention policies;
- DeepSeek Harness provides the Agent Loop, Sessions, Skills, Tools, Presets,
  Subagents, and Workflows behind an explicit adapter;
- Harness Web UI is a diagnostic surface, not the TwinDesk product shell;
- Feishu and Jira are implemented as independent Connector plugins;
- Agent Session logs and TwinDesk business data are stored separately;
- the product domain model is not coupled to DeepSeek, Codex, or any single model provider.

DeepSeek Harness is still in developer preview, so the integration layer must pin a compatible version and remain isolated from TwinDesk domain code.

## Documentation

- [Product Goals](docs/PRODUCT_GOALS.md): vision, user journeys, scope, acceptance criteria, and non-goals.
- [Architecture](docs/ARCHITECTURE.md): plugin boundaries, data boundaries, event flow, security model, and technical risks.
- [Roadmap](docs/ROADMAP.md): delivery sequence from technical validation to a usable MVP.
- [TODO](TODO.md): current execution checklist, dependencies, completion checks, and gated backlog.
- [Harness Version](docs/HARNESS_VERSION.md): current exact upstream pin, toolchain requirements, and upgrade procedure.
- [Harness Profile](docs/HARNESS_PROFILE.md): Stage 0 Profile composition, local launch, and configuration inspection.
- [Session Persistence Spike](docs/SESSION_PERSISTENCE_SPIKE.md): JSONL selection, restart recovery evidence, data boundaries, and limitations.
- [Codex Subagent Spike](docs/CODEX_SUBAGENT_SPIKE.md): read-only specialist configuration, cancellation, attribution, and capability limits.
- [Harness Compatibility Suite](docs/HARNESS_COMPATIBILITY_SUITE.md): one-command Stage 0 contract coverage and failure diagnostics.
- [Stage 0 Compatibility Report](docs/STAGE_0_COMPATIBILITY_REPORT.md): validated extension points, gaps, upgrade risks, and the Stage 1 gate recommendation.
- [Stage 0 Exit Gate](docs/STAGE_0_EXIT_GATE.md): the formal TD-052 decision, criterion evidence, selected UI boundary, and remaining limitations.
- [Stage 1 Exit Gate](docs/STAGE_1_EXIT_GATE.md): the formal TD-112 local Work Hub decision, end-to-end fixture evidence, and Stage 2 boundary.
- [Stage 2 Exit Gate](docs/STAGE_2_EXIT_GATE.md): local Feishu contract acceptance evidence and the still-open live-account gate.
- [Feishu Bot and User Identities](docs/FEISHU_IDENTITIES.md): separate principals, credential-reference persistence, privacy, and current connection limits.
- [Feishu Bot Event Ingestion](docs/FEISHU_BOT_EVENT_INGESTION.md): signed direct-message and mention callbacks, hash-only durable deduplication, privacy, and hosting limits.
- [Feishu User Message Discovery](docs/FEISHU_USER_MESSAGE_DISCOVERY.md): bounded user-authorized search windows, replay-safe candidate cursors, partial coverage, and adapter limits.
- [Feishu Context Retrieval](docs/FEISHU_CONTEXT_RETRIEVAL.md): bounded User-identity conversation, document-excerpt, and attachment context with explicit partial states.
- [Feishu Message Normalization](docs/FEISHU_MESSAGE_NORMALIZATION.md): canonical Bot/User events, Inbox routing, replay, privacy, and atomic event/projection/cursor commits.
- [Feishu Reply Proposal](docs/FEISHU_REPLY_PROPOSAL.md): Draft-bound preview construction, explicit sending identity and target binding, idempotency, and no-side-effect limits.
- [One-Time Action Approval Policy](docs/ACTION_APPROVAL_POLICY.md): exact identity/target/content binding, expiration, responder decisions, one-time consumption, and execution separation.
- [Feishu Reply Execution](docs/FEISHU_REPLY_EXECUTION.md): reconcile-before-send execution, exact idempotency, normalized receipts, restart recovery, and uncertain-result handling.
- [Feishu Connector Diagnostics](docs/FEISHU_CONNECTOR_DIAGNOSTICS.md): per-identity authorization/scopes, normalized rate limits, redacted cursor freshness, and overall health.
- [Feishu System Keychain Resolution](docs/FEISHU_SYSTEM_KEYCHAIN.md): fixed macOS SecretReference lookup, bounded short-lived bytes, cancellation, and payload-free failures.
- [SQLite Storage](docs/STORAGE_SQLITE.md): TwinDesk database identity, schema, forward migrations, privacy review, and recovery guarantees.
- [External Event Ingestion](docs/EVENT_INGESTION.md): transactional deduplication, replay, conflict, and out-of-order semantics.
- [Durable Synchronization Cursors](docs/SYNC_CURSORS.md): atomic event/checkpoint commits, restart recovery, and regression rules.
- [Work Item Projections](docs/WORK_ITEM_PROJECTIONS.md): event-anchored projection writes, revisioned user actions, rebuilds, and Inbox pagination.
- [Fixture-driven Inbox](docs/FIXTURE_INBOX.md): synthetic four-state Work Hub data, loopback read API, UI behavior, and restart limits.
- [Persona to Harness Preset Mapping](docs/PERSONA_PRESET_MAPPING.md): versioned built-in behavior mapping and its non-authority boundary.
- [Draft and ActionProposal Transitions](docs/DRAFT_ACTION_TRANSITIONS.md): local state machines, exact content binding, replay, and no-side-effect boundary.
- [Local Audit Timeline](docs/AUDIT_TIMELINE.md): immutable business records, cross-store references, pagination, and presentation redaction.
- [Secret References and Shared Redaction](docs/SECRET_REFERENCES_AND_REDACTION.md): opaque secret locators, boundary policies, failure behavior, and current limitations.
- [Thread Export and Deletion](docs/THREAD_EXPORT_AND_DELETION.md): aggregate export, revision-bound deletion, durable tombstones, and explicit retention behavior.
- [Harness Upstream Navigation Proposal](docs/HARNESS_UPSTREAM_NAVIGATION_PROPOSAL.md): an optional ecosystem reference for generic Harness Client extensibility.
- [Inbox Extension Spike](docs/INBOX_EXTENSION_SPIKE.md): out-of-tree route and sidebar findings, limitations, and compatibility seams.
- [ADR 0001](docs/decisions/0001-upstream-generic-inbox-extension-points.md): historical Harness Client investigation and upstream path.
- [ADR 0002](docs/decisions/0002-twindesk-owned-product-web-shell.md): accepted standalone product UI boundary.

## Current Status

Stages 0 and 1 are complete and the project is ready for Roadmap Stage 2. The
standalone `@twindesk/web` shell owns Inbox, Personas, Connectors, Audit, and
Settings routes and runs only on loopback. The business schema, idempotent
ExternalEvent ingestion, durable synchronization cursors, Work Item projections,
Inbox queries, the fixture-driven four-state Inbox page, fail-closed mapping for the
two built-in Personas, durable Draft/ActionProposal transitions, and the local
Audit Timeline are implemented. Versioned SecretReferences and the shared
boundary redactor are available, and current Work Hub Tool results use the
model-context policy. Versioned, redacted Thread export and revision-bound local
Thread deletion cover the complete TwinDesk business aggregate with
explicit shared-event, cursor, deletion-receipt, and Harness Session retention
behavior. The Audit page shows four synthetic routing records plus two
deterministic Persona Draft records. The fixture flow reaches `ready_for_review`
across restart with no model call, approval, Connector execution, or external
write. User-driven or model-backed Draft generation, Draft editing UI, approval
decisions, actual secret-store resolution, user-created Personas, and hosted
Connector subscriptions are not implemented.
Stage 2 identity configuration now distinguishes Feishu Bot application
credentials from User OAuth credentials and persists only opaque secret
references. The Feishu plugin now verifies and decrypts Bot direct-message and
exact-mention callbacks, then records restart-durable hash-only message receipts.
It also produces replay-safe candidate cursors for bounded message search under
the separate User identity while explicitly reporting partial coverage, and it
validates bounded conversation, document-excerpt, and attachment context without
returning binary files. Verified Bot messages and bounded User discovery batches
now normalize into canonical ExternalEvents and event-anchored Inbox Work Items;
User events, projections, and candidate cursors share one transaction. It is not
connected to a real account, resolves no secrets, and hosts no callback or
polling scheduler. A Draft-bound Feishu reply can now be packaged as a local
plain-text ActionProposal with an explicit Bot or User identity and exact
message target. The local approval policy can now bind that proposal to an
explicit responder decision and expiration, then consume the approval once
into one stable execution attempt. The Feishu execution boundary now
reconciles that attempt before every possible send and persists a normalized
success, failure, or uncertain receipt atomically with proposal state. The
executor also requires a durable SQLite dispatch reservation immediately before
the injected client may send, so an unproven restart cannot silently resend. The
production Feishu HTTP adapter and composed real-account flow remain
unimplemented. The first Connector-owned macOS Keychain reader now resolves
validated Bot/User SecretReferences into callback-scoped, zeroed byte buffers,
but credential-bundle parsing, refresh, scopes, and HTTP composition remain
unimplemented. A presentation-safe diagnostics boundary now reports configured
Bot/User authorization and scope coverage, rate-limit state, and durable User
cursor freshness without exposing credentials or opaque cursor positions.
The local TD-209 contract acceptance path now composes verified-message
normalization, bounded context, an edited Draft revision, exact approval,
idempotent execution, receipt persistence, restart verification, and a complete local
Audit trace. The restart evidence is a deterministic acceptance completion,
not an automatic repair service. Stage 2 is not declared complete: production Feishu credential/HTTP
composition, hosted ingestion or polling, interactive Draft/approval UI, and a
live-account send remain unimplemented.
Versioned domain records and the product-owned Connector contract are
implemented. The pinned Harness Profile,
two draft-only Personas, JSONL restart recovery, and bounded Codex specialist
remain available as runtime compatibility evidence. The Harness Client Inbox
spike is diagnostic only.

## Development

TwinDesk uses Node.js 24 and pnpm 11.7.0. From a clean checkout, install the
exact dependency graph and run every scaffold check with:

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 run check
```

Run only the pinned Harness compatibility surface with:

```sh
corepack pnpm@11.7.0 run compat:check
```

Build and start the TwinDesk product UI on loopback with:

```sh
corepack pnpm@11.7.0 run web:build
corepack pnpm@11.7.0 run web:start -- --port 4173
```

Open `http://127.0.0.1:4173/inbox`. The product shell is separate from the
Harness diagnostic Profile described below.

The combined check covers formatting, TypeScript validation, unit tests, all
project-reference builds, the built Harness adapter boundary, production
Client bundle and source-map delivery, the dedicated compatibility suite, a
real Harness Profile startup, and repository structure. The Profile and Codex
smoke tests bind only temporary loopback ports and do not call an external model
or service.

Prepare and inspect the generated local Profile with:

```sh
corepack pnpm@11.7.0 run build
corepack pnpm@11.7.0 run profile:prepare
corepack pnpm@11.7.0 run profile:config
```

Start the Harness diagnostic Web Profile without automatically opening a
browser:

```sh
corepack pnpm@11.7.0 run profile:start -- --port 3080
```

Generated Harness state stays under the ignored `.twindesk/` directory.
