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
| Send is idempotent across restart | Local contract passed | Durable terminal receipt, one external effect, execution refusal, and send-only dispatch blocking without invented reconciliation |
| Reply request key fits Feishu's 50-character limit | Contract passed | New proposals use a 46-character identity-bound key and the lease-held Bot/User reply adapter preserves it through the fixed HTTP primitive |
| Complete local business trace exists | Passed | Six attributable, reference-validated Audit records |
| Real Bot callback/subscription reaches the runtime | Not proven | No hosted callback or long-connection composition |
| Exclusive Feishu Host ownership | Contract passed | A kernel-backed loopback lease excludes real competing processes, releases after `SIGKILL`, and now owns durable User rotation, one full synthetic Workbench reply operation, and the production-shaped polling composition, including lazy construction of its search adapter under the same lease |
| Real User polling/context uses OAuth from Keychain | Not proven | Code/PKCE exchange, default-path restart-loaded app-bound registered-loopback configuration and capture through lease-held verified initial persistence, blocked-state replacement, durable reply-path rotation, exact User scope probing, and a restart-safe atomic polling scheduler pass synthetically. Cordis now binds that scheduler and the hosted OAuth/reply operations to one top-level owner; it reloads every durable page cursor, applies bounded retry, and stops on authorization or storage failure. Live authorization and reauthorization acceptance, existing-identity replacement, credential repair/removal, automatic restart after repair, and live polling remain open. |
| SecretReference resolves and parses from macOS Keychain | Contract passed | Fixed read-only lookup plus identity-bound Bot/User parsing and zeroed source/derived bytes are tested with injected adapters; no live item is read |
| Real Feishu reply succeeds | Not proven | The Workbench composition root binds the held lease, Host approval/dispatch/receipt/Audit operation, durable User rotation, and production Bot/User adapter; its complete test injects Keychain and Fetch and uses no live account |
| User edits and approves in the product UI | Editing, exact preview, one-time approval, and execution intent implemented synthetically | The Inbox creates sequential local Draft revisions, marks one `ready_for_review`, persists the exact User-identity reply preview, opens a fixed 15-minute approval window, and records approval, rejection, cancellation, or expiration with restart-repairable Audit. Only an exact approved proposal exposes the separate send control; outcomes remain minimized and uncertain sends cannot be blindly retried. |
| Model-backed Draft and Harness trace are linked | Runtime, product-entry, and Cordis lifecycle contracts passed; live provider not accepted | A Persona-mapped pinned Harness Agent run requires Session flush, cold persisted-turn validation, and bounded visible output before Work Hub creates the local Draft and opaque WorkItem -> Session -> Run Audit chain. The product entry accepts only a Work Item ID while Host owns prompt, identities, and provider/model. The Workbench Cordis effect proves the route, starts product Web, and shuts it down normally; route inspection makes no model request and does not resolve a credential. Exact restart recovery makes zero model calls. The acceptance Draft remains deterministic with `modelInvocation: false`; credential health and authenticated remote generation are not proven. |

## Why the Stage Does Not Exit Yet

The product source of truth requires a **real Feishu message** to produce an
approved and sent reply with a complete trace. Passing injected-client tests is
necessary but not equivalent to that requirement. Declaring Stage 2 complete
would incorrectly imply live support for the synthetically tested product
authorization-code/PKCE and initial-persistence entry, credential rotation,
composed live Feishu API semantics, live callback or polling acceptance, and a real
external receipt. Read-only browser-refresh flow restoration is covered by
synthetic restart evidence.

TD-209 therefore remains open until the runtime hosts ingestion, polling,
blocked-state recovery, and reauthorization around the now-composed Work Hub
reply operation, proves the now-lifecycle-bound Harness model-Draft entry against
a credential-healthy production provider, restores the durable action flow
across browser refresh, and completes an authorized live-account acceptance
run. Stage 3 must not rely on a claimed
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
