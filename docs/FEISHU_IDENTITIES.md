# Feishu Bot and User Identities

TD-200 defines the first `@twindesk/plugin-feishu` boundary. It does not
connect an account, resolve a secret, call Feishu, or grant a scope.

## Identity Boundary

One configured Feishu application has a stable TwinDesk account ID and app ID,
then may contain either or both identity slots:

| Identity | Credential reference purpose | Represents | Visibility boundary |
|---|---|---|---|
| Bot | `connector_app_credential` | The installed Feishu application Bot | Bot direct messages, chats containing the Bot, mentions, and events actually delivered to the application; never the user's private account resources merely because the Bot exists |
| User | `connector_oauth` | One user who separately authorized the application | Only resources exposed by the relevant user-access-token API, application scopes, user consent, and Feishu restrictions; never a guarantee of all user messages |

The Bot and User slots have distinct principal IDs, display names, identity
types, and credential references. They may share an application and TwinDesk
account ID, but they may not reuse one credential reference. Bot application
credentials do not become User OAuth credentials, and User authorization does
not make the Bot act as the user.

`toFeishuActionIdentity()` projects one configured slot into the existing
credential-free `ActionIdentity` boundary. The projection contains only the
Connector ID, TwinDesk account ID, identity type, and display name. Selecting
that identity records who would act; it grants no Tool, scope, approval, or
execution authority. Feishu reply proposals additionally place a salted hash of
the selected app, principal, and SecretReference metadata in their idempotency
key. TD-207 recomputes that fingerprint before execution so a configuration
rotation cannot silently reuse an older approval; the principal and credential
reference are not copied into the proposal itself.

## Persisted Configuration

`FeishuIdentityConfigurationStore` stores version 1 JSON through an atomic
same-directory replacement. A new file is created with mode `0600`. Reads use
`O_NOFOLLOW`, reject symbolic links and non-regular files, and limit the
document to 64 KiB. Unknown fields, accessors, unsupported versions, mixed
identity slots, incompatible credential purposes, and shared Bot/User
credential locators fail closed without serializing rejected values.

The persisted document may contain:

- the TwinDesk account ID and Feishu app ID;
- Bot and User display names and principal IDs;
- each opaque SecretReference ID, store kind, and purpose.

It must never contain an app secret, tenant token, user access token, refresh
token, cookie, private key, or OAuth authorization response. Actual credential
bundles belong in the system Keychain or a dedicated encrypted secret store.
Deleting this configuration does not revoke Feishu authorization or delete the
referenced secret; those are separate operations.

## Privacy and Retention

App IDs, principal IDs, and display names may identify a company application or
person. They remain in the selected local configuration file until it is
replaced or explicitly removed. They are not part of Thread export or deletion
because Connector identity configuration is shared across Threads. They must
not enter model context, diagnostic logs, telemetry, or the Audit Timeline by
default. A future Connectors editing flow must expose an explicit disconnect and local
configuration deletion path, separately from OAuth revocation and Keychain
secret deletion.

The product Connectors page now has create-only Bot and User bootstraps. An
empty connection can begin with either slot; the second identity is added to
the same app while preserving all existing metadata and references. Workbench
generates the opaque TwinDesk account and distinct Keychain-reference locators
without accepting or creating credential bytes. Bot creation does not create
the separate event-subscription secret. Existing identity replacement remains separate because
changing identity metadata without coordinating its credential and OAuth state
would invalidate established bindings. See
[Workbench Feishu User Identity Bootstrap](WORKBENCH_FEISHU_USER_IDENTITY_BOOTSTRAP.md)
and [Workbench Feishu Bot Identity Bootstrap](WORKBENCH_FEISHU_BOT_IDENTITY_BOOTSTRAP.md).

## Current Limitations

- The Workbench now selects the private macOS product configuration path and
  the default Web launcher projects identity types plus OAuth completeness into
  a minimized Connectors status. Create-only User metadata and OAuth
  callback/scope configuration are available; existing identity replacement,
  disconnect, revocation, credential health, and other platform
  paths remain open. See
  [Workbench Feishu Settings Presentation](WORKBENCH_FEISHU_SETTINGS_PRESENTATION.md).
