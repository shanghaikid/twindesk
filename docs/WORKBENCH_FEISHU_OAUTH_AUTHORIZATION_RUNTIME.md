# Workbench Feishu OAuth Authorization Runtime

## Scope

`createWorkbenchFeishuOAuthAuthorizationHost()` composes one explicit initial
Feishu User authorization under the same exclusive Host lease used by polling,
rotation, reauthorization, and replies. It connects the literal-loopback
listener, authorization-code/S256 PKCE flow, exact User principal verification,
and initial system Keychain persistence. Its versioned authorization
configuration must bind the same application as the identity configuration and
the listener must bind its exact registered redirect URI.

This is a Host composition boundary, not a product UI. A caller-supplied
presenter receives a frozen authorization URL and redirect URI only. It may
display a link or open a browser, but receives no secret, token, configured
principal, Keychain target, lease, or persistence capability. TwinDesk does not
open the browser automatically in this slice.

## Ordering and Ownership

The only successful ordering is:

```text
validate fixed configuration and collaborators
  -> acquire exclusive Feishu Host lease
  -> bind the configured literal-loopback listener
  -> prove the actual listener URI equals the registered redirect
  -> prove the configured User Keychain item is absent
  -> create and arm one state-bound PKCE transaction
  -> invoke the presentation-only callback
  -> capture one exact callback
  -> prove the Keychain item is still absent
  -> exchange the single-use code
  -> verify exact application-scoped open_id
  -> persist the initial credential bundle
  -> close the listener and release the lease
```

The lease is checked before listener creation, after callback capture, before
verified persistence, and again inside the persister immediately before the
Keychain replacement call. It remains held while the user is at Feishu, so
another TwinDesk Feishu runtime cannot poll, rotate, reauthorize, or write
concurrently. Losing ownership during remote principal verification writes
nothing.

An app or redirect mismatch closes the listener and fails before presenting an
authorization URL. The Keychain absence check runs both before presenting
authorization and before consuming the code. An existing item fails with
`credential_exists` and directs the caller to the separate reauthorization
path. This prevents an ordinary initial-authorization request from silently
replacing a known credential. The Host lease excludes other TwinDesk processes;
it cannot lock unrelated tools that directly mutate the system Keychain.

## Cancellation, Recovery, and Privacy

The callback listener controls the five-minute maximum wait. A stalled
presenter cannot extend it; presenter failure, callback timeout, denial,
cancellation, exchange failure, verification failure, or persistence failure
closes the listener and releases the lease. A callback is consumed according to
the authorization flow's existing single-use and uncertain-exchange rules.
Uncertain Keychain writes retain the persister's `reconcile_keychain` recovery
and must not start a blind authorization retry.

The runtime owns and clears its client-secret copy. Existing Keychain bytes,
the exchange form and response, User-info token copy, exchanged token pair, and
encoded bundle remain callback-scoped and are cleared by their existing
boundaries. The authorization URL necessarily contains the public app ID,
requested scopes, state, and PKCE challenge and is exposed only to the explicit
presenter. It is not logged, persisted, audited, or sent to model context by
this runtime.

## Verification and Remaining Work

Synthetic tests use a real ephemeral loopback port and compose callback capture,
one token exchange, exact principal verification, and one Keychain replacement.
They prove two absence checks, lease ownership across every stage and at the
final write boundary, zero writes after ownership loss, transient buffer
cleanup, refusal to overwrite an existing credential, presenter failure
cleanup, and cancellation despite a stalled presenter. No live Feishu account,
network endpoint, browser, or Keychain item is used.

Still open:

- recovery UI plus browser launching;
- Settings persistence and editing for the versioned authorization configuration;
- Cordis lifecycle activation and hosted polling coexistence;
- live-account authorization and Keychain acceptance.
