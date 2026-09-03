# Workbench Feishu User Polling Runtime

The Workbench polling runtime composes the existing User-message discoverer,
message normalizer, TwinDesk SQLite transaction, and exclusive Feishu Host
lease into one supervised read-only lifecycle. Tests and embedders may still
provide an injected search client. The production Workbench constructor instead
creates the concrete OAuth rotation, Keychain resolution, fixed scope
authorization, and bounded Feishu HTTP adapter only after the runtime has
acquired that same lease. No live account has been accepted.

## Lifecycle and Commit Order

`WorkbenchFeishuUserPollingRuntime.run(signal)` holds one
`FeishuRuntimeLeaseManager` lease for its complete lifetime. The caller owns and
supervises the returned promise and cancels shutdown through the supplied
`AbortSignal`. A second concurrent run on the same instance fails closed.
`createWorkbenchFeishuUserPollingRuntime()` is side-effect-free at construction;
its lease-aware adapter factory runs exactly once per supervised run, after an
initial lease assertion and before any credential or network operation.
Supplying both an injected client and a factory, neither one, or a
malformed/accessor-backed client fails closed.

Each polling iteration performs the following order:

1. restore the durable `user_visible_messages` cursor;
2. assert the Host lease immediately before discovery;
3. discover at most one bounded page under the exact User identity;
4. normalize the page into versioned ExternalEvents and Inbox projections;
5. reassert the lease and atomically commit events, projections, and the
   candidate cursor;
6. continue an active page sequence immediately, or wait before a new window.

The next request always reloads the cursor from SQLite. A process termination
after a commit therefore resumes the next page or window, while a failed commit
cannot advance beyond missing event or Inbox state. Replayed pages converge
through the existing event and projection idempotency contracts.

## Retry and Failure Semantics

Retryable discovery failures use an exponential delay capped by Host
configuration. A page with unavailable message details commits its available
events without a cursor, then uses the same bounded delay before replay; repeated
partial pages cannot create a tight loop. A successfully committed candidate
resets the delay. Completed windows wait for the ordinary polling interval.

Authorization, missing-scope, malformed-response, identity, normalization,
storage, and lease failures stop the supervised run. They are not converted to
an empty successful batch. Cancellation is checked around the external read and
before the synchronous durable commit.

## Authority, Privacy, and Remaining Work

The runtime performs no Feishu write and grants no Persona, Skill, Tool, or
approval authority. Its constructor accepts the tenant identity only from Host
composition, never from a browser request. It exposes no message, principal,
credential, opaque cursor, or page-token status surface.

Cordis now activates this runtime only beneath the shared top-level owner
documented in
[Workbench Cordis Feishu Polling Runtime](WORKBENCH_CORDIS_FEISHU_POLLING_RUNTIME.md).
Automatic restart after Settings or credential changes, production diagnostics,
and live-account acceptance remain open. Those components must preserve this
runtime's cancellation, partial-result, and atomic-commit boundaries.

## Verification

`tests/workbench-feishu-user-polling-runtime.test.mjs` covers durable page
restart, exact page-token resumption, event/projection/cursor commit, lease
checks, cancellation, rate-limit backoff, repeated missing-detail backoff,
terminal authorization failure, and interrupted commit without durable state.
All identities and messages are synthetic.
`tests/feishu-user-message-search-adapter.test.mjs` separately proves the
rotation, scope, Keychain, lease, HTTP, and secret-lifetime composition without
making a live request. The polling tests also prove the production constructor is
lazy, creates the adapter within one held lease, performs all injected Keychain
and HTTP work under that lease, and rejects hostile factory results without
invoking accessors.
