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
default. A future Connectors UI must expose an explicit disconnect and local
configuration deletion path, separately from OAuth revocation and Keychain
secret deletion.

## Current Limitations

- No default configuration path or Connectors UI is wired yet.
- A macOS system-Keychain reader now resolves validated Bot/User references
  into callback-scoped byte buffers and zeroes them afterward. A versioned
  parser now binds Bot application and User OAuth bundles to the exact identity
  and exposes explicit refresh state. A fixed-endpoint, bounded v3 Fetch client
  validates rotated token responses. Authorization-code identity verification,
  atomic Keychain refresh, revocation, writes/deletion, operation HTTP, and
  runtime composition are not implemented. See
  [Feishu System Keychain Resolution](FEISHU_SYSTEM_KEYCHAIN.md) and
  [Feishu Credential Bundles](FEISHU_CREDENTIAL_BUNDLES.md) and
  [Feishu OAuth v3 Refresh](FEISHU_OAUTH_V3_REFRESH.md).
- Required and granted scopes are not persisted by this identity record.
  TD-208 now defines a runtime-only scope, rate, health, and cursor diagnostics
  boundary; its production probe and settings UI remain unwired. See
  [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).
- TD-201 implements the verified in-memory Bot message consumer and hash-only
  receipt journal, but no callback host, subscription setup, or Encrypt Key
  resolver is wired. See
  [Feishu Bot Event Ingestion](FEISHU_BOT_EVENT_INGESTION.md).
- TD-202 implements bounded, explicitly partial User message discovery and
  candidate cursors, but no OAuth resolver, concrete search adapter, or polling
  scheduler is wired. See
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
