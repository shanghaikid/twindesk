# Stage 0 Exit Gate

- Audit date: 2026-08-26
- Tracker: TD-052
- Harness package: `@deepseek-ai/dsh@0.1.1-rc.2`
- Product UI decision: [ADR 0002](decisions/0002-twindesk-owned-product-web-shell.md)

## Decision

**PASSED. Stage 1 may begin.**

All four TD-052 criteria pass. TwinDesk now owns a standalone loopback Web
shell and its route lifecycle, while the exactly pinned Harness remains a
replaceable Agent Runtime behind `@twindesk/harness-adapter`. Harness Web UI is
a diagnostic entry point rather than a product dependency.

The decision does not claim that Harness `0.1.1-rc.2` gained a public page or
primary-navigation API. That limitation remains true. ADR 0002 removes it from
the selected product architecture without adding a fork, core patch, or
TwinDesk business behavior to Harness.

## Criteria

| TD-052 criterion | Result | Evidence |
|---|---|---|
| Product experience is viable without a fork, or with only a minimal generic UI extension point | **Pass** | `@twindesk/web` owns deterministic `/inbox`, `/personas`, `/connectors`, `/audit`, and `/settings` routes, direct route loads, unknown-route behavior, asset delivery, restrictive security headers, explicit shutdown, and same-port restart. The server rejects non-loopback binding. |
| No TwinDesk domain logic is placed in Harness core | **Pass** | The product shell, packages, Profile artifacts, and plugins remain in this repository. No Harness fork or core patch is present or approved, and `@twindesk/domain` remains independent of Harness and Cordis. |
| Compatibility tests cover every selected unstable boundary | **Pass** | `pnpm compat:check` integrity-pins and exercises the selected Profile, Host, diagnostic Client, Preset, Session, and Codex boundaries. Product routing is TwinDesk-owned and covered by the repository Web shell tests rather than represented as a Harness contract. |
| All Stage 0 security and restart checks pass | **Pass** | Stage 0 tests cover settings redaction, read-only Tool and Codex authority, denied writes, cancellation, synthetic fixtures, Persona-aware Session recovery, torn-tail repair, duplicate-free cold restart, and the Web shell's loopback-only lifecycle. These do not replace later Connector, external-write, retention, migration, or product database checks. |

## Selected Product Boundary

```text
TwinDesk Web shell
  -> future local Work Hub API
     -> TwinDesk domain and business SQLite
     -> Connector plugins
     -> Harness adapter -> pinned Harness Agent Runtime

Harness Web UI -> runtime and Client compatibility diagnostics only
```

The Stage 0 static Harness Inbox, footer action, hash listener, and
`conversation` slot shadow remain test fixtures for the exact Client seam that
was evaluated. Stage 1 product behavior must not depend on them.

## Remaining Limitations

- The current Web shell is a truthful product skeleton. It has no Work Hub API,
  persisted Work Items, drafts, approvals, audit records, or real Connectors.
- Stage 1 must add versioned business types, forward migrations, idempotent
  fixture ingestion, cursor recovery, projections, redaction, retention,
  export, deletion, and restart tests before its own gate can pass.
- Stage 2 remains responsible for real Feishu identity, ingestion, exact
  previews, one-time approvals, idempotent sending, and uncertain-result
  handling.
- The upstream navigation proposal is retained as an optional ecosystem
  reference. Its acceptance or release is no longer required for TwinDesk.

## Historical Note

The first TD-052 audit was **NOT PASSED** because ADR 0001 selected a public
Harness navigation and page contract that did not exist. ADR 0002 explicitly
supersedes that product path and records the maintenance and security
consequences of a TwinDesk-owned shell. The gate changed only after the new
route, server lifecycle, and repository boundaries were implemented and
verified.
