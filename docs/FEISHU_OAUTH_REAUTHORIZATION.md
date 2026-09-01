# Feishu OAuth Reauthorization Replacement

## Scope

TD-209 adds `FeishuOAuthReauthorizationCoordinator`, the fail-closed bridge
from a durable `reauthorization_required` rotation state to a newly verified
User credential. It does not open a browser, accept an OAuth callback, grant
scopes, or authorize a Connector operation. It composes the already isolated
authorization exchange result, exact `open_id` verification, initial bundle
encoder, Keychain replacement, and rotation journal.

The only successful ordering is:

```text
load exact reauthorization_required journal state
  -> serialize this replacement against same-Host journal work
  -> fsync reauthorization_reserved before replacement work
  -> require a strictly newer token set
  -> verify exact configured application-scoped open_id
  -> replace the exact connector_oauth Keychain item
  -> fsync an explicit reauthorized journal event
```

The initial credential persister now exposes `persistWithResult()` for this
composition while retaining the existing `persist(): Promise<void>` API. The
result contains only `status` and the canonical non-secret `obtainedAt`; it is
derived from the owned immutable token snapshot that was both principal-checked
and encoded, not from caller-mutable input.

## Journal Version and Recovery

Rotation journal schema version 2 added the terminal `reauthorized` state.
Version 3 adds `reauthorization_reserved`, a durable-before-Keychain transition.
The journal continues to read valid version 1 and 2 events and appends version 3
events to legacy logs without deleting local state. Version 1 cannot claim
`reauthorized`, and only version 3 may claim `reauthorization_reserved`.
Downgrading after a newer event is written fails closed rather than ignoring the
transition.

`reauthorized` is intentionally distinct from `completed`:

- `completed` proves a reserved refresh produced a newer credential;
- `reauthorized` proves explicit User authorization replaced a credential after
  an invalid, expired, revoked, or consumed refresh token;
- either terminal state may become the source of a later normal refresh;
- `uncertain` can recover only to `completed`;
- `reauthorization_required` first transitions to
  `reauthorization_reserved`; and
- `reauthorization_reserved` can settle as `reauthorized`, or return to
  `reauthorization_required` only when the coordinator proves no Keychain write
  began.

The reservation is fsynced before principal verification and Keychain access.
Known validation, principal-verification, or pre-write cancellation failure
restores `reauthorization_required`. If Keychain replacement is uncertain, the
journal remains `reauthorization_reserved` and recovery is
`reconcile_keychain`. If replacement succeeded but terminal journal settlement
is uncertain, recovery is `reconcile_rotation`. After restart, a fresh rotation
coordinator can read the exact configured Keychain bundle and append
`reauthorized` only when it proves a strictly newer credential, without
repeating authorization, refresh, or Keychain write. Same or older timestamps
never unblock the journal.

The journal serializes the complete replacement callback. A second same-Host
attempt waits and then fails with `reauthorization_not_pending` after the first
one commits, so it cannot run a second principal check or Keychain write.
Cross-process exclusion remains the responsibility of the Feishu Host lease.

## Privacy and Authority

The version 3 journal remains secret-free. It stores only sequence, state, and
canonical source, result, and record timestamps. It contains no account,
application, principal, SecretReference, scope, token, client secret, OAuth
response, profile, or error payload.

Reauthorization restores a usable credential; it does not approve any message,
grant missing scopes, select a Persona, or bypass the normal identity, policy,
approval, dispatch reservation, idempotency, or Audit boundaries. A child Agent
cannot invoke this path to broaden authority.

## Verification and Remaining Work

Synthetic tests cover verified replacement and fresh-instance restart,
legacy-version journal migration, identity mismatch, stale replacement
chronology, same-Host concurrency, uncertain Keychain replacement, ambiguous
post-write journal completion, non-pending rejection, hostile accessors, and
payload-free errors. They use no live Feishu account or Keychain item.

The exclusive Host runtime, loopback callback, and product reauthorization
entry are now composed. Remaining work includes an explicit product
reconciliation action and Audit, hosted polling, and live-account acceptance.
