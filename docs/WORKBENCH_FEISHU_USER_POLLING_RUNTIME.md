# Workbench Feishu User Polling Runtime

The Workbench polling runtime composes the existing User-message discoverer,
message normalizer, TwinDesk SQLite transaction, and exclusive Feishu Host
lease into one supervised read-only lifecycle. It remains an injected-client
contract: this increment does not claim that a live OAuth credential or Feishu
HTTP endpoint has been accepted.

## Lifecycle and Commit Order

`WorkbenchFeishuUserPollingRuntime.run(signal)` holds one
`FeishuRuntimeLeaseManager` lease for its complete lifetime. The caller owns and
supervises the returned promise and cancels shutdown through the supplied
`AbortSignal`. A second concurrent run on the same instance fails closed.

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

The concrete Feishu User search HTTP adapter, Keychain/OAuth rotation and scope
composition for that adapter, Cordis activation, production diagnostics, and
live-account acceptance remain open. Cordis activation must promote polling,
OAuth maintenance, diagnostics, and replies beneath one top-level lease owner;
it must not run this long-lived owner beside the current independently leasing
operation compositions, which would correctly exclude each other. Those
components must preserve this runtime's cancellation, partial-result, and
atomic-commit boundaries while sharing the one held lease.

## Verification

`tests/workbench-feishu-user-polling-runtime.test.mjs` covers durable page
restart, exact page-token resumption, event/projection/cursor commit, lease
checks, cancellation, rate-limit backoff, repeated missing-detail backoff,
terminal authorization failure, and interrupted commit without durable state.
All identities and messages are synthetic.
