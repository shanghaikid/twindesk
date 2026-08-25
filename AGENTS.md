# TwinDesk Agent Instructions

## Scope

These instructions apply to the entire repository. A nested `AGENTS.md` may add package-specific rules; the closest applicable file takes precedence for files in its subtree.

## Read First

Before planning or changing product behavior, read:

1. `README.md`
2. `docs/PRODUCT_GOALS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`

Treat `docs/PRODUCT_GOALS.md` as the product source of truth. If implementation ideas conflict with its safety boundaries, MVP scope, or non-goals, stop and make the conflict explicit instead of silently changing the product.

## Product Invariants

- TwinDesk is a local-first, single-user work agent console.
- The default autonomy mode is `draft_only`.
- Reading, drafting, approving, and executing are separate states.
- An external write must pass policy checks and, when required, a one-time user approval bound to the exact target and content.
- Persona defines identity and behavior; Skill defines knowledge or procedure; Tool defines capability; Policy defines authority; Workflow or Team defines coordination. Do not merge these concepts or let one implicitly grant another.
- A Persona never gains more Feishu, Jira, filesystem, or model access than the authorized user and configured connector scopes.
- Use a single Agent by default. Subagents, Workflows, and Agent Teams are opt-in for tasks that benefit from decomposition.
- Do not make experimental Agent Teams part of an MVP-critical path.
- Do not claim that a Feishu application can read all of a user's messages. Represent Bot identity, User identity, visibility, polling, and event limitations accurately.

## Architecture Rules

- Use DeepSeek Harness as a replaceable Agent Runtime, not as the TwinDesk domain model.
- Prefer external, versioned Cordis plugins and Profile Bundles over modifying or forking DeepSeek Harness.
- Do not patch Harness core unless a documented compatibility spike proves that no supported extension point can satisfy the requirement.
- If a core patch is unavoidable, keep it minimal and generic, document the missing extension point, and keep all TwinDesk business logic outside the patch.
- Pin the exact Harness version or commit. Do not depend on a floating branch or range while Harness remains in developer preview.
- Keep Harness-specific types and lifecycle calls behind adapter packages.
- Keep `@twindesk/domain` independent of Cordis, Harness, Feishu, Jira, UI frameworks, and model SDKs.
- Keep Connector implementations independent from Persona prompts and UI presentation.
- Use separate persistence boundaries:
  - Harness Session storage for model, tool, approval, Subagent, and Workflow events.
  - TwinDesk storage for external events, Inbox state, sync cursors, drafts, action proposals, receipts, and business audit records.
- Never write TwinDesk domain tables into an internal Harness Session schema.
- Do not introduce a second implementation language only for preference. Use the language that best fits the selected extension boundary; record a decision before adding a Rust service or native component.

## Plugin Boundaries

Use the package direction defined in `docs/ARCHITECTURE.md`:

- `@twindesk/domain`
- `@twindesk/storage-sqlite`
- `@twindesk/plugin-work-hub`
- `@twindesk/plugin-feishu`
- `@twindesk/plugin-jira`
- `@twindesk/plugin-ui`
- `@twindesk/bundle-workbench`

Long-lived Feishu and Jira integrations must be formally installed Host plugins. Do not implement them as model-generated dynamic plugins. Dynamic plugins are high-trust, temporary capabilities and must not automatically receive credentials or restart persistence.

## Data and Event Rules

- Normalize external payloads into versioned TwinDesk domain events before routing them to Agents.
- Preserve stable external references and source timestamps.
- Every ingestion path must be idempotent and safe to replay.
- Persist a sync cursor only after all events before that cursor are durably committed.
- External writes must use an idempotency key when the target API supports one; otherwise store enough state to detect and surface uncertain retries.
- Raw external payload retention must be explicit and bounded. Prefer normalized fields plus source references.
- Derived Inbox projections must be rebuildable from immutable source events and explicit user actions.
- Treat partial context as a first-class state. A failed Jira lookup must not silently become an empty result or an invented fact.

## Security and Privacy

