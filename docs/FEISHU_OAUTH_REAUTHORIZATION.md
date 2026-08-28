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

Rotation journal schema version 2 adds the terminal `reauthorized` state. The
journal continues to read valid version 1 events and may append one version 2
event to a legacy log, providing a forward migration without deleting local
state. Version 1 is not allowed to claim the new state. Downgrading after a
version 2 event is written is unsupported and fails closed rather than ignoring
the newer transition.

`reauthorized` is intentionally distinct from `completed`:

- `completed` proves a reserved refresh produced a newer credential;
- `reauthorized` proves explicit User authorization replaced a credential after
  an invalid, expired, revoked, or consumed refresh token;
- either terminal state may become the source of a later normal refresh;
- `uncertain` can recover only to `completed`, while
  `reauthorization_required` can transition only to `reauthorized`.

If Keychain replacement is uncertain, the journal remains
`reauthorization_required` and recovery is `reconcile_keychain`. If Keychain
replacement succeeded but the journal append is uncertain, recovery is
`reconcile_rotation`; a fresh rotation coordinator can read the strictly newer
Keychain bundle and append `reauthorized` without repeating authorization or
the Keychain write. Same or older credential timestamps never unblock the
journal.

The journal serializes the complete replacement callback. A second same-Host
attempt waits and then fails with `reauthorization_not_pending` after the first
one commits, so it cannot run a second principal check or Keychain write.
Cross-process exclusion remains the responsibility of the Feishu Host lease.

## Privacy and Authority

The version 2 journal remains secret-free. It stores only sequence, state, and
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

Remaining work includes composing authorization and replacement inside the
exclusive Host runtime lease, hosted loopback callback and browser lifecycle,
concrete scope probes and HTTP clients, product UI, and live-account
acceptance.
