# Workbench Feishu User Identity Bootstrap

TD-209 adds a create-only product flow for the non-secret metadata required to
represent one Feishu User identity. It lets an empty local installation create
its first Feishu connection, or lets a Bot-only connection add its User slot.
It does not edit an existing User, create or read a Keychain item, start OAuth,
call Feishu, validate a principal remotely, or grant a scope.

## Persisted boundary

`createWorkbenchFeishuUserIdentityBootstrapper()` accepts only:

- schema version 1 and the expected `new` or `existing` connection mode;
- a Feishu App ID for a new connection only;
- a display name; and
- the User `open_id` used as the configured principal.

For a new connection, Workbench generates an opaque TwinDesk account ID and a
distinct opaque `system_keychain` SecretReference with purpose
`connector_oauth`. For a Bot-only connection, it preserves the existing
account ID, app ID, Bot identity, and Bot SecretReference and generates only
the new User SecretReference. Neither generated locator passes through the
browser.

The Connector-owned identity parser validates the complete versioned document
again before its private `0600` atomic replacement. App IDs, display names, and
principal IDs are non-secret but may identify a company application or person;
they remain only in the local Connector Settings document and the transient
same-origin request. They are not added to the minimized status response,
Audit, logs, model context, telemetry, or Thread export.

## Create-only rule

The bootstrapper reads the identity store again inside a serialized mutation.
Creation succeeds only when no User slot exists. Two competing requests cannot
replace each other: at most one observes the eligible state and writes. Once a
User exists, every later create request fails with a fixed payload-free error.

Existing User identity replacement is intentionally separate. Changing the
app, principal, or SecretReference without coordinating the current Keychain
credential and OAuth authorization could silently invalidate identity and
scope evidence. A later replacement flow must present that consequence,
coordinate credential recovery, and preserve the normal policy boundaries.

## Local Web boundary

The minimized `GET /api/settings/feishu` response still contains only identity
types and OAuth completeness. When creation is eligible, a response header
advertises either `new` or `existing` mode and supplies the same process-local
CSRF capability used by OAuth Settings editing.

The browser sends the exact create schema to
`POST /api/settings/feishu/user-identity`. The mutation requires the exact
bound Host and Origin, `Sec-Fetch-Site: same-origin`, the 256-bit CSRF header,
exact JSON media type, a declared body no larger than 16 KiB, and independent
Web, Workbench, and Connector validation. The form never accepts an account
ID, SecretReference, credential, token, client secret, redirect URI, or
filesystem path.

The server accepts success only when the writer's revalidated presentation now
contains a User identity. A stale but otherwise valid snapshot becomes a fixed
`503`, not false success. Because persistence may have completed before a
transport, presentation, or response failure, the UI labels every failed POST
as potentially uncertain and tells the user to refresh Settings before any
retry; it never automatically repeats the create request.

Creating metadata produces an `incomplete` Settings state and explicitly says
that no credential was created. It unlocks the separate OAuth Settings form;
once Settings are ready, the separate initial authorization entry may verify
the configured principal and persist a Keychain credential. Identity creation
alone does not claim that the principal is correct, that a Keychain item exists,
that OAuth is authorized, or that Feishu is reachable.

## Verification and limits

Synthetic tests cover empty bootstrap, Bot-preserving User addition, generated
opaque references, restart recovery, competing requests, hostile accessors,
unknown or credential-like fields, request-forgery rejection, browser/server
schema agreement, stale-presentation rejection, and the default Workbench Web
composition. Tests use only
temporary homes and synthetic identifiers and perform no Keychain or external
network access.

Still open:

- reauthorization and Keychain reconciliation UI;
- safely replace or edit an existing identity;
- edit existing Bot identity metadata;
- disconnect, delete, and revoke identity and credentials;
- record a dedicated Settings-change Audit without copying identifiers;
- live acceptance of owner activation and polling after first creation; and
- pass live Feishu registration and account acceptance.

The initial credential entry is documented in
[Workbench Feishu OAuth Authorization UI](WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_UI.md).
The parallel create-only Bot flow is documented in
[Workbench Feishu Bot Identity Bootstrap](WORKBENCH_FEISHU_BOT_IDENTITY_BOOTSTRAP.md).
