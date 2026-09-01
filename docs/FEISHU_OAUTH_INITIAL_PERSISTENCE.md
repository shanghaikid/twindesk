# Feishu OAuth Verified Initial Persistence

## Scope

TD-209 adds `FeishuOAuthInitialCredentialPersister`, the fail-closed composition
between a freshly exchanged User token set and its first system Keychain
credential. It accepts no authorization by itself and performs no Connector
operation. Its only successful ordering is:

```text
validated configured User and transient token set
  -> GET fixed Feishu user-info endpoint
  -> exact application-scoped open_id match
  -> encode version 1 User OAuth bundle
  -> replace the configured connector_oauth Keychain item
```

The authorization-code/PKCE flow, principal verifier, bundle encoder, and
Keychain replacer remain separately testable boundaries. This persister composes
them without letting Persona, UI state, or returned profile data select the
identity or credential target.

## Identity and Persistence Rules

The persisted `appId`, `principalId`, and `SecretReference` come only from the
validated Feishu identity configuration. The principal verifier receives a
dedicated access-token copy and permits continuation only when Feishu returns
the exact configured User `open_id`. A different User, malformed response, or
unavailable verification writes nothing.

After verification, the encoder creates the exact version 1 bundle from the
configured application and User, the caller-supplied confidential-client
secret, and Feishu's actual token scopes and lifetimes. `offline_access` remains
required. The Keychain replacer receives only the configured User
`connector_oauth` reference and the callback-scoped encoded bytes.

The persister copies and validates the client-secret bytes and the entire token
set before any remote verification, rejects shared memory, and clears its copies
on every exit. The verifier and encoder use that same owned token snapshot, so
the caller cannot substitute different token bytes or metadata while the remote
identity check is pending. The verifier clears its access-token copy; the
authorization flow clears the source token pair; and the encoder plus replacer
clear the encoded bundle. JSON encoding necessarily creates temporary immutable
secret strings that are never logged, returned, added to Audit or Session data,
or sent to model context.

## Failure and Cancellation Semantics

Errors are payload-free and provide an explicit recovery:

| Failure | Recovery |
|---|---|
| Invalid configuration, token shape, client secret, or adapter | `do_not_retry` until corrected |
| Different authorized `open_id`, expired authorization, or transient verification failure after the code was consumed | `reauthorize` |
| Keychain replacement reports an uncertain post-start outcome | `reconcile_keychain` before any new authorization or write |
| Keychain validation or platform failure before a write | `do_not_retry` until corrected |

A successful replacer result is authoritative even if cancellation arrives
during that callback. Conversely, the production Keychain replacer classifies
any cancellation or failure after its command starts as uncertain. This avoids
turning a potentially completed credential write into an apparently safe retry.

## Verification and Remaining Work

Synthetic tests compose the authorization-code exchange through `open_id`
verification and Keychain replacement, then use fresh resolver and parser
instances to prove restart readability. They also cover identity mismatch,
invalid and hostile inputs, shared-memory rejection, uncertain writes,
completed-write cancellation, payload-free errors, and transient-buffer
zeroing. No live Feishu request or live Keychain item is used.

The Workbench initial-authorization host now composes literal-loopback capture,
this persister, and the exclusive Host lease with two fail-closed Keychain
absence checks plus a final ownership guard immediately before Keychain
replacement. Explicit blocked-state replacement also passes synthetic contracts.
Remaining work includes browser/UI lifecycle, Settings editing/default paths, Cordis
lifecycle activation, and live-account acceptance. See
[Workbench Feishu OAuth Authorization Runtime](WORKBENCH_FEISHU_OAUTH_AUTHORIZATION_RUNTIME.md)
and
[Feishu OAuth Reauthorization Replacement](FEISHU_OAUTH_REAUTHORIZATION.md).
