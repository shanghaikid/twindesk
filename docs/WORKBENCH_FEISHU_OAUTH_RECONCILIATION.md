# Workbench Feishu OAuth Reconciliation

## Purpose

TwinDesk exposes one explicit local action for an OAuth rotation or
reauthorization outcome that cannot be proven from the journal alone. The
action compares the exact configured macOS Keychain bundle with the unresolved
journal event. It does not start OAuth, contact Feishu, refresh a token, replace
a Keychain item, or grant external-write authority.

## Ordering and authority

The production ordering is:

```text
user clicks Check local credential
  -> same-origin Host, Origin, Fetch-Metadata, CSRF, media, and body checks
  -> require minimized recovery state reconciliation_required
  -> load the exact configured User identity
  -> acquire the exclusive Feishu Host lease
  -> atomically persist one pending maintenance operation and request Audit
  -> require reserved, uncertain, or reauthorization_reserved journal evidence
  -> resolve and identity-validate the exact connector_oauth Keychain bundle
  -> compare only its obtainedAt with the journal source timestamp
  -> require a strictly newer bundle with unexpired refresh authorization
  -> append completed or reauthorized
  -> atomically settle the maintenance operation and append its result Audit
  -> reread the minimized durable recovery projection
```

The Connector reconciler has no refresh transport and no Keychain replacer.
That structural boundary prevents the operation from silently becoming a
network retry or credential write. A same or older bundle returns
`still_required` and leaves the journal unchanged. A newer bundle whose refresh
authorization has since expired also remains blocked: historical write evidence
must not be presented as a currently recoverable credential. An identity mismatch,
missing or malformed credential, active operation, changed journal, lost lease,
or failed journal append fails closed.

The credential parser has a reconciliation-only evidence callback that still
validates the complete versioned bundle, configured app and User principal,
timestamp structure, scopes, and secret bounds, but returns only `obtainedAt`
plus a non-secret usable-or-expired refresh status.
All Keychain and parsed token buffers are cleared on every exit.

On startup, Workbench checks for one pending maintenance operation before the
Web server accepts requests. Under the same Host lease it repairs that operation
from SQLite plus the secret-free rotation journal only: terminal journal
evidence recorded at or after the request becomes `reconciled`, while
crash-visible unresolved evidence becomes `still_required`. Older terminal
evidence cannot be attributed to a newer request. Repair never reads Keychain
or repeats reconciliation. Missing, incompatible, or still-active evidence
fails closed. A known in-process failure or cancellation is settled as `failed`
or `cancelled`; durable terminal success remains authoritative if cancellation
arrives during post-effect cleanup. A process interruption leaves the pending
row for the next startup.

Workbench supplies the same caller-owned `TwinDeskDatabase` handle to the
reconciliation service and Web Inbox/Audit projection. This keeps the Audit
visible even when the caller intentionally selects an in-memory database. Web
closes only its projection; the Workbench server wrapper closes the shared
database after HTTP shutdown.

## Product API

`GET /api/recovery/feishu/oauth` continues to return the identifier-free
version 1 recovery projection. When reconciliation is composed, it also returns
a process-local 256-bit capability in the
`x-twindesk-oauth-reconciliation` response header.

`POST /api/recovery/feishu/oauth/reconcile` accepts only the exact JSON body
`{"version":1}` and requires the bound Host and Origin, same-origin Fetch
Metadata, exact JSON media type and length, and that capability header. Web
rechecks `reconciliation_required` before invoking Workbench and independently
validates both the minimized action result and the resulting recovery state.
Shutdown aborts active local credential checks.

The response contains only:

- `reconciled`: a strictly newer usable exact local bundle settled the journal; or
- `still_required`: no newer usable exact local bundle was found.

It contains no account, app, principal, SecretReference, timestamp, scope,
token, Keychain path, journal path, or error payload.

## Verification and limitations

Synthetic tests cover normal rotation, uncertain rotation, interrupted
reauthorization, expired-but-newer blocking, same/older evidence, request and
result Audit ordering, restart repair without Keychain access, identity mismatch,
historical terminal rejection, late cancellation after durable success, secret
cleanup, settled-state rejection, lease ownership, missing Settings, hostile
options, request forgery, replay gating, minimized contracts, shared in-memory
and file-backed database lifecycle, default Web composition, and shutdown
cancellation. They use no live account, network request, or real Keychain item.

Credential repair/removal, revocation, hosted polling, and live-account
acceptance remain open.
