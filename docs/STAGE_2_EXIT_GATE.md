# Stage 2 Exit Gate

## Decision

As of 2026-08-28, the **local Feishu contract acceptance path passes**, but the
**Stage 2 live-account exit gate is not yet passed**.

`tests/stage2-exit-gate.test.mjs` composes the implemented product boundaries
with synthetic Feishu data and injected clients. It proves that the local
domain and persistence path can safely complete without weakening approval,
identity, idempotency, or audit rules. It does not prove that a real Feishu
account can complete the product journey required by `PRODUCT_GOALS.md` and
`ROADMAP.md`.

## Local Contract Evidence

The acceptance test completes this deterministic sequence:

1. a message already accepted by the verified Bot-event boundary is normalized;
2. its immutable event and `needs_reply` Work Item are committed locally;
3. Bot and User diagnostics report explicit authorization, scopes, rate state,
   and a not-started User cursor without granting authority;
4. the User identity retrieves bounded, complete synthetic conversation context;
5. the Communication Persona is selected explicitly;
6. an initial `editing` Draft is superseded by a user-edited revision 2 in
   `ready_for_review`;
7. a plain-text Feishu reply proposal binds the final Draft, exact User identity,
   message target, content digest, and idempotency key;
8. one local user decision approves the exact proposal with an expiration;
9. approval consumption creates one execution attempt;
10. reconcile-before-send produces one normalized success receipt; and
11. ingestion, routing, context, Draft, approval, and execution records form a
    six-record local Audit trace.

The test deliberately restarts after the success receipt is durable but before
the Audit trace is appended. On restart, it verifies the durable Thread, Work
Item, both Draft revisions, proposal, approval, and receipt before appending the
missing deterministic acceptance trace. The terminal proposal refuses another
execution start, and the injected remote client still reports exactly one
external effect. A second Audit append is an exact duplicate. This proves that
the existing persistence boundaries support idempotent trace completion; it is
not an automatic production repair service. SQLite retains one source event,
Work Item, proposal, approval, receipt, and six Audit records plus both Draft
revisions.

The database scan verifies that configured SecretReference locators and Bot/User
principal IDs are absent. Draft and message content remain in their intended
local business records; credentials and raw connector responses do not.

## Gate Matrix

| Criterion | Result | Evidence |
|---|---|---|
| Feishu-shaped source reaches Inbox | Local contract passed | Normalization and atomic event/projection commit |
| Bounded context remains explicit | Local contract passed | User-bound complete context bundle |
| Persona does not grant authority | Passed | Explicit Persona selection plus separate approval |
| User-edited Draft binds the proposal | Passed | Superseded revision 1 and exact revision 2 proposal content |
| One-time approval is exact and expiring | Passed | Identity, target, and content digests plus responder and expiration |
| Send is idempotent across restart | Local contract passed | Durable terminal receipt, one external effect, and execution refusal |
| Reply request key fits Feishu's 50-character limit | Contract passed | New proposals use a 46-character identity-bound key; the production adapter is still missing |
| Complete local business trace exists | Passed | Six attributable, reference-validated Audit records |
| Real Bot callback/subscription reaches the runtime | Not proven | No hosted callback or long-connection composition |
| Exclusive Feishu Host ownership | Contract passed | A kernel-backed loopback lease excludes real competing processes and releases after `SIGKILL`; the production runtime does not hold it yet |
| Real User polling/context uses OAuth from Keychain | Not proven | Code/PKCE exchange, verified initial and blocked-state replacement, durable rotation, and exact User scope probing pass synthetically; no hosted redirect listener, live lease composition, HTTP adapter, or scheduler |
| SecretReference resolves and parses from macOS Keychain | Contract passed | Fixed read-only lookup plus identity-bound Bot/User parsing and zeroed source/derived bytes are tested with injected adapters; no live item is read |
| Real Feishu reply succeeds | Not proven | Durable dispatch, credential rotation, exclusive ownership, fixed reply-scope gates, User Keychain probing, and Bot Keychain/token/principal/scope probing are covered synthetically; no reply HTTP client, lease-wrapped adapter, or live account |
| User edits and approves in the product UI | Not implemented | Current Web shell remains read-only fixture UI |
| Model-backed Draft and Harness trace are linked | Not implemented | The acceptance Draft is deterministic and `modelInvocation: false` |

## Why the Stage Does Not Exit Yet

The product source of truth requires a **real Feishu message** to produce an
approved and sent reply with a complete trace. Passing injected-client tests is
necessary but not equivalent to that requirement. Declaring Stage 2 complete
would incorrectly imply live support for the synthetically composed
authorization-code/PKCE and initial-persistence path, production runtime
ownership under the exclusive lease, composed live Feishu API semantics,
callback or polling lifecycle, interactive approval, and a real external
receipt.

TD-209 therefore remains open until the production Feishu token lifecycle, HTTP,
production dispatch coordinator composition, hosted ingestion or polling
lifecycle, product Draft and approval UI, and an authorized live-account
acceptance run are implemented and verified. Stage 3 must not rely on a claimed
Stage 2 exit before those checks pass.

## Verification

Run the focused contract acceptance test with:

```sh
pnpm build
node --test tests/stage2-exit-gate.test.mjs
```

The normal repository gate remains:

```sh
pnpm check
```
