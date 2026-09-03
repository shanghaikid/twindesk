# Workbench Feishu Settings Presentation

TD-209 adds a read-only boundary from the two persisted Feishu Settings stores
to the product Connectors page. It reports configuration completeness without
reading a credential, calling Feishu, or granting Connector authority.

## Composition

`createWorkbenchFeishuSettingsPresentation()` accepts only concrete
`FeishuIdentityConfigurationStore` and
`FeishuOAuthAuthorizationConfigurationStore` instances. Each `read()` uses the
stores' validated current documents and produces a frozen version 1 snapshot.
The Web composition injects that reader into `startTwinDeskWebServer()`; the
server parses the snapshot again before serving `GET` or `HEAD`
`/api/settings/feishu`. A missing, failed, or invalid reader returns one fixed
`503` response.

`startWorkbenchWebServer()` opens the fixed macOS Settings stores and injects
the reader into the Web boundary. The default `web:start` launcher uses this
Workbench composition. The lower-level `@twindesk/web` server remains
independent of Workbench and Connector internals and can still receive an
explicit presentation-safe reader in tests or another composition root.

## Minimized response

The browser may receive only:

- the version and fixed `feishu` Connector ID;
- the configured identity types, `bot` and/or `user`;
- the literal-loopback OAuth redirect host and port;
- the sorted requested OAuth scopes; and
- whether the OAuth application's non-secret identifier matches the identity
  configuration, expressed only as a boolean.

It never receives the application ID, TwinDesk account ID, principal ID,
display name, SecretReference or its ID, filesystem path, redirect path, token,
client secret, authorization code, verifier, raw document, or thrown payload.
The browser parser rejects unknown fields, invalid or noncanonical arrays,
non-loopback hosts, invalid ports, and contradictory states.

## States and meaning

- `not_configured`: neither identity nor OAuth Settings exist;
- `ready`: a User identity exists and its application matches the OAuth
  Settings; or
- `incomplete`: every other partially configured or mismatched combination.

`ready` means only that these two non-secret Settings documents are internally
complete enough for the User authorization runtime. It does not prove that a
Keychain credential exists, consent remains valid, required operation scopes
are currently granted, Feishu is reachable, polling is hosted, or an external
write is authorized. The Connectors page labels it **Settings ready** for that
reason.

## Verification and remaining work

Synthetic tests cover empty, partial, matching, mismatched, IPv4, IPv6, restart,
immutability, hostile options, corrupt stores, browser contract rejection,
server-side revalidation, fixed failure responses, and absence of identifying
or secret-reference fields. No real home directory, Keychain item, Feishu
account, or network request is used.

Still open:

- automatically reconstruct the Cordis polling lifecycle after Settings change;
- replace/edit existing identities, create Bot identities, manage actual
  credentials, disconnect, and revoke. The create-only User bootstrap and
  narrow OAuth callback/scope editor are documented in
  [Workbench Feishu User Identity Bootstrap](WORKBENCH_FEISHU_USER_IDENTITY_BOOTSTRAP.md)
  and
  [Workbench Feishu OAuth Settings Editing](WORKBENCH_FEISHU_OAUTH_SETTINGS_EDITING.md);
- present authorization, credential, scope, and connectivity diagnostics
  separately; the initial authorization entry is documented in
  [Workbench Feishu OAuth Authorization UI](WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_UI.md),
  while durable credential health remains open;
- add deletion and recovery flows; and
- pass the live-account Stage 2 acceptance gate.
