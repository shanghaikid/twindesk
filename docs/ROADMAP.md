# TwinDesk Roadmap

## Stage 0: Harness Compatibility Validation

Goal: prove that key capabilities can be implemented through out-of-tree plugins before investing in product development.

- Pin a DeepSeek Harness version.
- Create a minimal Profile Bundle.
- Create a Host plugin and register one read-only Tool.
- Create a Client plugin and validate a settings card.
- Determine whether Harness should own the product shell and select a viable
  no-fork alternative when its public Client surface is insufficient.
- Create two Agent Presets.
- Enable Session persistence and verify restart recovery.
- Verify installation of `subagent-codex` and one delegation run.
- Run every selected extension seam through one pinned compatibility command.
- Record the minimum list of required Harness core changes.

Exit criterion: the product experience can be built without a Harness fork,
Harness-specific domain logic, or an unverified runtime boundary.

Current gate status (2026-08-26): **PASSED**. TwinDesk owns a standalone
loopback Web shell and keeps Harness behind the runtime adapter; all four
criteria are verified in [the TD-052 exit-gate audit](STAGE_0_EXIT_GATE.md).
Stage 1 is complete.

## Stage 1: Local Work Hub

Goal: establish domain and persistence layers with no external side effects.

- Define ExternalEvent, WorkItem, Thread, and Draft data models.
- Implement the SQLite schema, migrations, idempotent writes, and synchronization cursors.
- Implement the Inbox API and basic page.
- Map Persona configuration to Harness Presets.
- Implement a local Audit Timeline.
- Add credential references and a shared redactor.
- Test restart, duplicate events, cursor rollback, and data deletion.

Exit criterion: fixture events can complete the Inbox → Persona → Draft → Audit
flow. **Passed on 2026-08-27**; see the
[Stage 1 exit-gate audit](STAGE_1_EXIT_GATE.md).

## Stage 2: Feishu Closed-Loop MVP

Goal: complete the first real end-to-end value loop.

- Consume Bot message events.
- Incrementally read messages under User identity.
- Retrieve context and attachment references.
- Implement the Feishu reply Tool.
- Add Draft editing.
- Add one-time approval.
- Implement idempotent sending.
- Add Connector health and permission diagnostics.

Exit criterion: a real Feishu message can safely produce an approved and sent reply, with a complete trace.

