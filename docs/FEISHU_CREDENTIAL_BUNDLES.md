# Feishu Credential Bundles

## Scope

TD-209 adds a versioned parser between the macOS Keychain byte reader and
future Feishu HTTP adapters. `FeishuCredentialBundleParser` accepts one bounded
UTF-8 JSON bundle, binds it to the exact configured Bot or User identity, and
exposes validated secrets only inside a callback.
`FeishuOAuthCredentialBundleEncoder` creates the same exact User format from a
validated current credential and rotated OAuth token set. Neither boundary
obtains a token, calls Feishu, grants a scope, revokes authorization, or
authorizes an external write.

## Version 1 Formats

The Bot reference stores an application credential:

```json
{
  "kind": "feishu_app_credential_bundle",
  "schemaVersion": 1,
  "appId": "cli_...",
  "appSecret": "..."
}
```

The User reference stores the confidential-client material and the latest
rotating OAuth token pair:

```json
{
  "kind": "feishu_user_oauth_credential_bundle",
  "schemaVersion": 1,
  "appId": "cli_...",
  "principalId": "ou_...",
  "clientSecret": "...",
  "tokenType": "Bearer",
  "accessToken": "...",
  "obtainedAt": "2026-08-28T07:00:00.000Z",
  "accessTokenExpiresAt": "2026-08-28T09:00:00.000Z",
  "refreshToken": "...",
  "refreshTokenExpiresAt": "2026-09-04T07:00:00.000Z",
  "scopes": ["im:message", "offline_access"]
}
```

Unknown or duplicate fields, unsupported versions, invalid UTF-8, noncanonical
timestamps, unsorted or duplicate scopes, missing `offline_access`, unexpected
token types, and oversized values fail closed. One terminal LF or CRLF from the
Keychain command is accepted. The bundle is limited to 32 KiB and each OAuth
token to 4 KiB.

The app ID must match the configured application. A User bundle must also match
the exact configured User principal; a Bot bundle cannot be consumed through
the User slot or vice versa. Bundle parsing does not make the listed scopes
authoritative for an operation: the future HTTP adapter must still check the
current required and granted scopes at the point of use.

## Expiration and Refresh State

All lifetime decisions use an injected trusted local clock. An access token
strictly newer than the observed time is `usable`; an expired access token with
an unexpired refresh token is `refresh_required`. An expired refresh token
fails with `credential_expired` and requires user authorization. Future
acquisition times and invalid lifetime ordering fail closed.

Feishu's official OAuth v3 documentation defines the token endpoint and the
rotating refresh flow. A refresh token is returned only when `offline_access`
is authorized, is single-use, and must be replaced with the new token returned
by a successful refresh. The parser preserves those prerequisites. The separate
[Feishu OAuth v3 Refresh](FEISHU_OAUTH_V3_REFRESH.md) boundary validates the
refresh request and response through a bounded production transport. The
encoder and Keychain replacer remain independent primitives and do not provide
serialized or recoverable atomic rotation. See the official
[user access-token v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)
and
[refresh-token v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)
contracts.

## Secret Lifetime and Failure Handling

The source Keychain buffer is overwritten on every exit. Parsed app secrets,
client secrets, access tokens, and refresh tokens are exposed as `Uint8Array`
values and overwritten immediately after the consumer callback settles,
including callback failure and cancellation. The parsed wrapper and scope list
are frozen.

The encoder carries forward only the bound app, principal, and client secret;
the prior access and refresh tokens are never copied into the new bundle. It
requires a strictly later acquisition timestamp, a refresh token distinct from
the current single-use token, authoritative sorted scopes with
`offline_access`, and the same size limits as the parser. Its encoded buffer
is callback-scoped and overwritten after use. Encoding JSON necessarily
creates temporary immutable strings for the client secret and rotated tokens;
they are never logged, persisted outside the Keychain value, or returned in
errors.

JavaScript JSON decoding necessarily creates temporary immutable strings that
cannot be retroactively erased. A consumer that decodes, copies, transfers, or
logs a secret creates another lifetime it must control; the parser cannot erase
such copies. Callers must keep consumption callback-scoped and must never place
credential values in logs, errors, SQLite, Audit, Session data, model context,
or diagnostics.

Errors use bounded typed codes and never echo the rejected bundle, identity,
token, scope, or raw parser failure. Cancellation propagates without changing
the cancellation error. A consumer failure also propagates unchanged after
buffers are cleared.

## Verification and Remaining Work

Synthetic tests cover Bot/User identity binding, exact schemas, duplicate
fields, size and encoding bounds, scope and lifetime rules, refresh-required
and reauthorization states, rotated encoding and parse-back, old-token
exclusion, hostile data, cancellation, callback failures, payload-free errors,
and source plus derived-buffer zeroing. A synthetic replacement is read and
parsed through fresh primitive instances to cover restart independence without
touching a live Keychain item.

Remaining TD-209 work includes authorization-code principal verification,
serialized single-use refresh coordination with durable uncertain-state
recovery, tenant-token acquisition for Bot operations, minimum scope checks,
Feishu operation HTTP composition, runtime lifecycle, product UI, and an
authorized live-account acceptance run.
