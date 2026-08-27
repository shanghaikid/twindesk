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
execution authority.

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
- Secret resolution, short-lived in-memory handling, refresh, revocation, and
  Keychain integration are not implemented.
- Required and granted scopes are not persisted by this identity record;
  runtime scope and health diagnostics belong to TD-208.
- TD-201 implements the verified in-memory Bot message consumer and hash-only
  receipt journal, but no callback host, subscription setup, or Encrypt Key
  resolver is wired. See
  [Feishu Bot Event Ingestion](FEISHU_BOT_EVENT_INGESTION.md).
- User-visible incremental discovery begins in TD-202.
- No reply proposal, approval, send, or other external write is implemented.

## Verification

`tests/feishu-identities.test.mjs` covers:

- separate Bot and User parsing and credential-free ActionIdentity projection;
- exact version, identity-slot, credential-purpose, and locator separation;
- accessor and undeclared secret-field rejection without payload echo;
- file-backed restart recovery and `0600` permissions;
- rejected-write rollback and preservation of the last valid document;
- symbolic-link, oversized-document, directory, and invalid-path rejection.
