# Harness Compatibility Suite

## Purpose

`pnpm compat:check` is the single Stage 0 command that validates every Harness
extension seam currently selected by TwinDesk. It is narrower than the general
repository check: it concentrates on compatibility with the exact pinned
Harness release and produces a named failure boundary for upgrade triage.

The suite validates Harness `0.1.1-rc.2`, Cordis `4.0.1`, Loader `1.0.2`,
Include `1.0.6`, Schemastery `3.18.1`, and the package-local official Codex
`0.147.0`. The exact package manifests and public TypeScript contracts are
checked by `@twindesk/harness-adapter`; no Harness type crosses into TwinDesk
domain packages or the adapter's built declarations.

## Run It

From the repository root with the pinned package manager:

```sh
corepack pnpm@11.7.0 run compat:check
```

The command builds required artifacts before testing, so it works from a clean
checkout after dependency installation. It uses no real company content,
connector account, external model, or production credential. The Codex fixture
and Profile smoke test bind temporary loopback ports, so a sandbox must allow
local listening sockets.

## Coverage

The suite owns an explicit ordered test manifest. Adding or removing a selected
compatibility boundary requires changing both the manifest and its integrity
test.

| Boundary | Evidence |
|---|---|
| Pinned public Host interfaces | Runtime package-version checks, Cordis lifecycle, Tool and scoped registries |
| Host plugin activation and Tool registration | Structured direct execution, cancellation, Agent Session Tool trace, disposal |
| Settings | File persistence, restart, strict validation, redaction, disposal |
| Client plugin loading | Production lazy-CJS artifact, source map, settings card, Inbox route and slot lifecycle |
| Profile composition | Ordered Bundles, formally installed Host and Client plugins, fail-closed Preset and Codex configuration |
| Persona selection | Distinct technical and communication Presets, prompts, Skills, scoped Tools, disposal |
| Session resume | Default compressed JSONL and torn-tail recovery across two cold restarts without duplicate events |
| Codex delegation | Real package-local app server, synthetic repository read, denied write, cancellation, capability rejection, result attribution |
| Built adapter boundary | Expected exports, exact versions, and no upstream types in declarations |
| Real Profile boot | Effective config, one TwinDesk Codex provider, loopback Web startup, stable Client boot graph and artifacts, normal shutdown |

This is the Stage 0 compatibility set, not the complete product security test
plan. Connector idempotency, external-write approvals, business SQLite
migrations, retention, and production Subagent budgets enter in later roadmap
stages and must extend the suite when their Harness seams are selected.

## Failure Contract

The command emits four named stages:

1. `build` — workspace and production Client artifacts;
2. `contracts` — Host, Client, Preset, Session, and Codex tests;
3. `adapter-output` — built adapter exports, declarations, and runtime versions;
4. `profile` — effective Profile composition and real loopback startup.

A failed child command stops the suite and reports the stage id, capability,
exit status or signal, and exact reproduction command. Package-version checks,
capability rejections, strict fixture assertions, and Profile composition checks
must fail loudly; the suite never treats missing behavior as an empty successful
result.

## Scope Boundary

Passing this suite proves compatibility with the selected developer-preview
interfaces. It does not by itself approve Stage 1. The
[`Stage 0 Compatibility Report`](STAGE_0_COMPATIBILITY_REPORT.md) interprets
the evidence. ADR 0002 resolved the product-shell dependency with a standalone
TwinDesk Web application; Harness Client coverage remains diagnostic.
