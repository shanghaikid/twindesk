# Feishu OAuth v3 Refresh

## Scope

TD-209 adds a strict OAuth v3 refresh boundary for an already principal-bound
User credential. `FeishuOAuthV3TokenRefresher` builds the exact refresh request,
validates Feishu's response, classifies recovery, and exposes the rotated token
pair only inside a callback. It does not start user authorization, verify an
authorization-code principal, write the system Keychain, compose a live
credential lifecycle, or grant permission for any Connector operation.

The boundary follows Feishu's official
[OAuth v3 refresh contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3).

## Request Contract

The client sends one fixed request through an injected transport:

```text
POST https://accounts.feishu.cn/oauth/v3/token
Accept: application/json
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
client_id=<configured app ID>
client_secret=<callback-scoped client secret>
refresh_token=<callback-scoped current refresh token>
```

Form encoding is constructed directly into a byte buffer so the client secret
and refresh token do not need to become additional JavaScript strings. The
request metadata and headers are frozen. The request body is overwritten as
soon as the transport settles, including transport failure and cancellation.
An injected transport must treat the body as borrowed secret data and must not
retain, log, or copy it beyond the request.

This boundary deliberately omits the optional `scope` request field. It does
not silently reduce previously granted authorization during refresh. The
response's `scope` field remains authoritative.

## Production HTTP Boundary

`FeishuOAuthV3HttpTransport` uses the runtime Fetch implementation against only
the fixed token URL. It sends no cookies or referrer, disables caching, rejects
redirects, and applies a 30-second default timeout. A configured timeout must be
positive and cannot exceed two minutes.

The transport rejects a declared `Content-Length` above 32 KiB before reading
the response and enforces the same limit incrementally when the header is absent
or compressed content expands. Received stream chunks are overwritten after
copying into the one response buffer owned by the refresher. Redirects,
non-JSON OAuth responses, malformed Fetch results, and size violations fail
closed without including upstream data in errors. HTTP 429 and 5xx responses
remain retryable even if an intermediary returns an empty or non-JSON body.

The production transport is not yet composed with the Keychain resolver or a
live account. Tests inject Fetch and never send a network request.

## Response and Lifetime Rules

The response body is bounded to 32 KiB and must be strict UTF-8 JSON with the
documented success shape. TwinDesk requires:

- `code: 0` and a successful HTTP status;
- `token_type: Bearer`;
- access and refresh tokens no longer than 4 KiB each;
- a refresh token that differs from the single-use token submitted in the
  request;
- positive server-supplied access and refresh lifetimes within a bounded
  one-year safety horizon;
- a dense, unique scope list that still contains `offline_access`.

TwinDesk samples an injected trusted clock after receiving the response and
derives both expiration timestamps from Feishu's returned lifetime fields. It
does not hardcode the normal two-hour or seven-day examples. Returned scopes
are normalized into a sorted list for the version 1 credential bundle.

All non-secret fields are validated before token byte buffers are allocated.
The response body and parsed access/refresh token buffers are overwritten after
the consumer callback settles. JSON decoding necessarily creates temporary
immutable token strings that JavaScript cannot retroactively erase; callers
must not create further copies or send them to logs, errors, persistence,
Audit, Session data, diagnostics, or model context.

## Failure Classification

Errors are typed, bounded, and contain no upstream payload or token value:

| Classification | Examples | Required handling |
|---|---|---|
| `reauthorization_required` | invalid, expired, revoked, or already-used refresh token; invalid user authorization state | Start a new explicit user authorization flow |
| `configuration_invalid` | invalid client secret; app absent, disabled, or not allowed to refresh | Repair and publish the application configuration; do not retry unchanged |
| `retry_later` | Feishu `20050`/`20072`, HTTP 429/5xx, or transport failure | Retry later with the same still-current credential only |
| `invalid_response` | malformed JSON, unknown fields, invalid token type, scope, lifetime, or HTTP combination | Fail closed; do not persist or use returned data |

Official error codes `20037`, `20064`, and `20073` are not ordinary retry
signals: Feishu documents the refresh token as expired, revoked, or already
used. Retrying the same token cannot restore authorization.

Cancellation is checked before transport, after response receipt, before token
use, and after the consumer callback. Cancellation and consumer failures still
clear all transient buffers.

## Identity and Rotation Boundary

Refresh applies only after `FeishuCredentialBundleParser` has bound the current
OAuth bundle to the configured app and User principal. The refresh token is
therefore the server-side continuity proof for that authorization. Initial
authorization-code exchange remains separate because its returned access token
must be used to verify the actual Feishu User identity before TwinDesk can bind
and persist a principal.

Feishu rotates refresh tokens: after a successful response the old refresh
token is immediately invalid. The next composition step must serialize the new
version 1 credential bundle and update the exact OAuth `SecretReference` in the
system Keychain before exposing the new access token to Connector operations.
If that local update is uncertain, TwinDesk must not use the new token or retry
the old refresh token as though no remote effect occurred.

## Verification and Remaining Work

Synthetic tests cover the exact endpoint and form bytes, Fetch options,
redirect rejection, declared and streamed response limits, percent encoding,
authoritative scopes and server lifetimes, distinct-token rotation,
single-use reauthorization errors,
temporary failures, malformed responses, hostile accessor objects, invalid
inputs and clocks, timeout, cancellation, payload-free errors, and transient
buffer zeroing. No real credential or network request is used.

Version 1 bundle encoding and the stdin-only atomic Keychain replacement
primitive are composed by the
[durable single-Host rotation coordinator](FEISHU_OAUTH_ROTATION_COORDINATOR.md).
The authorization-code/PKCE exchange, verified initial persistence, and
exclusive Host lease now pass synthetic contracts. Remaining work includes
composing refresh under that lease, tenant-token acquisition, operation
composition, and live-account acceptance.
