# Feishu Bot Tenant Token Acquisition

## Scope

TD-209 adds `FeishuBotTenantTokenAcquirer`, a production Fetch boundary for the
official [internal tenant access-token endpoint](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal).
It accepts one application ID and one borrowed application-secret byte buffer,
sends the fixed JSON request, and exposes the returned tenant token only inside
a callback.

This boundary performs credential exchange only. A successful exchange proves
that Feishu accepted the application credentials at that moment. It does not
prove that a Bot operation scope is granted, does not grant TwinDesk approval,
and does not authorize an external write.

The intended production ordering remains:

```text
hold the exclusive Feishu Host lease
  -> resolve the exact connector_app_credential SecretReference from Keychain
  -> parse and bind the version 1 Bot credential bundle
  -> acquire one callback-scoped tenant token
  -> observe the fixed operation's current Bot scope state
  -> run the normal policy, approval, dispatch, and execution boundaries
```

Only the acquisition step is implemented here. Keychain/parser composition,
Bot scope observation, operation HTTP clients, and lease-wrapped runtime
composition remain open.

## Fixed HTTP Contract

The acquirer sends only:

```text
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
Accept: application/json
Content-Type: application/json; charset=utf-8

{"app_id":"...","app_secret":"..."}
```

It sets `credentials: omit`, `cache: no-store`, `redirect: error`, and
`referrerPolicy: no-referrer`. Callers cannot replace the method, URL, headers,
or response limit. The default HTTP timeout is 30 seconds, and configuration
cannot exceed two minutes.

The success response must have exactly `code`, `msg`, `tenant_access_token`,
and `expire`, with `code: 0`. The token must be bounded printable bytes and the
server lifetime must be positive and within TwinDesk's defensive 24-hour cap.
The trusted local clock is sampled only after the complete response arrives;
the callback receives frozen `obtainedAt` and `expiresAt` values.

This slice does not cache tokens. A future cache must remain identity-bound,
expire conservatively, never persist token bytes in TwinDesk SQLite or Harness
Session data, and stay under the exclusive Host lifecycle.

## Response and Failure Bounds

The response is limited to 16 KiB twice: a larger declared `Content-Length` is
rejected before reading, and streamed chunks are counted against the same cap.
Successful responses must be JSON with valid UTF-8, no duplicate object keys,
and the exact success shape.

Failure handling is intentionally fixed and payload-free:

- HTTP 429 and 5xx, Feishu's generic `99991400` rate-limit response, network
  failure, and timeout return `retry_later`;
- HTTP 400, 401, or 403 and known application-credential/status codes require
  `repair_configuration`;
- an unknown nonzero application code fails closed without assuming either a
  safe retry or a credential repair;
- redirects, unexpected HTTP states, invalid media types, malformed JSON,
  duplicate or unknown success fields, invalid tokens, invalid lifetimes, and
  hostile values fail without blind retry;
- caller cancellation propagates unchanged before the consumer begins;
- once the consumer reports success, its result is authoritative even if the
  caller aborts during that completed callback, avoiding an unsafe apparent
  failure and retry.

The application-code classifications follow the official
[Lark CLI generic error constants](https://github.com/larksuite/cli/blob/main/internal/output/lark_errors.go),
including the legacy internal tenant-token credential code and the generic
OpenAPI rate-limit code. Unlisted codes remain fail-closed.

No error contains the application ID, application secret, tenant token, raw
response, upstream message, URL supplied by an attacker, or thrown cause.

## Secret Lifetime and Privacy

The application-secret input is borrowed. The acquirer validates it without
mutating it, while the caller remains responsible for clearing the owning
buffer. The intended caller is the existing credential-bundle parser, whose
callback already clears the derived application-secret bytes and source
Keychain buffer.

The JSON request body, response buffer, received stream chunks, and returned
tenant-token buffer are overwritten on every exit. A consumer that copies,
decodes, transfers, logs, or persists those values creates another lifetime it
must control. JavaScript JSON parsing also creates temporary immutable strings
that cannot be retroactively erased. None of these values may enter logs,
errors, telemetry, exports, model context, diagnostics, Audit, SQLite, Harness
Session data, fixtures, or snapshots.

The injected Fetch implementation used by tests can retain the request body;
production composition must use the platform Fetch implementation and must not
wrap it with request logging or body capture.

## Verification and Remaining Work

Synthetic tests cover the exact fixed URL and Fetch options, JSON escaping,
trusted-clock lifetime calculation, callback-scoped token cleanup, borrowed
secret ownership, declared and streamed response limits, stream cancellation
and chunk clearing, malformed and duplicate data, credential rejection,
rate/service/network/timeout failures, caller cancellation, hostile request
objects, invalid clients, consumer failure, and payload-free errors. They make
no real Feishu request and use no live credential.

The next TD-209 slice must compose the exact Bot SecretReference, Keychain
resolver, credential parser, and this acquirer into a Bot scope probe. That
probe must still obtain separate current scope evidence and must never treat a
tenant token as scope or write authority.
