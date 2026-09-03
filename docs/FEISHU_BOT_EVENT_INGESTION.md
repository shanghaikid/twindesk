# Feishu Bot Event Ingestion

TD-201 adds the verified callback boundary for Feishu Bot message events. It
does not create an HTTP server, configure a Feishu subscription, resolve a
Keychain secret, normalize a message into a TwinDesk `ExternalEvent`, or grant
any external-write authority.

## Accepted Visibility

`FeishuBotEventConsumer` accepts only Feishu version 2
`im.message.receive_v1` events delivered to the configured application:

- a `p2p` message is classified as `direct_message`;
- a `group` message is accepted only when its mention list contains the exact
  configured Bot principal ID;
- an unmentioned group message is acknowledged as ignored without invoking the
  downstream handler or creating a receipt;
- an event for another application or tenant, another event type, or an
  unsupported chat type fails closed.

This is the Bot's event-delivery view, not the user's Feishu account view. It
does not imply access to all chats, private messages, documents, or historical
messages. TD-202 owns incremental discovery under the separately authorized
User identity.

The verified in-memory event preserves the source message, chat, sender,
thread, delivery, and creation-time references needed by later normalization.
It also contains parsed message content and therefore may contain company or
personal data. Callers must not send the object to logs, telemetry, exports, or
model context without applying the appropriate shared redaction policy.

## Signature and Encryption Boundary

The host must pass the untouched callback bytes and request headers to the
consumer. Before parsing or handling content, the consumer:

1. requires `X-Lark-Request-Timestamp`, `X-Lark-Request-Nonce`, and
   `X-Lark-Signature`;
2. rejects timestamps more than five minutes from the local clock;
3. calculates SHA-256 over timestamp + nonce + Encrypt Key + raw body;
4. compares the received and calculated digests with a timing-safe operation;
5. when an encrypted envelope is present, derives the AES-256-CBC key from the
   Encrypt Key and decrypts the signed envelope before event validation.

The expected tenant key and Encrypt Key are supplied at construction. The
tenant key is non-secret identity metadata; the Encrypt Key is a short-lived
in-memory value. It is held in a private field, is never written to the receipt
journal, and is never included in typed error messages. The current repository
still has no Keychain resolver or default callback host; those installation
boundaries must resolve the key from an opaque secret reference and register the
in-memory value with the shared redactor. Verification cannot be disabled.

## Deduplication and Commit Order

Feishu's `message_id` is the semantic idempotency identity. `event_id` is kept
only as a delivery reference and is not used for deduplication. The receipt key
hash includes the TwinDesk account, application, and message identity. A second
hash covers the stable message fields while excluding the delivery event ID, so
an exact redelivery is a duplicate and reuse of one message identity with
changed content fails as a conflict.

`FeishuBotEventReceiptStore` shares one lock and cache for every resolved journal
path in a Node.js process, including across separate Consumer instances. For a
new message it invokes the downstream handler first, then appends and `fsync`s
the receipt. A failed handler creates no receipt and remains retryable.
Concurrent duplicates invoke the handler once. A crash after downstream commit
but before receipt commit can cause one replay, so the TD-204 normalization
handler uses durable ExternalEvent idempotency
boundary. The consumer does not claim exactly-once delivery across two
independent processes.

The append-only JSONL journal stores only:

- a version number and record kind;
- the message-key hash;
- the stable-event hash;
- the verified local receive time.

It stores no raw callback, message content, external ID, principal, app ID,
SecretReference, credential, or Encrypt Key. The file is created as `0600`,
opened with `O_NOFOLLOW`, limited to 32 MiB, and repairs an incomplete final line
after interruption. Existing non-private files, symbolic links, conflicting
records, invalid versions, and oversized journals fail closed. There is no
automatic pruning: the journal remains until the Connector's local ingestion
state is explicitly deleted, and reaching the size limit stops ingestion
instead of silently forgetting idempotency history.

## External Effects and Remaining Work

TD-201 reads a signed event and records a local hash receipt only. It creates no
Draft, ActionProposal, approval, send request, or external write. The following
remain separate tasks:

- HTTP/long-connection hosting, subscription setup, secret resolution, and
  callback acknowledgement wiring;
- hosted Bot callback or long-connection activation beside the existing
  Cordis-owned User polling composition;
- runtime composition with the completed bounded context and durable
  normalization boundaries (TD-203 and TD-204);
- production scope, rate-limit, health, and cursor probe composition; TD-208 now
  defines the presentation-safe diagnostics contract.

## Verification

`tests/feishu-bot-events.test.mjs` covers direct messages, exact Bot mentions,
unmentioned groups, plaintext and encrypted callbacks, invalid and stale
signatures, application and tenant mismatch, message-level replay and conflict,
cross-instance concurrent duplicates, out-of-order messages, downstream failure
and retry, restart recovery, interrupted journal tails, private hash-only
persistence, symbolic links, and hostile accessors without payload disclosure.
