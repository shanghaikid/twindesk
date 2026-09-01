# Feishu OAuth Authorization Configuration

## Scope

TwinDesk defines a version 1, non-secret
`FeishuOAuthAuthorizationConfiguration` for the settings that must match one
Feishu application's registered authorization setup. It binds:

- the exact Feishu `appId`;
- one explicit literal-loopback redirect URI; and
- the fixed scopes presented for User authorization.

The configuration grants no Connector authority. Feishu's returned scopes,
the configured User identity, current Keychain credential, operation policy,
approval, and external-write checks remain authoritative at their existing
boundaries.

## Redirect Rules

The redirect URI must be canonical HTTP on `127.0.0.1` or `[::1]`, include an
explicit nonzero, non-default port, and contain a bounded path made only from
ASCII letters, digits, slash, underscore, and hyphen. User information, query,
fragment, encoded path aliases, `localhost`, HTTPS, port zero, and implicit or
explicit port 80 are rejected.

Port zero remains useful for isolated callback-listener tests, but it cannot
represent an exact application registration and is therefore excluded from
this production-facing configuration shape.

The Workbench authorization Host validates that this `appId` equals the
identity configuration's app and, after binding, that the listener's actual
redirect URI exactly equals the configured URI. A mismatch closes the listener,
releases the Host lease, shows no authorization URL, and performs no Keychain
read, exchange, or write.

## Scope and Data Rules

The scope list is bounded, unique, syntactically strict, sorted on parse, and
must contain `offline_access`. This list controls only what the authorization
request asks Feishu to present. It never substitutes for the actual scopes in
the returned token or for operation-specific scope authorization.

The parser accepts only plain data with the exact versioned fields, evaluates
no accessors, and returns a deeply frozen value. The shape contains no client
secret, authorization code, PKCE state or verifier, token, principal, account,
or Keychain reference.

`FeishuOAuthAuthorizationConfigurationStore` persists only that parsed shape in
a bounded JSON file. Writes validate before touching disk, use a private `0600`
temporary file, flush it, and atomically rename it over the prior regular file.
The parent directory is flushed after the rename. Reads use `O_NOFOLLOW` and a
bounded read, reject symlinks, directories, files above 64 KiB, malformed UTF-8,
invalid JSON, and unsupported versions, and return `undefined` only when the
file is absent. A validation-rejected write retains the last valid document.

## Verification and Remaining Work

Synthetic tests cover IPv4 and IPv6 loopback configuration, canonicalization,
sorting, immutability, missing and duplicate scopes, hostile data, wrong
versions, non-loopback and dynamic redirects, app mismatch, and listener
mismatch before presentation. Store tests prove atomic restart recovery, `0600`
mode, rejected-write rollback, and fail-closed symlink, oversized, corrupt, and
invalid-path handling. No live port registration or Feishu account is used as
acceptance evidence.

Still open:

- editing through product Settings;
- browser launching and authorization recovery UI;
- live verification that the configured URI is registered for the application;
- Cordis lifecycle activation and live-account acceptance.
