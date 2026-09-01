# Workbench Feishu OAuth Reauthorization UI

## Scope

TwinDesk exposes one explicit product action for a Feishu User credential whose
durable OAuth rotation journal is exactly `reauthorization_required`. This is a
separate boundary from initial authorization. It does not repair uncertain
Keychain or journal outcomes, retry an approved reply, grant Connector scopes,
or bypass the normal proposal and one-time approval path for external writes.

The default Workbench Web composition supplies the restart-safe identity store,
authorization store, and concrete default rotation journal to
`createDefaultWorkbenchFeishuOAuthReauthorizationController()`. The controller
loads the hosted runtime only after an explicit start and keeps attempt state in
memory. Restart therefore recovers the durable blocked state but not an
in-process callback or browser session. Once replacement work begins, journal
version 3 preserves `reauthorization_reserved`, so restart exposes
reconciliation rather than another authorization attempt.

## Product and local API boundary

`GET` and `HEAD /api/reauthorization/feishu` return only one exact version 1
snapshot:

- `idle`, `starting`, `succeeded`, or `cancelled`;
- `waiting` with the exact Feishu authorization URL and literal-loopback
  redirect URI; or
- `failed` with one minimized recovery category.

The response includes a process-local 256-bit CSRF capability distinct from
the initial-authorization capability. Start and cancel use dedicated endpoints.
Both require the exact bound Host and Origin, `Sec-Fetch-Site: same-origin`, the
capability header, exact media type, declared bounded body, and no query.

Start performs a fresh read of the separately validated durable recovery
projection before accepting the app-secret body or invoking the Host. Only
`reauthorization_required` passes. Missing, active, settled, or reconciliation
state fails closed. The app secret is 1–512 bytes and is transient: the browser,
server, and Workbench controller clear their owned byte buffers on every exit.
It is never returned in status, written to ordinary storage, or placed in a
URL.

The browser independently parses the minimized snapshot and validates that a
waiting URL is the fixed Feishu authorization endpoint with exact PKCE fields
and a literal-loopback redirect. It never opens that URL automatically. The
user must click the link. While the attempt is starting or waiting, the page
polls once per second and offers cancellation.

## Recovery behavior

The UI preserves these distinctions:

- `reauthorize` permits a new explicit attempt while the durable journal still
  proves reauthorization is required;
- `retry_after_owner_exit` waits for the competing Host owner to exit;
- `configure_settings` and `correct_configuration` require Settings repair;
- `reconcile_keychain` means the Keychain write outcome is uncertain; and
- `reconcile_rotation` means credential or journal settlement is uncertain.

The last two states never enable another authorization. `do_not_retry` also
fails closed. Successful status means only that the replacement principal was
verified, the exact Keychain item was persisted, and the journal settled as
`reauthorized`. It does not prove current connectivity, remote scope health, or
permission to send a message.

Before verification or Keychain access, the Connector fsyncs a durable
replacement reservation. Known pre-write failures restore the prior blocked
state. An uncertain Keychain write or interrupted process retains the
reservation, and the read-only recovery projection becomes
`reconciliation_required`. A newer exact Keychain bundle may later settle the
journal without repeating authorization; this UI does not yet expose that
reconciliation action.

## Verification and limitations

Synthetic tests cover secret-copy cleanup, explicit presentation, cancellation,
competing attempts, minimized recovery mapping, hostile accessors and URLs,
separate CSRF capabilities, same-origin and body enforcement, exact durable
recovery gating before Host invocation, invalid service results, default-path
composition, restart presentation, and shutdown. They use no live Feishu
account, network request, authorization grant, or Keychain item.

Still open:

- product actions and durable Audit for Keychain and rotation reconciliation;
- credential health, disconnect, revocation, and deletion;
- Cordis lifecycle activation and hosted polling; and
- live Feishu and macOS Keychain acceptance.
