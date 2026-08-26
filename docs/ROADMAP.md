# TwinDesk Roadmap

## Stage 0: Harness Compatibility Validation

Goal: prove that key capabilities can be implemented through out-of-tree plugins before investing in product development.

- Pin a DeepSeek Harness version.
- Create a minimal Profile Bundle.
- Create a Host plugin and register one read-only Tool.
- Create a Client plugin and validate a settings card.
- Determine whether a top-level Inbox page and navigation entry can be added.
- Create two Agent Presets.
- Enable Session persistence and verify restart recovery.
- Verify installation of `subagent-codex` and one delegation run.
- Run every selected extension seam through one pinned compatibility command.
- Record the minimum list of required Harness core changes.

Exit criterion: the product experience can be built without a fork, using at most one minimal, product-neutral Client navigation and page extension accepted upstream.

Current gate status (2026-08-26): **NOT PASSED**. The pinned Harness release
lacks the accepted generic Client navigation, keyed-page, and route lifecycle;
see [the TD-052 exit-gate audit](STAGE_0_EXIT_GATE.md). Stage 1 remains gated.

## Stage 1: Local Work Hub

Goal: establish domain and persistence layers with no external side effects.

- Define ExternalEvent, WorkItem, Thread, and Draft data models.
- Implement the SQLite schema, migrations, idempotent writes, and synchronization cursors.
- Implement the Inbox API and basic page.
- Map Persona configuration to Harness Presets.
- Implement a local Audit Timeline.
- Add credential references and a shared redactor.
- Test restart, duplicate events, cursor rollback, and data deletion.

Exit criterion: fixture events can complete the Inbox → Persona → Draft → Audit flow.

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
