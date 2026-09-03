# Stage 2 Live-Readiness Check

## Purpose

`pnpm stage2:readiness -- --url http://127.0.0.1:4173` checks whether a running
TwinDesk Workbench is locally prepared for the explicit Stage 2 live-account
steps. It is a preflight only and never marks TD-209 complete.

The command accepts only an explicit loopback HTTP origin with a port. It reads
the existing minimized Settings, OAuth recovery, Connector diagnostics, and
model-Draft capability APIs. It also submits one correctly framed callback with
an intentionally invalid signature. An HTTP 401 proves that the configured Bot
callback reached its Keychain-backed signature boundary; the invalid request is
rejected before event parsing, business persistence, or Agent routing.

The checker never receives credential bytes, starts OAuth, creates a Draft,
approves an action, executes a Connector write, or accepts a non-loopback URL.
The Host may perform its existing read-only Keychain and remote scope probes
while serving Connector diagnostics. Responses are bounded to 64 KiB and parsed
through the same strict Web contracts used by the browser. Network and parsing
failures become fixed local attention states without including response bodies
or thrown messages.

## Report

The version 1 JSON report contains five identifier-free checks:

- both Bot and User Settings are complete;
- no OAuth rotation or reauthorization transaction is unresolved;
- diagnostics report both identities ready, polling running, and the User
  cursor current;
- the Harness model-Draft route is configured; and
- the Bot callback and its Keychain subscription bundle are reachable.

`ready_for_live_steps` means only that these local prerequisites passed. Every
report retains four explicit limitations: public Bot delivery, provider
credentials, live User polling, and an external send remain unverified. Exit
code `0` means locally ready, `2` means attention is required, and `1` means the
command itself was invalid or could not run.

## Remaining Acceptance

The user must still configure a TLS ingress that forwards only
`POST /api/connectors/feishu/bot/events`, register the Feishu event
subscription, verify a real Bot delivery, observe live User polling, run a
credential-healthy model Draft, and explicitly approve one real reply. Those
steps can incur external effects and are never initiated by this checker.