- Never store OAuth tokens, API keys, cookies, environment secrets, or private keys in source control, ordinary SQLite columns, Session logs, prompts, fixtures, snapshots, or exported diagnostics.
- Store secrets in the system Keychain or a dedicated encrypted secret store; persist only secret references in business data.
- Apply redaction before logs, model requests, error serialization, telemetry, and exports.
- Do not persist hidden chain-of-thought. Persist user-visible decision summaries, inputs, tool calls, approvals, outputs, costs, and errors.
- Display the exact account, identity, target, and final content before an approved external write.
- Fail closed when approval, identity, scope, target, or idempotency state is missing or ambiguous.
- Destructive, bulk, permission-changing, or public-representation actions cannot be enabled solely by Persona configuration.
- Tests and fixtures must use synthetic data. Do not copy real company messages, documents, Jira issues, credentials, or personal information into the repository.

## Agent and Model Rules

- Keep model providers replaceable behind an explicit adapter.
- Do not bind a Persona permanently to one model vendor.
- Use Codex as a code and repository specialist, not as the implicit runtime for every Persona.
- Child Agents inherit the same or narrower authority. They cannot request broader scopes or bypass the Lead's approval boundary.
- Put limits on Agent count, delegation depth, concurrency, runtime, token use, and tool calls.
- A Team result is a proposal until the normal TwinDesk policy and approval path accepts its actions.

## Implementation Quality

- Prefer small packages with narrow public interfaces over cross-package imports into implementation internals.
- Validate all untrusted API, database, configuration, plugin, and model data at its boundary.
- Version persisted event and configuration shapes from their first committed use.
- Add forward migrations for TwinDesk databases. Never rely on deleting a user's database to upgrade.
- Make cancellation and shutdown explicit for background services. Flush durable cursors and stop accepting new work before teardown.
- Propagate actionable, typed errors. Do not turn connector failures into empty successful results.
- Avoid speculative abstractions that do not support a current roadmap requirement.
- Do not add a vector database until a measured retrieval requirement cannot be met by SQLite indexing and explicit references.

## Required Tests

Changes must be verified in proportion to risk. For affected behavior, include tests for:

- duplicate and out-of-order external events;
- restart and cursor recovery;
- interrupted writes and uncertain external API results;
- approval rejection, cancellation, and missing responders;
- identity and scope mismatches;
- log and export redaction;
- partial connector failures;
- Harness adapter compatibility;
- database migrations and deletion/export behavior;
- Subagent or Workflow budget and permission inheritance when applicable.

Every external write implementation requires an idempotency test. Every persisted feature requires a restart recovery test. Every field that may contain company or personal data requires a redaction and retention review.

## Documentation

- Update product documents when behavior, scope, security boundaries, or milestones change.
- Record material architecture decisions in `docs/decisions/` as short ADRs once that directory exists.
- State assumptions and unresolved constraints; do not present a prototype limitation as a supported guarantee.
- Link to upstream Harness behavior when an implementation depends on an unstable or experimental API.

## Git and Workspace Hygiene

- Preserve unrelated user changes and keep patches scoped to the active task.
- Do not commit generated data, databases, logs, artifacts, credentials, or real company content.
- Do not use destructive Git commands unless the user explicitly requests them.
- Commits intended for pull requests must include DCO sign-off using `git commit --signoff` or `git commit -s`.
- Before opening or updating a pull request, verify every commit in the PR range contains a matching `Signed-off-by` line.
- Do not create a commit, branch, remote, or pull request unless the user asks for it.

## Current Phase

The repository is currently in Roadmap Stage 0. Prioritize proving external plugin viability, Client UI extension points, Agent Presets, Session persistence, and Codex Subagent composition before building the full product. Replace this section when the project advances to the next stage.

## Completion Checklist

Before reporting a task complete:

1. Confirm the change remains within the active roadmap stage or explicitly document why it expands scope.
2. Run the smallest relevant tests plus any required risk tests above.
3. Inspect the diff for secrets, real company data, unrelated edits, and accidental generated files.
4. Update affected documentation and compatibility notes.
5. Report what changed, what was verified, and any remaining limitation.