Current gate status (2026-08-31): **NOT PASSED**. The local contract acceptance
path now completes normalization → Inbox → bounded context → edited Draft →
one-time approval → idempotent receipt → Audit across restart with synthetic
clients. Durable pre-send dispatch reservation is now covered by synthetic
restart tests. Versioned Bot/User credential parsing and refresh-state
classification plus the OAuth v3 refresh request/response contract are now
covered synthetically. Durable single-Host refresh reservation, exact Keychain
replacement, restart reconciliation, exact post-exchange `open_id` binding,
the bounded production user-info Fetch client, and the state-bound S256 PKCE
exchange through verified initial Keychain replacement and restart parsing are
also covered without live I/O. Explicit reauthorization now replaces a durable
blocked state through a version 3 journal while preserving version 1 and 2
history. Its durable-before-Keychain replacement reservation makes uncertain
writes reconciliation-required across restart. A
kernel-backed exclusive Host lease passes real cross-process and process-death
tests. Fixed Bot/User reply and User-discovery scope gates also pass synthetic
contracts, and the User gate now reads the exact Keychain token claims while
requiring rotation first when needed. A bounded fixed-endpoint Bot tenant-token
client and exact Keychain-to-token scope probe now pass synthetic contracts
without live I/O; the probe verifies the current Bot `open_id` and tenant-only
application scopes. A fixed-endpoint bounded reply HTTP primitive now passes
synthetic contracts without claiming remote reconciliation. Send-only reply
execution now requires a first durable dispatch reservation and blocks any
unproven resend across restart. The Workbench composition root now binds the
Connector-neutral Host approval operation to the real kernel lease and the
concrete Bot/User reply stack; a synthetic full-stack User test proves one
durably rotated expired token, one send, and no resend after restart and
approval expiry. A separate Workbench host now holds the same lease while the
existing coordinator persists already-exchanged blocked-state reauthorization
evidence, without starting OAuth or retrying a reply. The required live-account
path now has a production-shaped loopback Bot callback Host with app-bound
Keychain secrets, URL verification, durable normalization, and exact
acknowledgement, but public forwarding, subscription setup, live Bot delivery,
and live polling acceptance remain missing. Cordis now starts the
production-shaped User polling composition and existing Web operations beneath
one shared top-level lease when a Host tenant key and restart-loaded User
identity are present. The product Web boundary can render a minimized read-only Feishu
Settings status, and the default launcher injects the fixed-path Workbench
reader. The product can now edit an existing User identity's non-secret
literal-loopback callback and requested scopes behind same-origin,
Fetch-Metadata, and CSRF checks. An empty installation can also create one
non-secret Bot or User identity and then add the missing slot to the same
application. Workbench generates the internal account and distinct
Keychain-reference locators without accepting a credential or event-subscription
secret during identity creation. Once Settings are ready, the
same page can start one explicit initial User OAuth attempt, present the
lease-held authorization URL for a user click, cancel it, and report only a
memory-local minimized result. Synthetic tests cover the loopback boundary and
verified persistence composition without a live account. The fixed private
macOS data root now also constructs the separate secret-free OAuth rotation
journal, so later reauthorization and reconciliation can recover the same
evidence after restart without placing it in Settings. An identifier-free
read-only projection now surfaces whether that journal is settled, active, or
requires reauthorization/reconciliation and blocks unsafe initial-authorization
retries; it does not inspect credential health or grant an automatic retry.
The Connectors page now separately runs production-shaped read-only diagnostics
beneath the shared Host lease: Bot identity and scopes are checked remotely,
User credential and combined operation scopes are checked from the current
Keychain bundle, the durable polling cursor is classified, and terminal polling
state carries a fixed recovery action. The browser receives no account,
principal, SecretReference, token, cursor position, raw error, or rate count.
This synthetic composition does not replace live-account acceptance, and User
connectivity plus rate state remain unproven.
A versioned Stage 2 live-readiness command can now verify the bounded local
prerequisites without promoting synthetic or loopback evidence to live proof.
An explicit local reconciliation action now compares the exact configured
Keychain bundle with unresolved journal evidence under the Host lease and can
settle only a strictly newer identity-bound result. It performs no OAuth,
refresh request, or Keychain write. Its default Workbench composition now
persists request/result business Audit around the effect and repairs an
interrupted settlement from the secret-free journal without rereading Keychain.
The blocked-state runtime can now reconstruct the registered callback and
production adapters from restart-safe Settings, then hold one lease through
code exchange, a durable replacement reservation, verified Keychain
replacement, and journal settlement. The
default Web composition now exposes that runtime through a separate
recovery-gated controller and CSRF-bound local API. The Connectors page requires
an explicit click, polls only minimized memory state, supports cancellation,
and never converts reconciliation evidence into an automatic retry. Work Hub
now composes one Persona-mapped pinned Harness Agent run through a required
Session flush and cold persisted-turn validation into one bounded `editing`
Draft and restart-repairable business Audit. Exact Session replay recovers with
zero model calls and grants no approval or write authority. The product Web
shell now adds a strict Work Item-only Draft intent while Workbench owns the
redacted prompt, runtime identities, and explicit provider/model route. The standalone launcher
advertises this capability as unavailable until a Harness Host injects that
runtime; no browser field can select or credential a provider.
Existing-identity replacement, credential
repair/removal, out-of-process configuration watching, live authorization and
reauthorization acceptance, credential-healthy production provider acceptance,
and a real Feishu send remain missing. Local model Draft editing, explicit
`ready_for_review`, an exact persisted Feishu User reply preview, fixed-lifetime
one-time approval decisions, the separate approved execution action, and
read-only browser-refresh restoration are now available. See the
[Stage 2 exit-gate audit](STAGE_2_EXIT_GATE.md).

## Stage 3: Jira Context

Goal: allow Feishu drafts to use verified project facts.

- Add Jira OAuth or API Token support.
- Incrementally synchronize Issues and Comments.
- Implement a JQL search Tool.
- Associate Work Items with Issues.
- Degrade gracefully and display incomplete context when Jira is unavailable.
- Keep Jira writes disabled or behind an experimental flag initially.

Exit criterion: a Feishu draft can cite verifiable Jira status while Jira failures do not block the primary flow.

## Stage 4: Multiple Personas and Specialist Subagents

Goal: turn “multiple versions of me” into a comprehensible and controllable product capability.

- Build a Persona editor.
- Visualize Skill selection and overrides.
- Configure Tool and data scopes.
- Configure autonomy levels and budgets.
- Add Codex as a code specialist.
- Add one-shot Subagents such as Drafter and Critic.
- Compare run cost and outcomes.

Exit criterion: users can explain the identity, capability, and authority differences among Personas and can predict their behavioral boundaries.

## Stage 5: Teams, Automation, and Desktop Experience

Goal: add complex collaboration capabilities on top of an established safety loop.

- Add Team Templates.
- Add dynamic Workflows.
- Evaluate experimental Agent Teams.
- Enable Jira write operations.
- Add allowlisted low-risk automation.
- Add a Webhook Relay.
- Add a desktop shell, system tray, and notifications.

This stage must not begin before the project has real MVP usage feedback.

## Development Constraints

- Every stage must include restart recovery tests.
- Every external write must include an idempotency test.
- Every Harness upgrade must run composition compatibility tests.
- Every log field that may contain credentials or company data must pass redaction tests first.
- Experimental capabilities must remain behind feature flags.
- Accept product work by completed user loops, not by package or interface count.
