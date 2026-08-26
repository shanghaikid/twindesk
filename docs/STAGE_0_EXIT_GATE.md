# Stage 0 Exit Gate

- Audit date: 2026-08-26
- Tracker: TD-052
- Evidence baseline: `3e65e1a217a0e327aadeee2104844d586256265b`
- Harness package: `@deepseek-ai/dsh@0.1.1-rc.2`

## Decision

**NOT PASSED. Stage 1 remains gated.**

Three of the four TD-052 criteria pass. The product-experience criterion fails
because the exactly pinned Harness release does not provide the generic Client
navigation, keyed-page, and route lifecycle selected by ADR 0001. The Stage 0
hash route, sidebar-footer entry, and `conversation` slot shadow remain useful
compatibility diagnostics, but they are not an accepted product architecture.

This audit does not authorize Stage 1 implementation, a local Harness fork, or
a TwinDesk-specific Harness core patch.

## Criteria

| TD-052 criterion | Result | Evidence |
|---|---|---|
| Product experience is viable without a fork, or with only a minimal generic UI extension point | **Fail** | Harness `0.1.1-rc.2` has no released public primary-navigation registry, keyed top-level page registry, or route lifecycle. ADR 0001 rejects the diagnostic private hash and priority-shadow path for the Stage 1 Inbox. |
| No TwinDesk domain logic is placed in Harness core | **Pass** | TwinDesk packages and Profile artifacts remain out of tree, `@twindesk/domain` remains independent of Harness and Cordis, and no Harness fork or core patch is present or approved. |
| Compatibility tests cover every selected unstable boundary | **Pass** | `pnpm compat:check` integrity-pins and exercises the selected Profile, Host, Client, Preset, Session, and Codex boundaries, then validates the built adapter and starts the effective Profile. The absent future navigation contract cannot be claimed as covered until it is released and adopted. |
| All Stage 0 security and restart checks pass | **Pass** | Stage 0 tests cover settings redaction, read-only Tool and Codex authority, denied writes, cancellation, synthetic fixtures, Persona-aware Session recovery, torn-tail repair, and duplicate-free cold restart. This result is limited to Stage 0 scope and does not replace later Connector, external-write, retention, migration, or product database checks. |

## Blocking Condition

The accepted product path needs a released, product-neutral Client contract
with all of the following properties:

- additive primary-navigation entries with stable keys and disposal semantics;
- keyed top-level page registration with clear key and path collision errors;
- direct links, browser back and forward navigation, reload, unknown-route
  behavior, and clean teardown;
- an active-page render seat that does not replace a feature-owned slot.

That contract is absent from the pinned Harness release. Adding a private
TwinDesk route contract or silently patching Harness would conflict with ADR
0001 and would not pass this gate.

## Re-evaluation Requirements

Re-run TD-052 only after one of these product paths is explicit:

1. Harness publishes the generic contract selected by ADR 0001 and TwinDesk
   pins the exact release; or
2. a superseding ADR accepts a different path and records its product,
   maintenance, security, release, and migration consequences.

Before changing this decision to passed, TwinDesk must also:

- migrate the external Client plugin away from private hash ownership,
  footer-only primary entry, and `conversation` priority shadowing;
- cover page and navigation registration, direct links, browser history,
  collisions, disposal, reload, and workaround migration in the compatibility
  suite;
- confirm the adopted path contains no TwinDesk domain logic in Harness core;
- re-run the full repository and compatibility checks on the new exact pin.

Until then, TD-052 stays open and no Stage 1 backlog item may start.
