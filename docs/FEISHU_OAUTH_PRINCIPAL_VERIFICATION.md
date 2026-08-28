# Feishu OAuth User Principal Verification

## Scope

TD-209 adds `FeishuOAuthUserPrincipalVerifier`, a fail-closed boundary between
a freshly acquired User access token and any initial credential persistence.
It calls a narrowly injected user-info client and allows its callback to run
only when the returned Feishu `open_id` exactly matches the configured User
principal. It does not exchange an authorization code, host a redirect, write
the Keychain, grant scopes, or authorize a Connector operation.

The boundary follows Feishu's official
[OAuth v3 user-access-token contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)
and
[user-info contract](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get).

## Identity Rule

An authorization code is valid for five minutes and can be exchanged only
once. A successful v3 exchange returns the actual granted scopes and, when
`offline_access` is granted, a single-use refresh token. Those tokens do not by
themselves prove that the person completing authorization is the User principal
selected in TwinDesk configuration.

Before initial persistence, TwinDesk must use the returned access token for:

```text
GET https://open.feishu.cn/open-apis/authen/v1/user_info
Authorization: Bearer <fresh User access token>
```

The endpoint requires no additional scope for `open_id`. TwinDesk compares only
that application-scoped identifier. Names, avatars, email addresses, phone
numbers, employee numbers, and other profile fields are neither needed for the
binding nor accepted by the verifier's minimized client response.

## Client and Secret Boundary

The injected client receives one frozen request containing the fixed method,
fixed URL, a 16 KiB response limit, and a dedicated copy of the access-token
bytes. Shared-memory token views are rejected. The dedicated copy is
overwritten on every exit. The source buffer remains owned by the surrounding
token-exchange callback and must be cleared there.

The client returns exactly `{ openId }`; unknown fields, accessor objects,
invalid identifiers, and identity mismatch fail before the verified callback.
Errors contain no token, configured principal, observed principal, profile
data, or thrown client payload. Cancellation before the verified callback
propagates while transient token bytes are still cleared. Once the callback
reports that persistence completed, its result remains authoritative even if
cancellation arrived during the write; a callback that cancels before
completion must throw.

## Verification and Remaining Work

Synthetic tests cover the exact request contract, matching and mismatching
principals, malformed and hostile responses, invalid configuration and tokens,
client failure, cancellation, completed-write cancellation semantics, strict
constructor options, payload-free errors, shared-memory rejection, and
transient-copy zeroing. They make no network request.

Remaining work includes the authorization-code and PKCE request boundary, a
bounded production Fetch client for user info, composition that encodes and
writes the initial credential only inside the verified callback, redirect-state
and replay protection, runtime Connector ownership, UI, and live-account
acceptance.
