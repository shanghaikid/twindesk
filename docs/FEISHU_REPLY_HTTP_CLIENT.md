# Feishu Reply HTTP Client

## Scope

`FeishuReplyHttpClient` is the production HTTP primitive for one approved
plain-text reply. It sends only:

```text
POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply
```

The request body fixes `msg_type` to `text`, encodes the approved text in the
nested `content` JSON string, and passes the existing 46-character `tdfr1:`
idempotency key as Feishu's `uuid`. This matches the
[official reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
and the [Lark CLI reply reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md),
which document a 50-character maximum and duplicate suppression for the same
key within one hour.

This class is intentionally not a `FeishuReplyExecutionClient`. It receives an
already resolved access-token buffer and has no account, Persona, approval,
scope, Keychain, lease, dispatch, receipt, or Audit authority. The future Host
adapter must compose those boundaries around it and translate its minimized
result into the exact execution response.

## Fixed Request Boundary

Before Fetch, the client requires:

- one bounded URL-safe source message ID;
- the same non-empty plain-text and UTF-8 limits as reply proposal creation;
- an exact `tdfr1:` key with 40 lowercase hexadecimal characters;
- caller-owned, non-shared, printable header-safe access-token bytes; and
- a real caller `AbortSignal`.

Fetch uses `POST`, JSON acceptance and content type, one Bearer token, no
ambient credentials, no cache, no referrer, redirect rejection, a 30-second
default timeout, and a two-minute configuration ceiling. The target remains a
path parameter on the fixed Feishu origin; callers cannot supply a host, path,
query, method, or message type.

## Minimized Success Result

A successful response must be bounded JSON with unique object keys, fatal
UTF-8 decoding, application code `0`, and valid `message_id` and millisecond
epoch `create_time` fields. The client returns only:

```text
kind, schemaVersion, messageId, sentAt
```

It discards chat identity, sender details, echoed message content, mentions,
and every other upstream response field. The future execution adapter must add
the already validated account, sending identity, target, and idempotency key
from its local request; it must not trust those values from remote payloads.

## Failure and Uncertain Results

Known HTTP or application authorization failures map to `not_authorized`,
known missing-permission codes map to `scope_missing`, rate limiting maps to
`rate_limited`, and an explicit invalid-message request maps to `rejected`.
These fixed codes contain no upstream message or cause.

Any network failure, timeout, redirect, service response, unknown application
code, oversized response, invalid media type, malformed JSON, duplicate key,
invalid UTF-8, or malformed success is ambiguous after a `POST` may have
started. It therefore maps to `network` or `unknown`, both of which the existing
executor records as `uncertain` with `reconcile_first`. A caller cancellation
propagates; the already durable dispatch reservation prevents a restart from
blindly sending again.

## Why This Client Does Not Reconcile

Feishu's `uuid` is a request-side, one-hour duplicate-suppression key. The reply
success response does not return it, and the
[message history API](https://open.feishu.cn/document/server-docs/im-v1/message/list)
does not expose it. Content matching is not proof because two legitimate
replies may have identical text. Consequently:

- absence of a local receipt does not prove remote absence;
- a timeout or malformed success cannot be converted to a safe retry;
- scanning message history cannot satisfy the executor's exact reconciliation
  contract; and
- an unsettled dispatch remains blocked until an operator or a future exact
  platform mechanism resolves it.

This limitation is conservative by design. The HTTP primitive does not invent
an `absent` reconciliation result merely to make the execution interface fit.

## Secret and Content Lifetime

The caller retains ownership of the access-token buffer and must clear it at
the credential callback boundary. The client clears its encoded request body,
assembled response bytes, and every streamed response chunk. It never logs or
persists the token, approved content, raw request, raw response, or upstream
error. JavaScript Bearer headers, JSON strings, and parsed strings are immutable
temporary values and cannot be retroactively erased, so production Fetch and
runtime composition must not enable credential or body logging.

## Verification and Remaining Work

Synthetic tests cover the exact URL, headers, nested escaped JSON, key reuse,
minimized success result, request/response cleanup, authorization, scope,
rate-limit and explicit rejection mapping, network and timeout ambiguity,
caller cancellation, redirects, invalid media and UTF-8, duplicate JSON keys,
declared and streamed overflow, hostile values, and payload-free errors. They
make no live request and use no real credential.

`FeishuReplyExecutionAdapter` now composes this primitive with an already-held
Host lease, exact Keychain resolution, fresh Bot/User scope authorization, and
callback-scoped User or tenant tokens. Remaining TD-209 work is to compose that
client with the separately completed Connector-neutral Host operation and User
rotation under the actual Feishu lease, then add product approval UI and a live
authorized account. The repository must not claim that the isolated or
synthetically composed HTTP contract proves a real Feishu send.
