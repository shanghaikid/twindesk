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
- [Stage 2 Live-Readiness Check](docs/STAGE_2_LIVE_READINESS.md): bounded loopback preflight for the remaining explicit live-account steps.
- [Feishu Bot and User Identities](docs/FEISHU_IDENTITIES.md): separate principals, credential-reference persistence, privacy, and current connection limits.
- [Feishu Bot Event Ingestion](docs/FEISHU_BOT_EVENT_INGESTION.md): signed direct-message and mention callbacks, hash-only durable deduplication, privacy, and hosting limits.
- [Feishu User Message Discovery](docs/FEISHU_USER_MESSAGE_DISCOVERY.md): bounded user-authorized search windows, replay-safe candidate cursors, partial coverage, and adapter limits.
- [Feishu Context Retrieval](docs/FEISHU_CONTEXT_RETRIEVAL.md): bounded User-identity conversation, document-excerpt, and attachment context with explicit partial states.
- [Feishu Message Normalization](docs/FEISHU_MESSAGE_NORMALIZATION.md): canonical Bot/User events, Inbox routing, replay, privacy, and atomic event/projection/cursor commits.
- [Feishu Reply Proposal](docs/FEISHU_REPLY_PROPOSAL.md): Draft-bound preview construction, explicit sending identity and target binding, idempotency, and no-side-effect limits.
- [One-Time Action Approval Policy](docs/ACTION_APPROVAL_POLICY.md): exact identity/target/content binding, expiration, responder decisions, one-time consumption, and execution separation.
- [Work Hub Action Execution Host](docs/ACTION_EXECUTION_HOST.md): exclusive-operation approval consumption, durable dispatch and receipt ordering, and no-resend Audit recovery.
- [Workbench Feishu Reply Runtime](docs/WORKBENCH_FEISHU_REPLY_RUNTIME.md): production-shaped binding of the durable Host operation, real runtime lease, and concrete Feishu reply stack.
- [Workbench Feishu Reply Proposal UI](docs/WORKBENCH_FEISHU_REPLY_PROPOSAL_UI.md): exact Host-derived User reply preview with no approval or execution authority.
- [Workbench Feishu Reply Approval UI](docs/WORKBENCH_FEISHU_REPLY_APPROVAL_UI.md): fixed-lifetime exact approval request and decision controls with content-free Audit.
- [Workbench Feishu Reply Execution UI](docs/WORKBENCH_FEISHU_REPLY_EXECUTION_UI.md): separate external-write control, Host-only durable ID resolution, and minimized terminal or uncertain results.
- [Workbench Feishu Reply Flow Restoration](docs/WORKBENCH_FEISHU_REPLY_FLOW_RESTORATION.md): read-only refresh recovery of the exact durable Draft, proposal, approval, and receipt presentation.
- [Feishu Reply Execution](docs/FEISHU_REPLY_EXECUTION.md): optional exact reconciliation, send-only durable dispatch safety, normalized receipts, restart recovery, and uncertain-result handling.
- [Feishu Reply Execution Adapter](docs/FEISHU_REPLY_EXECUTION_ADAPTER.md): lease-held Bot/User scope, Keychain, token, and fixed HTTP composition with preflight-safe retry handling.
- [Feishu Reply HTTP Client](docs/FEISHU_REPLY_HTTP_CLIENT.md): fixed-endpoint plain-text delivery, bounded responses, payload-free errors, and conservative post-send ambiguity.
- [Feishu Connector Diagnostics](docs/FEISHU_CONNECTOR_DIAGNOSTICS.md): per-identity authorization/scopes, normalized rate limits, redacted cursor freshness, and overall health.
- [Feishu System Keychain Resolution and Replacement](docs/FEISHU_SYSTEM_KEYCHAIN.md): fixed macOS SecretReference lookup, stdin-only OAuth replacement, uncertain writes, and transient-byte cleanup.
- [Feishu Credential Bundles](docs/FEISHU_CREDENTIAL_BUNDLES.md): versioned Bot/User secret parsing, rotated User encoding, exact identity/lifetime checks, and callback-scoped zeroing.
- [Feishu OAuth v3 Refresh](docs/FEISHU_OAUTH_V3_REFRESH.md): exact form request, rotating-token response validation, recovery classification, and transient-secret cleanup.
- [Feishu OAuth Rotation Coordinator](docs/FEISHU_OAUTH_ROTATION_COORDINATOR.md): durable-before-remote reservation, Keychain replacement, restart reconciliation, and secret-free journal state.
- [Feishu OAuth User Principal Verification](docs/FEISHU_OAUTH_PRINCIPAL_VERIFICATION.md): exact `open_id` binding, fixed-endpoint bounded HTTP, minimized user-info data, and transient-secret cleanup.
- [Feishu OAuth Authorization Code and PKCE](docs/FEISHU_OAUTH_AUTHORIZATION_CODE.md): one-use state-bound authorization, exact callback validation, PKCE exchange, and replay handling.
- [Feishu OAuth Authorization Configuration](docs/FEISHU_OAUTH_AUTHORIZATION_CONFIGURATION.md): versioned app-bound scopes and exact registered literal-loopback redirect settings.
- [Feishu OAuth Loopback Callback Host](docs/FEISHU_OAUTH_LOOPBACK_CALLBACK_HOST.md): bounded one-shot literal-loopback redirect capture and lifecycle cleanup.
- [Workbench Feishu OAuth Authorization Runtime](docs/WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_RUNTIME.md): lease-held initial authorization from loopback capture through verified Keychain persistence.
- [Workbench Feishu OAuth Authorization UI](docs/WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_UI.md): explicit loopback-only initial authorization entry, minimized status, transient app-secret handling, and cancellation.
- [Workbench Feishu OAuth Recovery Presentation](docs/WORKBENCH_FEISHU_OAUTH_RECOVERY_PRESENTATION.md): identifier-free durable rotation status and fail-closed initial-authorization gating.
- [Workbench Feishu OAuth Reconciliation](docs/WORKBENCH_FEISHU_OAUTH_RECONCILIATION.md): explicit lease-held local Keychain/journal comparison without OAuth, refresh, or credential writes.
- [Workbench Feishu OAuth Reauthorization UI](docs/WORKBENCH_FEISHU_OAUTH_REAUTHORIZATION_UI.md): recovery-gated explicit replacement authorization, separate local capability, minimized polling, and cancellation.
- [Workbench Local Data Paths](docs/WORKBENCH_LOCAL_DATA_PATHS.md): private macOS product Settings and OAuth recovery-state paths with restart-safe Feishu store construction.
- [Workbench Feishu Settings Presentation](docs/WORKBENCH_FEISHU_SETTINGS_PRESENTATION.md): minimized read-only Connector status for the local Web boundary.
- [Workbench Feishu OAuth Settings Editing](docs/WORKBENCH_FEISHU_OAUTH_SETTINGS_EDITING.md): app-bound non-secret OAuth configuration editing with a local request-forgery boundary.
- [Workbench Feishu User Identity Bootstrap](docs/WORKBENCH_FEISHU_USER_IDENTITY_BOOTSTRAP.md): create-only User metadata and generated Keychain-reference setup without accepting a credential.
- [Workbench Feishu Bot Identity Bootstrap](docs/WORKBENCH_FEISHU_BOT_IDENTITY_BOOTSTRAP.md): create-only Bot metadata and a separate generated app-credential Keychain reference without collecting secrets.
- [Feishu OAuth Verified Initial Persistence](docs/FEISHU_OAUTH_INITIAL_PERSISTENCE.md): verified User token snapshot, exact initial Keychain replacement, and uncertain-write recovery.
- [Feishu OAuth Reauthorization Replacement](docs/FEISHU_OAUTH_REAUTHORIZATION.md): explicit blocked-state replacement, journal migration, and restart reconciliation.
- [Workbench Feishu OAuth Reauthorization Runtime](docs/WORKBENCH_FEISHU_OAUTH_REAUTHORIZATION_RUNTIME.md): lease-held blocked-state callback, exchange, verified replacement, and restart-loaded production composition.
- [Workbench Model Draft Product Entry](docs/WORKBENCH_MODEL_DRAFT_PRODUCT_ENTRY.md): Work Item-only browser intent with Host-owned redacted prompt, provider/model route, and durable local Draft recovery.
- [Workbench Cordis Model-Draft Runtime](docs/WORKBENCH_CORDIS_MODEL_DRAFT_RUNTIME.md): Cordis-owned product Web and Harness runner lifecycle with Host-only route configuration and normal shutdown.
- [Workbench Model Draft Editing](docs/WORKBENCH_MODEL_DRAFT_EDITING.md): atomic local revisions, explicit ready-for-review state, user Audit, and restart repair without approval authority.
- [Feishu Operation Scope Authorization](docs/FEISHU_OPERATION_SCOPE_AUTHORIZATION.md): fixed Bot/User operation policies and fresh fail-closed scope evidence.
- [Feishu User Credential Scope Probe](docs/FEISHU_USER_CREDENTIAL_SCOPE_PROBE.md): exact Keychain OAuth scope observation, refresh gating, and transient-secret cleanup.
- [Feishu Bot Tenant Token Acquisition](docs/FEISHU_BOT_TENANT_TOKEN_ACQUISITION.md): fixed-endpoint bounded token acquisition, callback-scoped cleanup, and the separate scope-observation boundary.
- [Feishu Bot Keychain Scope Probe](docs/FEISHU_BOT_KEYCHAIN_SCOPE_PROBE.md): exact Bot credential composition, remote principal verification, and tenant-only scope evidence.
- [Feishu Runtime Lease](docs/FEISHU_RUNTIME_LEASE.md): kernel-backed cross-process Host exclusion, cancellation behavior, and crash release.
- [SQLite Storage](docs/STORAGE_SQLITE.md): TwinDesk database identity, schema, forward migrations, privacy review, and recovery guarantees.
- [External Event Ingestion](docs/EVENT_INGESTION.md): transactional deduplication, replay, conflict, and out-of-order semantics.
- [Durable Synchronization Cursors](docs/SYNC_CURSORS.md): atomic event/checkpoint commits, restart recovery, and regression rules.
- [Work Item Projections](docs/WORK_ITEM_PROJECTIONS.md): event-anchored projection writes, revisioned user actions, rebuilds, and Inbox pagination.
- [Fixture-driven Inbox](docs/FIXTURE_INBOX.md): synthetic four-state Work Hub data, loopback read API, UI behavior, and restart limits.
- [Persona to Harness Preset Mapping](docs/PERSONA_PRESET_MAPPING.md): versioned built-in behavior mapping and its non-authority boundary.
- [Draft and ActionProposal Transitions](docs/DRAFT_ACTION_TRANSITIONS.md): local state machines, exact content binding, replay, and no-side-effect boundary.
- [Local Audit Timeline](docs/AUDIT_TIMELINE.md): immutable business records, cross-store references, pagination, and presentation redaction.
- [Connector Maintenance Audit Protocol](docs/CONNECTOR_MAINTENANCE_AUDIT.md): atomic request/result Audit, restart-visible pending operations, and Connector-only retention.
- [Secret References and Shared Redaction](docs/SECRET_REFERENCES_AND_REDACTION.md): opaque secret locators, boundary policies, failure behavior, and current limitations.
- [Thread Export and Deletion](docs/THREAD_EXPORT_AND_DELETION.md): aggregate export, revision-bound deletion, durable tombstones, and explicit retention behavior.
- [Harness Upstream Navigation Proposal](docs/HARNESS_UPSTREAM_NAVIGATION_PROPOSAL.md): an optional ecosystem reference for generic Harness Client extensibility.
- [Inbox Extension Spike](docs/INBOX_EXTENSION_SPIKE.md): out-of-tree route and sidebar findings, limitations, and compatibility seams.
- [ADR 0001](docs/decisions/0001-upstream-generic-inbox-extension-points.md): historical Harness Client investigation and upstream path.
- [ADR 0002](docs/decisions/0002-twindesk-owned-product-web-shell.md): accepted standalone product UI boundary.
- [ADR 0003](docs/decisions/0003-macos-local-data-root.md): accepted private macOS product-data root.
- [ADR 0004](docs/decisions/0004-feishu-oauth-recovery-journal-path.md): accepted secret-free Feishu OAuth recovery journal path.

