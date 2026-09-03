# Workbench Feishu Bot Identity Bootstrap

TD-209 adds a create-only product flow for the non-secret metadata required to
represent one Feishu Bot identity. An empty local installation may create its
first Feishu connection with a Bot slot, or a User-only connection may add the
Bot slot for the same application. The flow does not contact Feishu or prove
that the Bot, application credential, scopes, or public callback are usable.

## Persisted Boundary

`createWorkbenchFeishuBotIdentityBootstrapper()` accepts only version 1, the
Host-advertised `new` or `existing` mode, an app ID for a new connection, a
display name, and the Bot `open_id`. Workbench generates the opaque TwinDesk
account ID when needed and a distinct `system_keychain` SecretReference whose
purpose is `connector_app_credential`.

For an existing User-only connection, the bootstrapper preserves the account,
app, User identity, and User OAuth reference exactly. The generated Bot locator
never passes through the browser. The private identity store revalidates the
complete document before atomic replacement and persists no app secret, tenant
token, Verification Token, Encrypt Key, or OAuth credential.

The Bot application credential and event-subscription secret remain separate.
The latter uses a Host-only `connector_api_key` reference and is not created or
configured by this form. Creating Bot metadata therefore does not enable the
public event subscription route.

## Local Web Boundary

The minimized `GET /api/settings/feishu` body remains identifier-free. When Bot
creation is eligible, the response advertises only `new` or `existing` in
`x-twindesk-bot-identity-creation` and includes the process-local Settings CSRF
capability. Empty Settings may advertise both Bot and User `new` capabilities;
after either is created, only the missing slot is advertised as `existing`.

`POST /api/settings/feishu/bot-identity` uses the same exact bound Host,
same-origin Fetch Metadata, 256-bit CSRF, JSON media type, and 16 KiB body limit
as User identity creation. Web, Workbench, and Connector layers independently
reject unknown or credential-like fields. The server reports success only when
the revalidated post-write Settings snapshot contains the Bot slot.

Creation is serialized around a fresh store read, so competing requests cannot
replace one another. A response failure after persistence is treated as an
uncertain local write; the UI tells the user to refresh Settings and never
automatically retries.

## Verification and Limits

Synthetic tests cover empty creation, User-preserving addition, opaque
reference generation, cold restart, competing requests, hostile accessors,
credential-field rejection, CSRF routing, stale presentation, and the default
Workbench Web composition. They use temporary homes and no Keychain or network
access.

Still open are existing Bot replacement, credential installation or repair,
event-subscription secret setup, disconnect/revocation, Settings-change Audit,
public TLS forwarding, live Bot delivery, and Stage 2 live-account acceptance.
