# Feishu Operation Scope Authorization

## Scope

TD-209 adds `FeishuOperationScopeAuthorizer`, a versioned fail-closed gate that
rechecks one fixed operation policy immediately before an injected operation
callback may run. It does not resolve a credential itself, obtain a Bot tenant
token, call a message API, approve a write, or infer authority from Persona,
Skill, Tool, diagnostics, or a previously healthy request.

The only successful ordering is:

```text
select a product-owned operation policy
  -> bind its exact configured Bot or User identity
  -> validate the trusted local clock
  -> ask the credential-resolving adapter for a fresh scope observation
  -> require exact identity and operation echo
  -> require current authorization and every fixed minimum scope
  -> invoke the callback with credential-free scope evidence
```

## Version 1 Policies

The first policy version covers only operations whose current TwinDesk adapter
contracts already select a concrete Feishu capability:

| Operation | Identity | Required scopes |
| --- | --- | --- |
| `bot_reply` | Bot | `im:message:send_as_bot` |
| `user_reply` | User | `im:message:send_as_user` |
| `user_message_discovery` | User | `im:chat:read`, `im:message:readonly`, `search:message` |

These lists are code-owned, frozen, and not caller-configurable. An unknown
operation fails before the probe. Context-document and attachment policies are
intentionally absent until concrete HTTP endpoints and resource semantics are
selected; they cannot silently inherit the discovery scopes.

The concrete adapter must still validate the token type and endpoint-specific
permission contract when it is implemented. A future Feishu permission rename
or endpoint change requires an explicit policy and documentation update, not a
runtime alias or Persona override.

## Fresh Observation Boundary

The probe request includes the exact configured account, application,
principal, identity type, SecretReference, operation, and product-owned
required scopes. The response must be accessor-free data that echoes the
identity and operation and reports only:

- `authorized` or `not_authorized`;
- a dense, unique, bounded granted-scope list;
- a canonical observation timestamp.

An observation older than 60 seconds is stale. A timestamp more than five
minutes ahead of the trusted local clock is invalid as current evidence. The
clock is validated before the probe, cancellation is checked before and after
it, and a malformed or identity-mismatched response never reaches the callback.

The callback receives frozen, credential-free evidence. If a callback
successfully completes while cancellation arrives during it, that result stays
authoritative; the gate does not turn a potentially completed external write
into an apparent safe retry.

## Authority and Recovery

Passing this gate proves only that the selected identity had the required
scope evidence at the point of use. Feishu may still revoke authorization or
reject the subsequent request, so each HTTP adapter must retain its own
fail-closed error mapping.

The concrete User probe now reads the current Keychain OAuth bundle and uses
the token set's issued scopes. Its fresh timestamp describes that local read,
not a live remote permission introspection. See
[Feishu User Credential Scope Probe](FEISHU_USER_CREDENTIAL_SCOPE_PROBE.md).

- missing Bot configuration or Bot authorization requires configuration repair;
- missing or revoked User authorization requires reauthorization;
- a missing fixed scope requires an explicit application permission or User
  consent change;
- a refresh-required User credential must pass durable rotation before a new
  probe;
- a Bot probe cannot claim User OAuth refresh state; doing so is an invalid
  adapter response;
- stale, rate-limited, network, or unavailable observations may be reprobed;
- malformed adapter data or invalid policy input is not blindly retried.

For a reply, the gate does not replace proposal binding, one-time approval,
durable dispatch reservation, exact idempotency, reconciliation, receipt, or
Audit. For discovery, it does not expand the User's visibility or change the
explicit partial-coverage claim.

## Privacy and Remaining Work

The request may expose a SecretReference locator only to the installed Host
adapter that already owns credential resolution. Returned authorization
evidence contains account ID, identity type, operation, scope names, and time;
it contains no principal, SecretReference, token, client secret, message,
document, cursor, raw response, or error payload.

Synthetic tests cover all three fixed policies, Bot/User separation, missing
identity, authorization and scope, stale/future/mismatched evidence, probe
failures, cancellation, callback completion, immutable values, hostile
accessors, and payload-free errors. They use no live account or credential.

The concrete [Bot Keychain scope probe](FEISHU_BOT_KEYCHAIN_SCOPE_PROBE.md) now
composes bounded tenant-token acquisition, exact remote Bot-principal binding,
and tenant-only application-scope observation. The fixed reply HTTP primitive
also exists. Remaining work includes composing it and future discovery clients
under the exclusive Host lease, selecting separate context endpoint policies,
and live-account acceptance.