## Current Status

Stages 0 and 1 are complete and the project is currently in Roadmap Stage 2. The
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
write. Production-shaped Feishu diagnostics are implemented, but live credential
health is not accepted; user-created Personas and hosted Connector subscriptions
are not implemented. A Host-controlled model-Draft entry covers initial generation
synthetically. The standalone `web:start` launcher remains unavailable by
design, while the Workbench Harness Profile now owns the product Web and
configured model route through a disposable Cordis lifecycle. Credential health
and live generation are not yet proven. The Profile-owned Inbox can preserve
the model output, create user-edited revisions, and mark a Draft
`ready_for_review` without granting approval or write authority.
For a persisted Feishu Work Item, the Inbox can now turn that exact Draft into
a restart-safe User-identity reply preview. The Host selects the configured
account and latest unique message target; the page displays account, identity,
target, risk, and exact content. It can then request a fixed 15-minute approval
window and explicitly approve once, reject, or cancel while re-displaying those
exact fields. A separate execution control then re-displays the exact action,
consumes the approval once, and reports a minimized durable result; only that
final click may send.
Stage 2 identity configuration now distinguishes Feishu Bot application
credentials from User OAuth credentials and persists only opaque secret
references. The Feishu plugin now verifies and decrypts Bot direct-message and
exact-mention callbacks, then records restart-durable hash-only message receipts.
It also produces replay-safe candidate cursors for bounded message search under
the separate User identity while explicitly reporting partial coverage, and it
validates bounded conversation, document-excerpt, and attachment context without
returning binary files. Verified Bot messages and bounded User discovery batches
now normalize into canonical ExternalEvents and event-anchored Inbox Work Items;
User events, projections, and candidate cursors share one transaction. The
product Inbox now reads all durable Work Items rather than only known fixtures.
A fixed loopback Bot callback route resolves an app-bound event-subscription
bundle from Keychain per request, performs signed URL verification, and commits
accepted messages before acknowledgement under the Cordis lease. It has no
configured public ingress or live-account acceptance. The production polling
and diagnostics compositions also resolve configured Keychain references, but
their live-account behavior is not yet accepted. A Draft-bound Feishu reply can now be packaged as a local
plain-text ActionProposal with an explicit Bot or User identity and exact
message target. The local approval policy can now bind that proposal to an
explicit responder decision and expiration, then consume the approval once
into one stable execution attempt. The Feishu execution boundary now
uses exact reconciliation before sending when an adapter can prove it. Because
Feishu does not expose reply `uuid` in history, a send-only adapter may instead
make its first call only after a durable SQLite dispatch reservation. Any prior
or uncertain reservation blocks another send. Normalized success, failure, or
uncertain receipts persist atomically with proposal state. The production reply
client now composes the held runtime lease, exact Bot/User
scope probes, Keychain credential callbacks, tenant-token acquisition, and the
bounded reply HTTP primitive without exposing tokens. A Connector-neutral Work
Hub operation now wraps exclusive ownership, approval, execution state, durable
dispatch, receipt, and recoverable Audit completion. The Workbench root now
binds that Host operation to the Feishu adapter; the real-account flow remains
unimplemented. The Connector-owned macOS Keychain reader now resolves
validated Bot/User SecretReferences into callback-scoped, zeroed byte buffers,
and a versioned parser binds Bot application and User OAuth bundles to the exact
configured identity, reports usable, refresh-required, or reauthorization
state, and clears derived secret buffers after use. An OAuth v3 boundary now
validates single-use refresh responses, authoritative scopes, server lifetimes,
and reauthorization failures, with a fixed-endpoint production Fetch transport
that rejects redirects and bounds streamed responses. A single-Host coordinator
now reserves refresh attempts durably before network access, replaces the exact
Keychain bundle, and blocks unproven restarts from reusing an old token.
Post-exchange principal verification now binds a fresh User token to the exact
configured `open_id` through a fixed-endpoint, bounded production Fetch client.
Authorization-code/PKCE exchange, verified initial Keychain persistence, and an
explicit reauthorization replacement path now pass synthetic contracts. The
Workbench can also rebuild the exact registered-loopback authorization Host
from restart-safe identity and authorization Settings stores. Those stores now
have a private macOS product path outside the checkout. A minimized read-only
projection can now show identity types and OAuth configuration completeness on
the product Connectors page. The default `web:start` launcher opens the fixed
macOS stores through the Workbench composition and injects that Settings service. When a
User identity already exists, the same page can update only its non-secret
literal-loopback OAuth callback and requested scopes through an exact
same-origin, Fetch-Metadata- and CSRF-bound local POST. It can also bootstrap a
first User or Bot identity from an empty installation, then add the missing
identity to the same Feishu application. Workbench generates the internal
account and distinct Keychain-reference locators; identity creation itself
submits no credential or event-subscription secret and does not imply
authorization or connectivity. Once those non-secret Settings are ready, a
separate Connectors form can start one explicit initial User OAuth attempt. Its
transient app secret stays within the loopback request and lease-held runtime,
the Feishu authorization URL requires a user click, and success means only that
this attempt principal-verified and persisted the initial Keychain credential.
It does not claim current connectivity or scope health. The
same page now reads a separate identifier-free durable recovery projection.
It distinguishes no history, settled rotation, active rotation,
reauthorization-required, and reconciliation-required states without exposing
journal sequence or timestamps. Unavailable or unresolved recovery state
blocks another initial authorization attempt. Only the exact durable
reauthorization-required state reveals a separate explicit replacement action;
reconciliation-required states remain blocked without retry. The
Workbench reauthorization runtime now holds the exclusive kernel-backed lease
from blocked-state inspection through registered-loopback callback, code
exchange, principal verification, Keychain replacement, and journal settlement.
Journal version 3 fsyncs a replacement reservation before principal verification
or Keychain access, so an uncertain write or process restart presents
reconciliation instead of enabling another authorization.
The Connectors page can now explicitly compare that unresolved journal with the
exact configured local Keychain bundle while holding the Feishu Host lease. It
settles only strictly newer identity-bound evidence and has no refresh transport
or Keychain writer.
It can reconstruct production collaborators from restart-safe Settings and an
explicit concrete journal, and the default product composition supplies that
journal. The Connectors page reaches it through a separately CSRF-bound local
API, keeps status memory-only, requires a user click to open Feishu, and clears
TwinDesk-owned app-secret buffers.
Fixed operation-level
scope authorization for reply and User discovery now passes synthetic
contracts, and the User gate reads exact current Keychain token claims. A fixed-endpoint bounded Bot
tenant-token client and its exact Keychain-to-token scope probe now pass
synthetic contracts without a live credential. The probe verifies the remote
Bot principal and retains only current tenant scopes. A bounded fixed-endpoint
plain-text reply HTTP primitive and its lease-held Bot/User execution adapter
also pass synthetic contracts. The Workbench composition root now binds the
Connector-neutral Host orchestration, real lease, durable User rotation, and
adapter in a complete synthetic User reply test. A
presentation-safe diagnostics boundary now reports configured
Bot/User authorization and scope coverage, rate-limit state, and durable User
cursor freshness without exposing credentials or opaque cursor positions.
The local TD-209 contract acceptance path now composes verified-message
normalization, bounded context, an edited Draft revision, exact approval,
idempotent execution, receipt persistence, restart verification, and a complete local
Audit trace. The restart evidence is a deterministic acceptance completion,
not an automatic repair service. The Inbox now has a Host-controlled model-Draft
entry. The standalone launcher correctly reports its Agent Runtime as
unavailable, while `profile:start` injects the pinned Harness runner and
Host-selected route. Stage 2 is not
declared complete: public Bot callback forwarding and live delivery, live
polling acceptance, remaining Connector lifecycle wiring, production provider
activation, and a live-account send remain unimplemented. The Inbox now restores the exact durable Draft, proposal,
approval, and receipt presentation after refresh without mutating local state
or invoking a Connector.
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

Open `http://127.0.0.1:4173/inbox`. This standalone product shell intentionally
reports model generation as unavailable because it owns no Harness lifecycle.

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

Start the Harness Profile and its Cordis-owned product Web without automatically
opening a browser:

```sh
corepack pnpm@11.7.0 run profile:start -- --port 3080
```

The Harness diagnostic UI binds to port `3080`; the product Inbox binds to
`http://127.0.0.1:4173/inbox` by default. Provider/model and product port may be
set with the non-secret Host variables documented in
[Workbench Cordis Model-Draft Runtime](docs/WORKBENCH_CORDIS_MODEL_DRAFT_RUNTIME.md).
The optional Feishu tenant and Bot event Keychain-reference variables, fixed
callback path, bundle format, and user-managed TLS forwarding requirement are
documented in [Feishu Bot Event Ingestion](docs/FEISHU_BOT_EVENT_INGESTION.md).

Generated Harness state stays under the ignored `.twindesk/` directory.
