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

The Workbench production composition now resolves configured SecretReferences
beneath the shared Feishu Host lease, reuses the concrete Bot and User
operation-scope probes, and reads the product-owned SQLite User-message cursor.
The Bot probe acquires a bounded tenant token and verifies the current Bot
principal and tenant scopes against fixed Feishu endpoints. The User probe
validates the current local OAuth credential bundle and its combined discovery
and reply scopes; it does not make a remote User request or claim that Feishu
still accepts the token. Rate state remains `unknown` because the current scope
probes do not return trustworthy normalized rate metadata.

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

TD-209 now provides fixed code-owned policies for Bot reply, User reply, and
User message discovery. A production diagnostics adapter may reuse those exact
lists, but a healthy diagnostic is not operation authorization; the operation
must obtain its own fresh evidence through
[Feishu Operation Scope Authorization](FEISHU_OPERATION_SCOPE_AUTHORIZATION.md).

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

## Workbench and Browser Composition

`createWorkbenchFeishuConnectorDiagnostics()` rereads durable identity state on
every request, acquires the same exact-configuration lease used by polling and
writes, and projects the TD-208 result before it reaches Web. The projection
removes account IDs, app IDs, display names, principal IDs, SecretReferences,
granted-scope lists, rate counts, raw errors, and cursor positions. It exposes
only identity type and readiness, required and missing operation scopes,
normalized rate state, cursor freshness timestamps, fixed issue codes, and
fixed recovery categories.

The Cordis polling supervisor supplies an identifier-free in-memory state:
disabled, starting, running, stopped, or attention required. Terminal
authorization, scope, cursor/configuration, and unknown failures map to fixed
recovery categories without serializing the caught error. Diagnostics cannot
restart polling, rotate a credential, retry a write, or grant authority.

The loopback-only `GET`/`HEAD /api/diagnostics/feishu` endpoint independently
parses the minimized shape and uses `no-store`. The Connectors page runs the
check only when opened or explicitly refreshed. Issue text is local UI copy
derived from a fixed code; Host error strings cannot cross the browser boundary.
Request disconnect and Web shutdown cancel active probes.

## Remaining Work

- User diagnostics prove only the current local credential bundle and
  configured scopes; live polling acceptance is required to prove remote User
  authorization and connectivity.
- The fixed operation clients do not preserve a reusable normalized rate
  observation, so production diagnostics report rate state as `unknown`.
- TD-209 still requires live-account diagnostics and write acceptance; see
  [Stage 2 Exit Gate](STAGE_2_EXIT_GATE.md).

## Verification

Synthetic tests cover healthy Bot/User scope and rate state, redacted current
cursors, missing scopes, authorization loss, zero-capacity normalization,
active rate limits, stale/future/unavailable cursors, partial and complete probe
failure, hostile accessors and arrays, identity mismatch, deterministic issues,
and cancellation before client access. Workbench tests additionally cover
shared-lease composition, concrete User probe routing, identifier removal,
runtime stop recovery, strict browser parsing, loopback methods, invalid output,
and shutdown cancellation. No real credential or service is used.
