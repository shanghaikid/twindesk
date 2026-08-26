# Stage 0 Harness Compatibility Report

- Report date: 2026-08-26
- TwinDesk evidence baseline: `3f2f5beb4266531ac40a02071a4cc414fdc6626a`
- Harness package: `@deepseek-ai/dsh@0.1.1-rc.2`
- Harness tag: `dsh-v0.1.1-rc.2`
- Harness commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Official package-local Codex: `@openai/codex@0.147.0`

## Recommendation

**GO for Stage 1 with Harness retained as a replaceable Agent Runtime.**

The formal [TD-052 exit-gate audit](STAGE_0_EXIT_GATE.md) records this as
**PASSED** after [ADR 0002](decisions/0002-twindesk-owned-product-web-shell.md)
selected a standalone TwinDesk-owned product shell.

The runtime and Host extension model are viable without a fork. TwinDesk can
formally install out-of-tree Host and Client plugins, register read-only Tools
and Settings, compose distinct Agent Presets, recover Sessions, and run a
traceable read-only Codex specialist. No TwinDesk domain logic or local Harness
core patch is required for those capabilities.

Harness `0.1.1-rc.2` exposes
no public primary-navigation registration, keyed top-level page registry, or
route lifecycle. The Stage 0 plugin can display a diagnostic Inbox only by
owning a browser hash, placing its entry in the sidebar footer, and shadowing
the `conversation` slot. That remains a diagnostic-only limitation, not a
product blocker: `@twindesk/web` now owns product navigation and browser routes.

This recommendation authorizes the fixture-driven Stage 1 backlog only. It does
not authorize real Connector writes or weaken the draft, approval, identity,
idempotency, redaction, retention, and restart requirements.

## Validated Baseline

The baseline is an exact published dependency graph, not a floating branch:

| Component | Validated value |
|---|---|
| DeepSeek Harness packages | `0.1.1-rc.2` |
| Upstream source | tag `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Cordis | `4.0.1` |
| Cordis Loader | `1.0.2` |
| Cordis Include | `1.0.6` |
| Schemastery | `3.18.1` |
| Official Codex package | `0.147.0` |
| Runtime toolchain | Node 24, pnpm `11.7.0` |

`corepack pnpm@11.7.0 run compat:check` passed on the report date. The command
builds production artifacts, runs the integrity-pinned Host, Client, Preset,
Session, and Codex tests, validates built adapter declarations and runtime
versions, and starts the effective Profile on a temporary loopback port. Tests
use synthetic data and no external model or company account.

## Supported Extension Points

| Extension point | Evidence | Stage 1 disposition |
|---|---|---|
| Profile Bundles and patches | Ordered base, Web, and Workbench composition; formally installed dependencies; real boot | Use behind exact Profile checks |
| Cordis Host plugin lifecycle | Host activation, dependency injection, effect-owned registration, disposal | Use for Work Hub services and Connectors |
| Tool Registry and Agent Loop | Structured Tool execution, cancellation, model visibility, durable Session trace | Use through `@twindesk/harness-adapter` |
| Settings registry and file provider | Strict owner validation, persistence, restart, redacted browser projection | Use for non-secret configuration; secrets remain references |
| Client package discovery and slots | External package loads, settings card renders, slot registration and disposal work | Use additive supported slots only; do not use the Inbox shadow as product routing |
| Agent Presets, Persona, Skill, and scoped Tools | Two distinct compositions produce distinct prompts, capabilities, and draft-only behavior | Use after product-owned Persona persistence and reconciliation are designed |
| JSONL Session persistence | Zstandard storage, durable Tool events, two cold resumes, torn-tail repair, no duplicate events | Use for Harness Session data; keep business SQLite separate |
| Codex Subagent provider and Tool | Real package-local app server, repository read, denied write, cancellation, paired lifecycle attribution | Keep as Stage 0 evidence; production budgets remain TD-404 |

All Harness-specific imports and types remain inside
`@twindesk/harness-adapter`. `@twindesk/domain` has no dependency on Harness,
Cordis, Client frameworks, Connectors, or model SDKs.

## Gaps and Required Changes

| Gap | Severity | Required action |
|---|---|---|
| No public Harness primary navigation, keyed page registry, or route service | Diagnostic Client limitation | Keep the Harness Client spike diagnostic-only; use the TwinDesk-owned shell for product routes |
| No published external Harness Client build preset | Diagnostic implementation gap | Preserve the narrow Stage 0 builder only for selected compatibility diagnostics |
| External Bundle cannot append a system Preset root | Material implementation gap | Replace the Stage 0 user-root copy workaround with product-owned Persona/Preset storage, versioning, conflict handling, and safe reconciliation |
| Codex provider lacks Harness `depthLimit` and `toolFilter` capabilities | Stage 4 blocker, not Stage 1 | Add native child-runtime limits for depth, tools, concurrency, duration, tokens, and calls before TD-404 production use |
| JSONL product retention and export policy is unresolved | Stage 1 implementation requirement | Define retention, redacted export, deletion, backup, encryption-at-rest expectations, and format migration without moving business tables into Session storage |
| Harness remains developer preview | Cross-cutting upgrade risk | Preserve exact pins, adapter isolation, fail-loud capability checks, and the compatibility suite for every upgrade |

No TwinDesk-specific Harness core patch or fork is approved. The optional
generic upstream proposal remains independently useful to Client plugins, but
TwinDesk product delivery does not depend on it.

## Implementation Surface Estimate

The estimates below describe code and contract surfaces only. They are not
delivery dates.

### Optional upstream surface

- the product-neutral
  [upstream navigation and keyed-page proposal](HARNESS_UPSTREAM_NAVIGATION_PROPOSAL.md),
  prepared as a GitHub Discussion draft for upstream review;
- one root-scoped route and keyed-page registry with collision and disposal
  semantics;
- one additive primary-navigation contribution point;
- browser history, direct-link, back/forward, reload, and unknown-route
  behavior;
- public Client declarations, package exports, documentation, and upstream
  lifecycle tests;
- optional migration of the Harness diagnostic plugin if such a contract is
  released; this does not change the standalone product shell.

### Stage 1 TwinDesk surface

- product-owned Persona and Preset persistence, validation, versioning, and
  reconciliation with the Harness user-facing composition boundary;
- a product-owned local API connecting `@twindesk/web` to Work Hub behavior;
- Work Hub business SQLite migrations, Inbox API and projection, Audit
  Timeline, retention, redaction, export, and deletion;
- repository coverage for the local API contract, Web projections, and
  persisted product behavior.

### Deferred surfaces

- connector idempotency and external-write approvals belong to Stages 2 and 3;
- native Codex budgets and wider specialist delegation belong to Stage 4;
- experimental Agent Teams remain outside the MVP critical path.

## Upgrade Risks

| Risk | Detection or mitigation |
|---|---|
| Public package or service rename | Runtime manifest checks, TypeScript compilation, built-export validation |
| Profile patch or plugin discovery change | Effective config assertions and real Profile startup |
| Client slot priority or lifecycle change | Exact SlotCore probe and production bundle lifecycle tests |
| Lazy-CJS loader or shared React contract change | Production artifact execution, source-map checks, live artifact fetch |
| Preset root or scoped registry change | Two-Preset composition, visibility, identity, and disposal tests |
| Session encoding or replay change | Compressed and raw recovery probes with contiguous event projections |
| Codex permission or protocol change | Real app-server fixture, denied-write assertion, cancellation, capability rejection, lifecycle pairing |
| New transitive version drift | Exact manifests, frozen lockfile, pinned package manager, isolated upgrade commits |

The suite detects selected contract changes; it cannot prove future upstream
behavior that is absent from the pinned release. Every upgrade must inspect the
matching exact source revision and extend tests before adopting a new seam.

## Security and Data Review

- The default autonomy mode remains `draft_only`; Persona composition grants no
  authority.
- No external-write Tool exists in Stage 0.
- The Codex child uses an isolated native read-only sandbox and receives no
  parent Harness context or Tools.
- Synthetic fixtures contain no real company data or credentials.
- Secrets remain outside ordinary settings, Sessions, source, fixtures, and
  diagnostics.
- Harness Session data and future TwinDesk business data retain separate
  persistence boundaries.
- Hidden chain-of-thought and raw child protocol traffic are not persisted by
  TwinDesk compatibility probes.

These findings support the technical viability of the selected runtime seams
and the standalone product shell. They do not substitute for later Connector,
approval, retention, migration, and recovery tests.

## Gate Completion Record

The Stage 1 recommendation changed to GO when all of the following became true:

1. ADR 0002 approved the standalone TwinDesk-owned Web shell;
2. the product route lifecycle no longer uses the Harness Client's private
   hash, footer-only entry, or priority-based conversation replacement;
3. Web shell tests cover direct routes, unknown routes, security headers,
   disposal, restart, and loopback-only binding;
4. the full repository and compatibility checks pass with no Harness core fork
   and no TwinDesk domain logic in upstream packages;
5. TD-052 re-runs the Stage 0 exit gate and records the evidence.