- A macOS system-Keychain reader now resolves validated Bot/User references
  into callback-scoped byte buffers and zeroes them afterward. A versioned
  parser now binds Bot application and User OAuth bundles to the exact identity
  and exposes explicit refresh state. A fixed-endpoint, bounded v3 Fetch client
  validates rotated token responses, and separate encoding plus Keychain update
  primitives are now composed by a secret-free, restart-durable single-Host
  rotation journal. A state-bound S256 PKCE flow now exchanges the exact
  one-time callback, and a post-exchange verifier plus bounded production user-info
  Fetch client bind the returned User `open_id` before the exact initial
  Keychain replacement. This path and an exclusive Host lease pass synthetic
  contracts, and fixed reply plus User-search HTTP primitives are now covered
  synthetically. Workbench composes reply execution and User polling under
  lease-held production-shaped adapters, and Cordis now activates them beneath
  one shared owner. A separate `connector_api_key` Keychain reference now
  resolves the app-bound Verification Token and Encrypt Key only inside each
  hosted Bot callback. Revocation handling, context API adapters, automatic
  lifecycle restart, and live acceptance remain open. See
  [Feishu System Keychain Resolution and Replacement](FEISHU_SYSTEM_KEYCHAIN.md) and
  [Feishu Credential Bundles](FEISHU_CREDENTIAL_BUNDLES.md) and
  [Feishu OAuth v3 Refresh](FEISHU_OAUTH_V3_REFRESH.md) and
  [Feishu OAuth Rotation Coordinator](FEISHU_OAUTH_ROTATION_COORDINATOR.md) and
  [Feishu Runtime Lease](FEISHU_RUNTIME_LEASE.md) and
  [Feishu Reply HTTP Client](FEISHU_REPLY_HTTP_CLIENT.md) and
  [Feishu OAuth User Principal Verification](FEISHU_OAUTH_PRINCIPAL_VERIFICATION.md).
- Required and granted scopes are not persisted by this identity record.
  TD-208 now defines a runtime-only scope, rate, health, and cursor diagnostics
  boundary; Workbench now composes its concrete probes and minimized Connectors
  UI, while live User connectivity and normalized rate observations remain open. See
  [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).
- TD-201 now wires the verified Bot consumer, app-bound Keychain subscription
  secrets, hash-only receipt journal, fixed loopback callback route, and durable
  Inbox normalization under the Cordis Host lifecycle. Public TLS forwarding,
  subscription setup, and live delivery remain open. See
  [Feishu Bot Event Ingestion](FEISHU_BOT_EVENT_INGESTION.md).
- TD-202 implements bounded, explicitly partial User message discovery,
  candidate cursors, the concrete OAuth/scope/Keychain/HTTP search adapter, and
  a restart-safe Workbench polling composition. Cordis activation is covered
  synthetically; live polling remains open. See
  [Feishu User Message Discovery](FEISHU_USER_MESSAGE_DISCOVERY.md).
- TD-203 implements the User-bound, bounded context adapter contract for
  conversation messages, document excerpts, and attachment text or metadata,
  but no concrete Feishu API adapter is wired. See
  [Feishu Context Retrieval](FEISHU_CONTEXT_RETRIEVAL.md).
- TD-205 through TD-207 implement the proposal, approval, and
  reconcile-before-send boundaries with synthetic clients. The isolated
  Keychain reader, credential parser, and durable dispatch journal do not make
  those clients production-ready; no Feishu token exchange, HTTP, or composed
  real-account write path is wired.

## Verification

`tests/feishu-identities.test.mjs` covers:

- separate Bot and User parsing and credential-free ActionIdentity projection;
- exact version, identity-slot, credential-purpose, and locator separation;
- accessor and undeclared secret-field rejection without payload echo;
- file-backed restart recovery and `0600` permissions;
- rejected-write rollback and preservation of the last valid document;
- symbolic-link, oversized-document, directory, and invalid-path rejection.
