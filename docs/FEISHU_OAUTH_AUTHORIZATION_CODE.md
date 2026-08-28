# Feishu OAuth Authorization Code and PKCE

## Scope

TD-209 adds an in-memory `FeishuOAuthAuthorizationFlow` for one explicit User
authorization transaction. It creates a state-bound S256 PKCE authorization
URL, validates the exact redirect callback, consumes a matched callback once,
and exchanges its code through the existing bounded OAuth v3 transport. It
does not host the loopback listener, open a browser, select the configured User
principal, or persist the returned credential.

The contract follows Feishu's official
[authorization-code request](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)
and
[OAuth v3 user-access-token exchange](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3).
Feishu documents that an authorization code expires after five minutes and can
be used only once. The v3 exchange accepts a 43–128 character RFC 7636
`code_verifier`; applications created through the developer platform remain
confidential clients and must also provide their client secret.

## Authorization Transaction

Each `start()` call creates independent 256-bit random values for `state` and
the PKCE verifier. The authorization URL fixes:

```text
GET https://accounts.feishu.cn/open-apis/authen/v1/authorize
response_type=code
code_challenge_method=S256
prompt=consent
```

The URL includes the configured application ID, exact redirect URI, sorted
requested scopes, state, and SHA-256 PKCE challenge. `offline_access` is
required because the current credential format and restart-safe lifecycle
require the documented refresh token. Scope configuration is not authority;
the exchange accepts only Feishu's returned actual scope list as the token
set's granted scopes.

HTTPS redirects are accepted. Plain HTTP is restricted to literal IPv4 or IPv6
loopback addresses, following the native-application loopback threat model;
hostnames and non-loopback HTTP endpoints fail closed. Redirect URIs containing
credentials, an existing query, or a fragment are rejected so callback matching
has one unambiguous target and query shape.

The session holds its client-secret copy and PKCE verifier only in memory.
`cancel()` clears both. A session that is abandoned without cancellation relies
on garbage collection, so the future UI lifecycle must cancel authorization
when its window or listener closes.

## Callback and Replay Rules

Success callbacks must contain exactly one `code` and one matching `state`.
Denial callbacks must contain exactly `error=access_denied` and the matching
state. Duplicate or unknown query fields, a different origin/path/port, a
fragment, an invalid code, and a mismatched state are rejected before transport
access. State comparison is constant-time for the fixed-size value.

A mismatched or malformed callback does not consume the transaction, because
an unrelated local request must not be able to invalidate the legitimate
browser callback. A correctly state-bound success or denial consumes it
synchronously. Concurrent or later callback attempts cannot exchange again.

## Exchange and Failure Rules

The matched success callback produces one form-encoded request:

```text
POST https://accounts.feishu.cn/oauth/v3/token
grant_type=authorization_code
client_id=<configured app ID>
client_secret=<in-memory client secret>
code=<single-use authorization code>
redirect_uri=<exact authorization redirect URI>
code_verifier=<in-memory PKCE verifier>
```

The form body, response body, verifier, client-secret copy, and returned token
buffers are overwritten on every terminal exit. JavaScript URL and JSON
processing still creates short-lived immutable strings; they must never enter
logs, errors, persistence, diagnostics, Session data, or model context.

Once transport begins, a network failure, cancellation, timeout, HTTP 429/5xx,
malformed response, or invalid clock cannot safely replay the same code. The
session reports an uncertain exchange requiring a fresh authorization. Feishu
codes for expired, used, mismatched, or PKCE-failed codes also require a new
authorization. Client application failures require configuration repair.

The token set is callback-scoped and requires `Bearer`, bounded access and
refresh tokens, positive server lifetimes, and `offline_access`. Once its
consumer reports success, that result is authoritative even if cancellation
arrives during the callback; this prevents a completed verified persistence
write from being misreported as safe to repeat.

## Verification and Remaining Work

Synthetic tests cover the exact authorization URL and exchange form, S256
challenge and verifier, actual scopes and lifetimes, wrong-state recovery,
denial, cancellation, callback replay and concurrency boundary, single-use
uncertainty, official code failures, hostile inputs, redirect restrictions,
completed-consumer cancellation semantics, payload-free errors, and transient
buffer zeroing. They use injected randomness and transport and make no live
request.

The verified callback now composes the bounded User-info endpoint, initial
version 1 encoding, and exact Keychain replacement as described in
[Feishu OAuth Verified Initial Persistence](FEISHU_OAUTH_INITIAL_PERSISTENCE.md).
The exclusive Host lease also passes cross-process tests. A hosted loopback
listener, browser/UI lifecycle, runtime composition under the lease, operation
clients, and live-account acceptance remain open.
