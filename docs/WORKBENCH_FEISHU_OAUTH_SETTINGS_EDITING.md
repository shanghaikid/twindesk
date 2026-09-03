# Workbench Feishu OAuth Settings Editing

TD-209 adds the first product-owned Settings mutation: a user can edit the
non-secret literal-loopback callback host and port plus requested OAuth scopes
for an already configured Feishu User identity. This local configuration write
does not read or write a credential, start OAuth, call Feishu, grant a scope, or
authorize an external action.

## Separate read and write boundaries

`createWorkbenchFeishuSettingsPresentation()` remains read-only.
`createWorkbenchFeishuOAuthSettingsEditor()` is a separate narrow writer that
accepts concrete identity and authorization stores. The Workbench Web
composition explicitly supplies both capabilities to the lower-level Web
server.

The editor requires an existing User identity and derives the Feishu app ID
from its validated local configuration. The browser neither receives nor
submits the app ID, account ID, principal ID, display name, SecretReference,
credential, or filesystem path. The fixed callback path is
`/oauth/feishu/callback`; the form can select only `127.0.0.1` or `::1` and one
explicit non-default port. Scopes must be unique, sorted, syntactically valid,
and include `offline_access`.

The existing authorization store validates the complete app-bound document
again, writes a private `0600` temporary file, flushes it, atomically replaces
the prior document, and flushes the parent directory. Repeating the same update
is safe, and fresh store and Web instances recover the result after restart.

## Local request-forgery boundary

The same `/api/settings/feishu` resource remains read-only for `GET` and `HEAD`
and accepts the OAuth update through `POST` only. A write requires all of:

- an exact Host header for the server's bound literal-loopback origin;
- an exact same-origin `Origin` header;
- `Sec-Fetch-Site: same-origin`;
- a process-local 256-bit CSRF token obtained from the same-origin status
  response and returned in `X-TwinDesk-CSRF-Token`;
- exact `Content-Type: application/json`;
- a declared, non-streaming request body of at most 16 KiB; and
- the exact version 1 update schema, followed by validation in the independent
  Workbench editor and the Connector-owned store.

There is no CORS opt-in. Missing or mismatched origin, Fetch Metadata, Host, or
CSRF evidence fails before body parsing or writer access. Unknown fields,
accessors, sparse arrays, invalid UTF-8/JSON, dynamic or unsafe hosts and ports,
duplicate or unsorted scopes, missing `offline_access`, oversized bodies, and
unexpected query parameters fail closed. Writer and store failures return one
fixed payload-free unavailable response.

After a write, the server accepts success only when the revalidated snapshot
exactly reflects the requested callback and scopes. A stale presentation
becomes a fixed `503`. Since persistence may have completed before a transport
or response failure, the UI treats every failed POST as potentially uncertain,
asks the user to refresh Settings before retrying, and never retries
automatically.

The CSRF token is memory-only, applies to one running local server, is not a
credential, and is never placed in Settings, logs, Audit, exports, or model
context.

## Product behavior and limits

The Connectors page displays a compact OAuth editor only when the minimized
status proves that a User identity exists and the server advertises the write
capability. Saving is an explicit user-initiated local Settings operation; it
does not use an ActionProposal or external-write approval because it performs
no external effect. Requested scopes shown in the form are configuration, not
evidence that Feishu granted or still honors them.

Synthetic tests cover exact successful writes, same-value replay, IPv4/IPv6,
restart recovery, User/app binding, hostile objects, missing User identity,
origin/Host/Fetch Metadata/CSRF/media-type/body/schema rejection, bounded body
handling, stale-presentation rejection, fixed writer failures, and default
Workbench-to-Web persistence. They use temporary homes and loopback ports with
no real Keychain item, account, credential, or external network request.

Still open:

- replace or edit existing Bot/User identity metadata and SecretReferences;
- add or replace actual Keychain credentials;
- present reauthorization and reconciliation recovery; the separate initial
  authorization entry is documented in
  [Workbench Feishu OAuth Authorization UI](WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_UI.md);
- record a dedicated Settings-change audit without copying identifiers;
- disconnect, delete, and revoke configuration or credentials;
- automatically reconstruct the Cordis polling lifecycle after editing; and
- pass live Feishu registration and account acceptance.
