# Workbench Cordis Feishu Polling Runtime

## Scope

The Workbench Cordis plugin can now activate the production-shaped Feishu User
polling composition under one shared top-level Host lease. Polling remains
read-only: it discovers only messages visible to the configured User OAuth
identity, normalizes bounded pages, and atomically commits TwinDesk events,
Inbox projections, and candidate cursors.

This lifecycle grants no Persona, Tool, approval, or external-write authority.
Reply execution continues through its separate exact proposal, approval,
dispatch, receipt, and Audit path.

## Activation

`TWINDESK_FEISHU_TENANT_KEY` is optional Host launch configuration. When it is
absent, Cordis starts the existing product Web runtime without polling. When it
is present, it must be a bounded canonical tenant identifier and never comes
from a browser request.

Polling starts only when the restart-safe identity store already contains a
User identity at Cordis startup. An empty or Bot-only installation keeps the Web
setup flow available and leaves polling dormant. After creating the first User
identity, completing first authorization, or repairing a terminal credential
condition, restart Cordis to start a fresh supervised polling run. Automatic
configuration-change restart remains open.

## Shared Ownership and Shutdown

With an existing User identity, Cordis performs this order:

1. acquire the one kernel-backed Feishu runtime lease;
2. bind a shared manager view to the exact load-time identity configuration;
3. open a dedicated TwinDesk SQLite polling handle on the same configured
   business database;
4. construct and start the OAuth rotation, scope, Keychain, HTTP, normalization,
   and cursor polling stack through the shared manager;
5. start the product Web server and give authorization, reauthorization,
   reconciliation, and reply execution that same manager;
6. on unload, abort and await polling, close Web and active requests, close the
   polling database handle, then drain and release the owner.

The shared manager does not reacquire the kernel endpoint. It verifies every
borrower's normalized identity equals the owner's snapshot and reuses the same
lease assertions. It is not a substitute for operation-level policy,
idempotency, durable OAuth reservations, or approval checks.

A terminal polling error is observed and emits only a fixed attention-required
Host message. It does not expose the account, application, principal,
SecretReference, credential, message, cursor, page token, response, or thrown
value. Production diagnostics and UI recovery status remain separate open work.

## Verification and Limitations

`tests/workbench-feishu-runtime-owner.test.mjs` covers shared acquisition,
identity substitution, cancellation, draining shutdown, hostile input, and
post-close rejection. `tests/workbench-cordis-runtime.test.mjs` covers optional
activation, a synthetic polling page beneath one observed parent acquisition,
normal release, and existing Web lifecycle behavior. The real lease suite
separately retains cross-process exclusion and crash release. The adapter and
polling suites retain OAuth/scope/Keychain ordering, secret cleanup, restart,
cursor, replay, partial-result, and cancellation coverage.

No test reads a live Keychain item or calls Feishu. Live User polling, live reply
execution, automatic restart after Settings or credential changes, production
diagnostics, hosted Bot ingestion, and credential-healthy model generation
remain outside this evidence.
