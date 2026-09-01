# Workbench Feishu OAuth Authorization UI

## Scope

The product Connectors page can now start one explicit initial Feishu User
OAuth authorization after the minimized Settings projection is `ready`. The
Workbench composition reuses the existing lease-held authorization Host, so the
same operation owns literal-loopback callback capture, PKCE exchange, exact
`open_id` verification, and initial system Keychain persistence.

This is an initial-credential path. It never overwrites an existing credential.
An existing item routes to the separate reauthorization requirement, while an
uncertain Keychain write routes to reconciliation instead of blind retry.

## Local Web contract

The loopback-only Web server exposes three exact endpoints:

- `GET /api/authorization/feishu` returns the current memory-only state and the
  process-local CSRF capability;
- `POST /api/authorization/feishu/start` accepts 1–512 bytes with exact
  `application/octet-stream`; and
- `POST /api/authorization/feishu/cancel` accepts only `{"version":1}` as exact
  JSON.

Both mutations require the bound Host, exact same Origin,
`Sec-Fetch-Site: same-origin`, the 256-bit process-local CSRF header, a declared
non-streaming length, the exact media type, and no query. Competing starts fail
closed. Server shutdown cancels the active attempt before releasing Workbench
resources.

The state response is versioned and minimized to `idle`, `starting`, `waiting`,
`succeeded`, `cancelled`, or `failed` with a fixed recovery category. Only the
`waiting` state includes the exact Feishu authorization URL and literal-loopback
redirect URI. Both Workbench and Web independently reject extra fields,
accessors, non-Feishu destinations, malformed PKCE parameters, and non-literal
loopback redirects before a browser link is rendered.

## User interaction and meaning

The browser does not open Feishu automatically. It renders a visible link with
an explicit user click, a new browsing context, and `noopener noreferrer` only
after the callback listener and authorization transaction are ready. The page
polls only the local status endpoint while an attempt is starting or waiting and
offers explicit cancellation.

`succeeded` means this attempt verified the configured User principal and the
initial credential replacement reported success. It does not prove current
connectivity, current scopes, or later token validity. The controller state is
not persisted: after process restart the page returns to `idle`, which means no
attempt is active in this process and is not a Keychain health check.

## Secret lifetime and recovery

The app secret passes as a transient loopback request body. The page clears the
password input immediately and clears its mutable UTF-8 byte array after Fetch.
The Web server clears its bounded body buffer, the controller clears its copy
after the Host takes ownership, and the existing Host clears its operation copy
at completion. The secret is not placed in Settings, TwinDesk SQLite, Harness
Sessions, Audit, logs, exports, URLs, or model context.

Browser strings and DOM implementation internals are not mutable-memory
guarantees, so the UI does not claim that every browser-internal copy can be
zeroed. The narrow lifetime and explicit clearing apply to the buffers TwinDesk
owns.

A failed POST is treated as potentially uncertain and is never automatically
restarted. Fixed recovery states direct the user to Settings correction,
reauthorization, Keychain reconciliation, a later retry, or diagnostics as
appropriate.

## Verification and remaining work

Synthetic tests cover controller concurrency and cancellation, transient-buffer
cleanup, hostile presentation data, exact browser response parsing, request
forgery and body rejection, invalid Host results, shutdown cancellation, and
default Workbench status without touching a real Keychain item or network
endpoint.

Still open:

- product actions for the now-presented blocked-state reauthorization and
  Keychain/rotation reconciliation states;
- credential health, scope, disconnect, revocation, and deletion flows;
- Cordis activation plus hosted ingestion and polling under the same lease; and
- a live-account authorization and Stage 2 end-to-end acceptance run.
