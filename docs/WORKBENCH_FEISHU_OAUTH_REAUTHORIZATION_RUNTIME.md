# Workbench Feishu OAuth Reauthorization Runtime

## Status

TwinDesk now has a Workbench composition boundary for replacing a User OAuth
credential after the durable rotation journal enters
`reauthorization_required`. This is synthetic runtime evidence, not a hosted
authorization callback or live-account guarantee.

## Boundary

`createWorkbenchFeishuOAuthReauthorizationHost()` requires:

- one parsed Feishu identity configuration with an exact User identity;
- one concrete `FeishuOAuthReauthorizationCoordinator`; and
- the kernel-backed `FeishuRuntimeLeaseManager`, or its production default.

`replace()` accepts only already-exchanged token evidence and the application
secret needed by the existing verified-persistence boundary. It acquires the
same cross-process Feishu Host lease used by polling, rotation, and reply
execution, checks ownership immediately before replacement, and delegates to
the coordinator. The coordinator remains responsible for requiring an exact
blocked journal state, newer chronology, `open_id` verification, Keychain
replacement, and terminal journal settlement.

The host does not start an OAuth authorization transaction, listen for a
redirect, infer scopes, retry a code exchange, retry an approved reply, or grant
write authority. Reauthorization restores a credential only; any later reply
still requires a fresh applicable proposal and the normal exact approval path.

The coordinator takes owned snapshots and clears its internal application
secret and token copies. `replace()` does not mutate the caller-owned input
buffers; the authorization/exchange caller remains responsible for keeping
their lifetime callback-scoped and clearing them on every exit.

## Failure and Recovery

The boundary preserves the coordinator's payload-free recovery classes:

- `reauthorize` means the supplied replacement could not be verified and a new
  authorization transaction is required;
- `reconcile_keychain` means the Keychain write outcome is uncertain;
- `reconcile_rotation` means the credential is durable but the journal outcome
  is uncertain; and
- `do_not_retry` means invalid composition, non-pending replacement, or a local
  failure that cannot safely be replayed.

Lease contention remains `retry_after_owner_exit`. Caller cancellation before
lease acquisition never invokes replacement. Cancellation after the Keychain
command starts remains `reconcile_keychain`, because its write outcome cannot be
proven from the process result. Once the coordinator reports a durable
replacement, the host returns that authoritative result without adding a
post-completion cancellation check that could invite unsafe repetition.

## Verification and Remaining Work

Synthetic tests compose the real reauthorization coordinator, principal
verifier, Keychain replacement primitive, rotation journal, and an observable
injected lease manager. They prove that ownership stays held during verification
and Keychain replacement, releases afterward, internal secret buffers are
cleared, post-start cancellation retains uncertain Keychain recovery,
pre-acquisition cancellation reaches no coordinator, and hostile or User-less
composition fails without invoking accessors. The separate runtime-lease suite
proves the production manager's real cross-process exclusion and crash release.

Still open:

- hosted authorization-start and literal-loopback redirect lifecycle;
- UI state for reauthorization and the two reconciliation-required outcomes;
- production construction of the exchange, verifier, persister, journal, and
  recovery host from settings;
- live Keychain and Feishu acceptance; and
- model-backed Draft editing and exact approval UI.
