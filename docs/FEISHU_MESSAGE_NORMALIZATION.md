# Feishu Message Normalization

## Scope

TD-204 adds the product-owned boundary between the verified Feishu Bot event
path or bounded User discovery path and TwinDesk business storage.
`FeishuMessageNormalizer` converts those already validated in-memory values into
version 1 `ExternalEvent`, `ExternalThread`, and `WorkItem` records. It neither
calls Feishu nor resolves credentials, retrieves context, invokes a model,
creates a Draft, or performs an external write.

The normalizer accepts only the account, application, tenant, and principal
identities configured for the corresponding Bot or User path. Identity
mismatches fail before a normalized batch is returned. The upstream Bot
consumer and User discoverer remain responsible for validating untrusted API
payloads; the normalizer consumes only their typed, immutable output.

## Canonical Events and Replay

A message state is identified by the Feishu account, message ID, normalized
event type, and source occurrence time. These values produce deterministic
local event and idempotency IDs. The Bot and User paths intentionally omit
delivery-only, sender-display, and discovery-only fields from the immutable
event body. When both paths observe the same created state, they therefore
converge on one `ExternalEvent`; the first local `receivedAt` remains durable.

Content, message type, chat identity, conversation identity, normalized
mentions, and reply routing are part of the immutable body. If two sources
claim the same canonical state but disagree on those fields, ingestion fails
closed as an event conflict instead of silently choosing a value. Edits and
deletions use their source update time and become separate immutable events.
Source-time out-of-order delivery is retained in event history.

Raw callbacks, search responses, delivery IDs, sender names, and credentials
are not copied into the event. Each event explicitly records partial context:
conversation history, document context, and attachment context have not yet
been retrieved. TD-203 context bundles remain separate inputs for TD-205 rather
than being invented during normalization.

## Thread and Inbox Routing

Messages aggregate by Feishu thread ID when present and otherwise by chat ID.
The resulting stable local Thread and Work Item IDs are hashes of the account
and conversation identity. A direct message or an exact mention of either
configured principal enters `needs_reply`; another discovered group message
enters `needs_review`; a latest deletion enters `done`. This routing is a local
attention projection only. It grants no Persona, Skill, Tool, Connector scope,
approval, or execution authority.

Each projection retains immutable source event IDs and stable external
references. A later source state may update the Inbox summary and state, while
an older state arriving late is appended to history without regressing the
current presentation. An existing explicit Persona selection is preserved.
Projection generation reads the current Thread and Work Item first; if another
writer changes them before commit, normal storage conflict checks fail closed
and the caller must normalize again from a fresh snapshot.

## Atomic Storage Boundary

`commitConnectorSyncBatch()` now optionally accepts Work Item projections. It
validates the full event and projection batches before opening a write
transaction, then commits in this order:

1. idempotent `ExternalEvent` ingestion;
2. event-anchored Thread and Work Item projections;
3. the optional Connector cursor.

All three states commit or roll back together. In particular, a User discovery
cursor cannot advance past an Inbox projection that failed to persist. A Bot
handler may use the same path without a candidate cursor; its separate receipt
is written only after the handler completes, so a crash may replay the message
but deterministic event ingestion remains harmless.

## Privacy and Retention Review

Normalized content, mention principals, summaries, and source references may
contain authorized company or personal data. They remain local TwinDesk
business data and follow the existing event, Thread export/deletion, redaction,
and model-context policies. No raw payload is retained by this boundary. Typed
normalization and storage failures use fixed messages and bounded codes without
echoing rejected identities or content.

## Remaining Integration Work

- Concrete Feishu callback hosting, User polling, OAuth/Keychain resolution,
  and scheduler wiring are not installed.
- The Bot callback handler and User polling loop still need runtime composition
  around normalization and the atomic commit call.
- TD-205 now packages an existing ready-for-review Draft as a preview-only
  reply proposal. It does not generate or send the reply.
- TD-208 now exposes the identity, scope, cursor, rate-limit, and health
  diagnostics contract without changing normalization authority. See
  [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).

## Verification

`tests/feishu-message-normalization.test.mjs` covers cross-path deduplication,
cold restart, cursor persistence, explicit partial context, update routing,
out-of-order deletion history, identity mismatch redaction, and rollback of
events, projections, and cursor after an injected projection interruption.
The synchronization and Work Item projection suites continue to cover batch
validation, event conflicts, cursor regression, rebuilds, user actions, and
closed handles. All fixtures are synthetic.
