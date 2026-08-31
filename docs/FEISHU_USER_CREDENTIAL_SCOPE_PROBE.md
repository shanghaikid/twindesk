# Feishu User Credential Scope Probe

## Scope

TD-209 adds `FeishuUserCredentialScopeProbe`, the concrete User implementation
of the operation-scope probe contract. It composes the exact configured OAuth
SecretReference, the macOS Keychain resolver, and the version 1 credential
bundle parser. It returns only authorization and scope metadata and never
exposes token or client-secret bytes outside their existing callbacks.

The successful ordering is:

```text
validate exact User operation request and fixed scope policy
  -> sample one trusted local time
  -> resolve the exact connector_oauth Keychain reference
  -> parse and bind the bundle to the configured app and User principal
  -> require a currently usable access token
  -> return the token's issued scope list and the local read timestamp
  -> clear parsed secrets and the source Keychain buffer
```

Only `user_reply` and `user_message_discovery` requests are accepted. Bot
operations, caller-substituted required scopes, another identity, another
SecretReference, unknown fields, and hostile accessors fail before Keychain
access.

## Meaning of the Observation

The scope list is Feishu's actual scope list stored with the current OAuth
token set, not configuration requested by TwinDesk and not a Persona-provided
list. `observedAt` records when TwinDesk read and parsed that current credential.
It does not claim that a separate live Feishu permission-introspection request
ran at that time.

Authorization or application permissions can still be revoked after token
issuance or between the probe and the operation. The concrete HTTP client must
therefore continue to treat Feishu authorization and missing-scope responses as
authoritative failures. The scope authorizer's short freshness window only
prevents reuse of old local evidence; it cannot eliminate that remote race.

## Refresh and Recovery

- a usable access token returns its frozen issued scope list;
- an expired access token with an unexpired refresh token returns
  `refresh_required`, which the authorizer maps to `refresh_credential` and
  never to an operation callback;
- an expired refresh token or missing User Keychain item requires
  reauthorization;
- identity mismatch, malformed bundles, invalid clocks, unsupported local
  composition, and empty or oversized Keychain values fail as invalid adapter
  state;
- transient Keychain unavailability remains retryable;
- cancellation propagates and both source and derived secret buffers are
  cleared.

The probe performs no refresh itself. Production runtime composition must hold
the exclusive Host lease, run the durable rotation coordinator when refresh is
required, and then make a new scope authorization attempt. It must never reuse
the old scope evidence across rotation.

## Privacy, Authority, and Remaining Work

The internal probe response includes the configured application and principal
only so the authorizer can reject identity substitution. The authorization
evidence passed to an operation contains account, identity type, operation,
scope names, and observation time. It contains no principal, SecretReference,
client secret, access token, refresh token, Keychain output, message content,
cursor, or raw error.

This read-only probe grants no approval or write authority and does not broaden
User visibility. Synthetic tests cover Keychain-to-authorizer success, distinct
reply and discovery policies, missing scopes, access-token refresh, expired
authorization, missing Keychain items, identity and bundle failures, hostile
requests, invalid clocks, cancellation, payload absence, and source-buffer
zeroing without touching a live Keychain item.

The separate [Bot Keychain scope probe](FEISHU_BOT_KEYCHAIN_SCOPE_PROBE.md) now
composes bounded token acquisition with remote Bot-principal and tenant-scope
observation. The lease-held reply adapter now uses both probes and rechecks the
actual User send bundle before fixed-endpoint HTTP. Remaining work includes
binding the separate Host execution operation and User rotation under the
actual Feishu lease, a production discovery client, selected context endpoint
policies, and live-account acceptance.
