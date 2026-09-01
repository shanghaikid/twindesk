# Workbench Feishu OAuth Reauthorization Runtime

## Status

TwinDesk has two Workbench composition boundaries for replacing a User OAuth
credential after the durable rotation journal enters
`reauthorization_required`. The original boundary accepts already-exchanged
evidence. The hosted boundary owns the authorization callback and exchange
under the same lease, and the product now exposes that boundary through a
separate recovery-gated controller and local API. This remains synthetic
runtime evidence, not a live-account guarantee.

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

## Hosted authorization boundary

`createWorkbenchFeishuOAuthHostedReauthorizationHost()` accepts the exact
identity and registered authorization configuration, concrete authorization
flow and verified persister, a concrete rotation journal, a literal loopback
callback Host, and the Feishu lease manager. The journal is caller-supplied;
the Workbench composition root remains responsible for selecting its default
path. The runtime constructs the
coordinator from the same persister and journal, preventing preflight and
replacement from accidentally using different recovery files.

One `reauthorize()` call holds the lease across this complete ordering:

```text
inspect exact reauthorization_required journal state
  -> bind the exact registered loopback listener
  -> start one state-bound S256 PKCE transaction
  -> present only authorizationUrl and redirectUri
  -> capture one matching callback
  -> recheck the blocked journal while the lease is held
  -> exchange the single-use code
  -> fsync reauthorization_reserved
  -> verify the configured application-scoped User principal
  -> replace the exact Keychain item
  -> fsync reauthorized journal evidence
  -> close the listener and release the lease
```

No browser or token exchange occurs when the journal is not blocked. A
`reserved` or `uncertain` state routes to rotation reconciliation instead of
being overwritten by reauthorization. Callback/configuration mismatch closes
the listener without exchange or persistence.

`loadWorkbenchFeishuOAuthHostedReauthorizationHost()` reads fresh identity and
authorization Settings and binds the registered literal-loopback callback.
`loadDefaultWorkbenchFeishuOAuthHostedReauthorizationHost()` additionally
constructs the production bounded token transport, minimized User-info client,
principal verifier, and system-Keychain replacer around the supplied concrete
journal. Construction performs no
network or Keychain access; those effects remain inside an explicit
`reauthorize()` call.

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

Synthetic tests compose the real authorization flow, callback Host,
reauthorization coordinator, principal
verifier, Keychain replacement primitive, rotation journal, and an observable
injected lease manager. They prove that ownership stays held from blocked-state
inspection through callback, exchange, verification, replacement, and journal
settlement; non-pending state opens no listener or exchange; restart-loaded
Settings reconstruct the exact Host; transient buffers are cleared; post-start
cancellation retains uncertain Keychain recovery; and hostile or User-less
composition fails without invoking accessors. The separate runtime-lease suite
proves the production manager's real cross-process exclusion and crash release.

Still open:

- product actions for the two reconciliation-required outcomes;
- live Keychain and Feishu acceptance; and
- model-backed Draft editing and exact approval UI.

The product entry is specified in
[Workbench Feishu OAuth Reauthorization UI](WORKBENCH_FEISHU_OAUTH_REAUTHORIZATION_UI.md).

The default secret-free journal path and construction are recorded in
[ADR 0004](decisions/0004-feishu-oauth-recovery-journal-path.md) and
[Workbench Local Data Paths](WORKBENCH_LOCAL_DATA_PATHS.md).
