# ADR 0002: TwinDesk-Owned Product Web Shell

- Status: Accepted
- Date: 2026-08-26
- Decision owner: TwinDesk maintainers
- Trackers: TD-032, TD-052
- Supersedes: [ADR 0001](0001-upstream-generic-inbox-extension-points.md) for the product UI path

## Context

The Stage 0 Client spike proved that an out-of-tree Harness plugin can render a
diagnostic page, but Harness `0.1.1-rc.2` has no public contract for primary
product navigation, keyed top-level pages, or browser route ownership. TwinDesk
cannot control whether or when those upstream capabilities are released.

The product requirements do not require Harness to own the application shell.
TwinDesk needs stable product-owned routes for Inbox, Personas, Connectors,
Audit, and Settings. Harness is valuable for the Agent Loop, Sessions, Tools,
Skills, Presets, and specialist execution, all of which can remain behind the
existing adapter and Host integration.

## Decision

TwinDesk will own a standalone, local Web application and its route lifecycle.
The initial `@twindesk/web` package provides five deterministic product routes:

- `/inbox`
- `/personas`
- `/connectors`
- `/audit`
- `/settings`

The server binds only to an explicit loopback address. The Stage 0 shell uses
truthful empty and diagnostic states; it does not invent Connector events,
drafts, approvals, audit records, credentials, or external-write capability.

Harness remains an exactly pinned, replaceable Agent Runtime behind
`@twindesk/harness-adapter`. Its Web application and the existing
`@twindesk/plugin-ui` spike remain compatibility and runtime diagnostics, not
the TwinDesk product shell. TwinDesk will connect its Web application to a
product-owned Work Hub API as Stage 1 domain and persistence behavior is built.

No Harness fork or core patch is required. A future public Harness page API may
still be useful to the ecosystem, but TwinDesk delivery does not depend on it.

## Boundaries

- `@twindesk/web` owns presentation, browser routes, and product navigation.
- `@twindesk/plugin-work-hub` will own product orchestration and its local API.
- `@twindesk/domain` owns framework-independent business states and rules.
- `@twindesk/storage-sqlite` owns business persistence and migrations.
- `@twindesk/harness-adapter` is the only package that imports Harness runtime
  contracts directly.
- Harness Session data and TwinDesk business data remain separate.
- Page visibility never grants a Tool, credential, scope, or write authority.

## Consequences

### Positive

- Product navigation and browser lifecycle are fully controlled in this
  repository and can evolve with user needs.
- Harness remains replaceable and can be upgraded or removed without rewriting
  the product routes.
- Stage 1 no longer depends on an upstream UI release or a local fork.
- The Harness diagnostic UI remains available for compatibility investigation.

### Negative

- TwinDesk owns Web shell accessibility, security headers, asset delivery, and
  future frontend build complexity.
- Stage 1 must define a narrow local Work Hub API instead of reading Harness or
  SQLite internals from the browser.
- Product and diagnostic UIs are separate entry points and must be labelled
  clearly.

## Verification and Upgrade Policy

- Route resolution, direct loads, unknown routes, security headers, shutdown,
  and same-port restart are covered by repository tests.
- The server must reject non-loopback binding.
- Every Harness upgrade still runs the Harness compatibility suite because the
  runtime boundary remains selected infrastructure.
- Reintegrating the product shell into Harness would require another ADR and
  must not introduce TwinDesk domain behavior into Harness core.
