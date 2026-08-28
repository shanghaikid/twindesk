# Feishu Connector Diagnostics

## Scope

TD-208 implements a versioned, presentation-safe diagnostics boundary for the
configured Feishu Connector. `FeishuConnectorDiagnosticsService` composes four
views without granting authority or performing a write:

- overall Connector health;
- per-identity authorization and scope coverage;
- per-identity rate-limit state;
- product-owned durable cursor freshness.

The service implements `health(signal)` with the product-owned
`ConnectorHealth` shape and exposes the richer `diagnose(signal)` response for
future Connector settings and support surfaces. It is independent of Persona,
Skill, model, approval, and execution logic.

The repository still has no production Feishu HTTP diagnostics adapter. The
isolated system-Keychain reader and credential parser do not acquire or refresh
tokens or probe current scopes. The injected client contract is the runtime composition point for
resolving a SecretReference, checking authorization/scopes, normalizing rate
headers, and reading SQLite cursor snapshots.

## Identity and Scope Diagnostics

Bot and User identities are probed separately with their exact configured
account, app, principal, identity type, and non-secret credential reference.
The response must echo that identity exactly and report:

- `authorized` or `not_authorized`;
- the operation-specific required scopes;
- currently granted scopes;
- normalized rate-limit state.

The service computes missing scopes rather than trusting a client summary.
Scope lists must be dense, unique, bounded plain strings and are sorted for
deterministic presentation. Exact required scope names belong to the concrete
adapter and its enabled Feishu operations; the diagnostics layer does not
silently invent grants or infer scopes from a Persona.

One unavailable identity degrades a Connector when another configured identity
is usable. If no configured identity is currently authorized and observable,
overall status is `unavailable`. Missing scope, active rate limiting, cursor
failure, or cursor staleness makes an otherwise available Connector `degraded`.

## Rate-Limit Diagnostics

Each configured identity reports one of:

- `available`: positive remaining capacity, the observed limit, and reset time;
- `limited`: the reset time before a safe retry;
- `unknown`: no trustworthy observation.

An adapter response claiming `available` with zero remaining capacity is
normalized to `limited`. A reset time implausibly older than the local clock is
rejected. The service never copies response headers, request identifiers,
tokens, or server payloads into diagnostics.

Rate state is an observation, not an authorization. It cannot bypass approval,
change retry disposition, or allow an expired action. TD-207 continues to fail
closed on execution-time rate and scope errors even when an earlier diagnostic
was healthy.

## Cursor Diagnostics

The default expected stream is `user_visible_messages`, the durable User search
cursor introduced by TD-202 and committed atomically by TD-204. Runtime
composition may declare additional product-owned streams explicitly.

For each expected stream the service reports:

- `current`: updated within the configured freshness threshold;
- `stale`: present but not updated recently;
- `future`: newer than the local clock beyond a bounded five-minute skew;
- `not_started`: no durable cursor exists yet;
- `unavailable`: the cursor snapshot could not be trusted.

The default stale threshold is 15 minutes and can be configured within a
bounded policy range. Diagnostics expose only the stream, status, `updatedAt`,
and optional `committedThrough`. They never expose the opaque cursor position,
page token, external payload, or database path. `not_started` is informative and
does not by itself degrade an otherwise healthy new connection.

Bot callback ingestion uses its separate hash-only delivery receipt journal and
does not pretend to have a polling cursor.

## Privacy and Failure Handling

The output may include local account ID, identity type and display name, scope
names, normalized rate counts/times, stream names, and cursor timestamps. It
does not include principal IDs, SecretReference IDs, credential values, tokens,
cookies, cursor positions, Feishu request/response bodies, message content, or
raw errors.

Identity and cursor responses must be exact accessor-free plain data. Sparse,
duplicate, oversized, identity-mismatched, future, or malformed values fail
into bounded Connector issues without echoing rejected data. Cancellation is
checked before probes and after every awaited client call.

## Remaining Work

- Production token and Feishu HTTP transports, atomic Keychain rotation, and
  SQLite diagnostics adapters are not wired.
- A Connector settings UI has not yet been connected to `diagnose()`.
- TD-209 now composes healthy diagnostics with the local synthetic
  ingestion-to-receipt acceptance path. Production probe composition and the
  live-account write gate remain open; see
  [Stage 2 Exit Gate](STAGE_2_EXIT_GATE.md).

## Verification

Synthetic tests cover healthy Bot/User scope and rate state, redacted current
cursors, missing scopes, authorization loss, zero-capacity normalization,
active rate limits, stale/future/unavailable cursors, partial and complete probe
failure, hostile accessors and arrays, identity mismatch, deterministic issues,
and cancellation before client access. No real credential or service is used.
