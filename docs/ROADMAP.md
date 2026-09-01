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
blocked state through a version 2 journal while preserving version 1 history. A
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
path is still missing hosted ingestion or polling and Cordis lifecycle
composition. The product Web boundary can render a minimized read-only Feishu
Settings status, and the default launcher injects the fixed-path Workbench
reader. The product can now edit an existing User identity's non-secret
literal-loopback callback and requested scopes behind same-origin,
Fetch-Metadata, and CSRF checks. Cordis activation, identity/SecretReference
editing, actual credential and authorization flows,
credential-recovery UI, interactive Draft and approval UI, model-backed
linkage, and a real Feishu send. See the
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
