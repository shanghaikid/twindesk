# Stage 0 Harness Compatibility Report

- Report date: 2026-08-26
- TwinDesk evidence baseline: `3f2f5beb4266531ac40a02071a4cc414fdc6626a`
- Harness package: `@deepseek-ai/dsh@0.1.1-rc.2`
- Harness tag: `dsh-v0.1.1-rc.2`
- Harness commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Official package-local Codex: `@openai/codex@0.147.0`

## Recommendation

**NO-GO for the Stage 1 gate on the validated Harness revision.**

The formal [TD-052 exit-gate audit](STAGE_0_EXIT_GATE.md) records this as
**NOT PASSED**: three criteria pass and the product-experience criterion fails.

The runtime and Host extension model are viable without a fork. TwinDesk can
formally install out-of-tree Host and Client plugins, register read-only Tools
and Settings, compose distinct Agent Presets, recover Sessions, and run a
traceable read-only Codex specialist. No TwinDesk domain logic or local Harness
core patch is required for those capabilities.

The blocking condition is the product Inbox shell. Harness `0.1.1-rc.2` exposes
no public primary-navigation registration, keyed top-level page registry, or
route lifecycle. The Stage 0 plugin can display a diagnostic Inbox only by
owning a browser hash, placing its entry in the sidebar footer, and shadowing
the `conversation` slot. ADR 0001 explicitly rejects that technique as the
Stage 1 product architecture. Proceeding would either violate the accepted ADR
or silently create a private routing contract.

This recommendation does not authorize starting the Stage 1 backlog. Re-run the
gate only after a released, exactly pinned Harness version provides the generic
navigation and page contract selected by ADR 0001, or after a superseding ADR
explicitly accepts another product path and its maintenance cost.

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
| No public primary navigation, keyed page registry, or route service | **Stage 1 blocker** | Add the product-neutral upstream contract defined by ADR 0001, release it, pin it, and cover registration, deep links, history, collisions, disposal, and reload |
| No published external Client build preset | Material implementation gap | Either publish a supported upstream preset or deliberately expand TwinDesk's narrow builder for multiple modules, styles, assets, shared dependencies, and diagnostics |
| External Bundle cannot append a system Preset root | Material implementation gap | Replace the Stage 0 user-root copy workaround with product-owned Persona/Preset storage, versioning, conflict handling, and safe reconciliation |
| Codex provider lacks Harness `depthLimit` and `toolFilter` capabilities | Stage 4 blocker, not Stage 1 | Add native child-runtime limits for depth, tools, concurrency, duration, tokens, and calls before TD-404 production use |
| JSONL product retention and export policy is unresolved | Stage 1 implementation requirement | Define retention, redacted export, deletion, backup, encryption-at-rest expectations, and format migration without moving business tables into Session storage |
| Harness remains developer preview | Cross-cutting upgrade risk | Preserve exact pins, adapter isolation, fail-loud capability checks, and the compatibility suite for every upgrade |

No TwinDesk-specific Harness core patch or fork is approved. The only required
upstream change for the product shell must be generic and independently useful
to other Client plugins. A local patch would require a superseding ADR that
records merge, release, security-review, support, and migration ownership.

## Implementation Surface Estimate

The estimates below describe code and contract surfaces only. They are not
delivery dates.

### Blocking upstream surface

- one root-scoped route and keyed-page registry with collision and disposal
  semantics;
- one additive primary-navigation contribution point;
- browser history, direct-link, back/forward, reload, and unknown-route
  behavior;
- public Client declarations, package exports, documentation, and upstream
  lifecycle tests;
- TwinDesk Client migration from hash ownership and `conversation` shadowing to
  the released contract, followed by removal of the diagnostic workaround.

### Stage 1 TwinDesk surface after the gate

- product-owned Persona and Preset persistence, validation, versioning, and
  reconciliation with the Harness user-facing composition boundary;
- a multi-module Client build path or adoption of an upstream external build
  preset;
- Work Hub business SQLite migrations, Inbox API and projection, Audit
  Timeline, retention, redaction, export, and deletion;
- compatibility additions for the released navigation/page APIs and persisted
  product behavior.

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

These findings support the technical viability of the selected runtime seams,
but they do not remove the product-shell blocker or substitute for later
Connector, approval, retention, migration, and recovery tests.

## Gate Re-evaluation Checklist

The Stage 1 recommendation can change to GO only when all of the following are
true:

1. a released, exactly pinned Harness version exposes the accepted generic
   navigation and keyed-page contract, or a superseding ADR approves an
   alternative;
2. the external TwinDesk Client uses that product path without a private route,
   footer-only primary entry, or priority-based conversation replacement;
3. the compatibility suite covers direct links, browser history, collisions,
   disposal, reload, and migration away from the Stage 0 workaround;
4. the full repository and compatibility checks pass with no Harness core fork
   and no TwinDesk domain logic in upstream packages;
5. TD-052 re-runs the Stage 0 exit gate and records the evidence.
