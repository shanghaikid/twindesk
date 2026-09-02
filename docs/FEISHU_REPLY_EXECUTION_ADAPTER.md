# Feishu Reply Execution Adapter

## Scope

`FeishuReplyExecutionAdapter` is the send-only production composition between
the approved-reply executor and the existing Feishu credential, scope, and HTTP
primitives. It implements `FeishuReplyExecutionClient.send()` but intentionally
does not implement `reconcile()`, because Feishu message history does not expose
the reply request `uuid`.

The adapter must be constructed and used inside the complete callback of
`FeishuRuntimeLeaseManager.withLease()`. It accepts the callback's
`FeishuRuntimeLease`, checks `assertHeld()` before preflight and immediately
before HTTP dispatch, and fails closed if ownership is lost. It does not acquire
a short-lived second lease and does not extend ownership beyond the Host
lifecycle.

## Send Order

Every request follows this order:

```text
validate exact execution request and configured SecretReference
  -> assert the Host lease is held
  -> run the fixed Bot or User reply-scope policy
     -> User: read and identity-bind the OAuth bundle
     -> Bot: read the app credential, acquire a tenant token, and verify
             current Bot principal plus tenant-only application scope
  -> assert the Host lease is still held
  -> resolve the exact credential again for the actual send
     -> User: require a usable token that still contains send_as_user
     -> Bot: acquire a callback-scoped tenant token for the same app
  -> assert the Host lease immediately before dispatch
  -> call the fixed-endpoint bounded reply HTTP client
  -> return only the minimized message identity and timestamp
```

The second User credential read deliberately checks the actual send token after
the scope probe. If Keychain rotation replaces the bundle between those reads,
the replacement token must independently remain usable, identity-bound, and
contain `im:message:send_as_user`. A missing scope fails before HTTP.

The Bot probe obtains one tenant token to verify the current remote Bot
principal and tenant-only scopes. The send step obtains a new callback-scoped
token for the same identity. A permission change after the probe remains
authoritative at the reply endpoint and is surfaced as a scope failure.

## Retry Boundary

Failures proven to occur before reply HTTP are normalized as
`preflight_unavailable`. The executor persists them as `failed` with
`retry_same_key`, so a later attempt can obtain a new durable dispatch ordinal
without pretending that an external write may have happened. Examples include
a temporarily unavailable scope probe, a pending or pre-reservation-unavailable
rotation, or a lost Host lease before reply HTTP.

Missing authorization, missing scope, reauthorization-required rotation, and
uncertain rotation remain terminal until explicit recovery. Invalid composition
or malformed credentials fail closed. Once the reply HTTP primitive starts, its
existing result classes remain
authoritative: explicit rate limiting permits the same-key retry, while network,
service, unknown, or malformed success outcomes are uncertain and cannot
authorize a blind resend.

## Secret and Data Lifetime

- Only the configured `SecretReference` crosses the executor boundary.
- Keychain bundle bytes, parsed application secrets, OAuth tokens, tenant
  tokens, HTTP request bodies, and response chunks stay callback-scoped and are
  cleared by their owning primitives.
- Scope results contain only normalized identity, operation, scope, and
  observation metadata.
- The adapter returns only the fields required for an `ActionReceipt`; it does
  not return a credential, raw Feishu payload, profile field, or permission
  response.
- Errors use fixed messages and codes and do not retain thrown adapter data.

## Verification

Synthetic tests compose the real Keychain resolver/parser, User and Bot scope
probes, Bot tenant-token client, operation authorizer, reply HTTP client, and
execution adapter with injected command and Fetch boundaries. They cover both
identities, exact call ordering, lease checks, token cleanup, scope and refresh
failures, credential replacement between probe and send, invalid requests,
incomplete composition, and payload-free errors. No system Keychain item or
Feishu account is accessed.

## Remaining Work

This adapter is not the complete hosted runtime. The Connector-neutral
`WorkHubActionExecutionHost` now composes approval consumption,
`beginActionExecution()`, durable dispatch reservation, atomic receipt
settlement, and recoverable append-only Audit completion. The
[Workbench Feishu Reply Runtime](WORKBENCH_FEISHU_REPLY_RUNTIME.md) now binds its
callback and executor to this adapter and the actual Feishu lease in a
production-shaped composition API. Its User path now invokes the durable OAuth
rotation coordinator in the executor's pre-dispatch preparation phase under
that same Host lease before reply reservation and scope authorization.
Temporary preflight failures retain `retry_same_key`; reauthorization-required
or uncertain rotation results produce distinct terminal reply receipts and
never reach reply HTTP.
The Workbench Inbox now exposes the approved-action execution UI and restores
its durable presentation after refresh. Hosted ingestion or polling and
live-account acceptance remain open.
