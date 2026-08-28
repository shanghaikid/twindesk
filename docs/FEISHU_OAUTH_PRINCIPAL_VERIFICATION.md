# Feishu OAuth User Principal Verification

## Scope

TD-209 adds `FeishuOAuthUserPrincipalVerifier`, a fail-closed boundary between
a freshly acquired User access token and any initial credential persistence,
plus `FeishuOAuthUserInfoHttpClient`, its fixed-endpoint production Fetch
adapter. The verifier allows its callback to run only when the returned Feishu
`open_id` exactly matches the configured User principal. The separate
authorization flow now exchanges the code, but this verifier does not host a
redirect, write the Keychain, grant scopes, or authorize a Connector operation.

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

## Production HTTP Boundary

`FeishuOAuthUserInfoHttpClient` accepts only the verifier's exact fixed-method,
fixed-URL request. It validates the access token as bounded visible ASCII before
forming the required Bearer header, rejects shared-memory token views and HTTP
redirects, omits ambient credentials and referrer data, disables caching, and
uses a 30-second timeout with a two-minute configuration ceiling.

Declared and streamed responses are bounded to 16 KiB. The client requires the
documented JSON response envelope, rejects invalid UTF-8 and duplicate JSON
object fields, and clears every received byte chunk. It accepts the documented
profile object only long enough to extract `data.open_id`; names, avatars,
emails, phone numbers, employee identifiers, tenant identifiers, and unknown
profile fields are discarded and never enter its return value or errors.

Feishu error `20005` and HTTP 401/403 require reauthorization. Error `20050`,
HTTP 429, HTTP 5xx, network failure, and timeout are explicitly retryable.
Users reported as missing, resigned, frozen, or unregistered fail without blind
retry. All other malformed or rejected responses fail closed. JavaScript Fetch
requires a temporary immutable Authorization header string, and JSON parsing
creates a temporary decoded response string; neither can be overwritten.
TwinDesk retains or logs neither string, while the owned token and response byte
buffers are still cleared by their respective boundaries.

## Verification and Remaining Work

Synthetic tests cover the exact verifier and HTTP requests, matching and
mismatching principals, response streaming and overflow, redirect and media
rejection, duplicate fields, official service errors, network failure, timeout,
cancellation, completed-write cancellation semantics, strict constructor
options, payload-free errors, shared-memory rejection, profile minimization,
and transient-buffer zeroing. They make no network request.

The authorization-code and PKCE request boundary is described in
[Feishu OAuth Authorization Code and PKCE](FEISHU_OAUTH_AUTHORIZATION_CODE.md).
The verified callback now composes initial encoding and Keychain replacement as
described in [Feishu OAuth Verified Initial Persistence](FEISHU_OAUTH_INITIAL_PERSISTENCE.md).
The exclusive Host lease also passes cross-process tests. Remaining work
includes a hosted redirect listener, runtime composition under the lease, UI,
and live-account acceptance.
