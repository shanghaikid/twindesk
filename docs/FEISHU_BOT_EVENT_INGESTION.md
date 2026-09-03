# Feishu Bot Event Ingestion

TD-201 now composes the verified callback boundary for Feishu Bot message
events into the loopback product Host. The fixed
`POST /api/connectors/feishu/bot/events` route preserves the signed request
bytes, resolves a separate event-subscription bundle from macOS Keychain,
handles URL verification, and commits accepted messages into TwinDesk business
storage before acknowledgement. It does not configure the Feishu subscription,
provide a public ingress, invoke a model, or grant external-write authority.

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
journal, and is never included in typed error messages. The production
Workbench composition resolves one `connector_api_key` SecretReference through
the existing fixed macOS Keychain service for each callback. Its version 1 JSON
bundle contains only the exact app ID, Verification Token, and Encrypt Key. The
source bytes are zeroed after the callback settles, and the parser rejects
unknown or duplicate fields, invalid UTF-8, oversized data, and app mismatch.

URL verification is accepted only after the same raw-body signature check and
an exact timing-safe Verification Token match. The Host then returns only
`{"challenge":"..."}`. This follows the official Node SDK's
[request-address challenge behavior](https://github.com/larksuite/node-sdk#challenge-check)
while retaining TwinDesk's stricter signature and token checks. Verification
cannot be disabled.

## Hosted HTTP and Acknowledgement Boundary

The product Web server remains bound to `127.0.0.1` or `::1`. Enabling Bot
events requires both Host launch variables:

- `TWINDESK_FEISHU_TENANT_KEY` — the bounded tenant identity;
- `TWINDESK_FEISHU_BOT_EVENT_SECRET_REFERENCE_ID` — the opaque Keychain item
  account, such as `secret-ref:feishu-bot-events`.

The Keychain item uses service `com.twindesk.feishu` and contains:

```json
{
  "kind": "feishu_bot_event_subscription_secret_bundle",
  "schemaVersion": 1,
  "appId": "cli_example",
  "verificationToken": "value-from-feishu-developer-console",
  "encryptionKey": "value-from-feishu-developer-console"
}
```

The route requires a bounded `application/json` body with an unambiguous
Content-Length. Duplicate signature headers, chunked bodies, query parameters,
unsupported methods, and bodies over 1 MiB fail before the ingestion service.
Invalid signatures, timestamps, tokens, identities, and event shapes receive a
payload-free rejection. Storage, Keychain, or lease failures receive a
retryable HTTP 503. Accepted, ignored, and duplicate deliveries return an empty
JSON acknowledgement. Client disconnect and Host shutdown cancel work that has
not become durable.

Because the product listener is intentionally loopback-only, a user-managed
TLS reverse proxy or tunnel must forward the public Feishu Request URL to this
fixed local path. It must expose only
`POST /api/connectors/feishu/bot/events`, not the TwinDesk product origin or its
other loopback routes. TwinDesk does not provision, trust, or persist that
upstream configuration. The official SDK documents that request-address verification
must return the challenge within one second and event handlers must finish
within the platform acknowledgement window; live latency remains an acceptance
item.

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

The hosted path normalizes an accepted event and atomically commits its
ExternalEvent, Thread, and Work Item before appending the hash-only callback
receipt. The Inbox reader now pages through all durable Work Items, so a new Bot
message is visible alongside the synthetic fixtures. It creates no Draft,
ActionProposal, approval, send request, or external write. The following remain
separate tasks:

- public TLS ingress, Feishu subscription setup, and a live callback acceptance;
- bounded context enrichment after the durable TD-204 normalization boundary;
- production scope, rate-limit, health, and cursor probe composition; TD-208 now
  defines the presentation-safe diagnostics contract.

## Verification

`tests/feishu-bot-events.test.mjs` covers direct messages, URL verification,
exact Bot mentions,
unmentioned groups, plaintext and encrypted callbacks, invalid and stale
signatures, application and tenant mismatch, message-level replay and conflict,
cross-instance concurrent duplicates, out-of-order messages, downstream failure
and retry, restart recovery, interrupted journal tails, private hash-only
persistence, symbolic links, and hostile accessors without payload disclosure.
The subscription-secret, Workbench ingress, Web callback, Cordis runtime, and
Inbox suites additionally cover Keychain scoping and zeroing, exact
acknowledgements, duplicate headers, shutdown cancellation, atomic durable
projection, restart deduplication, and visibility in the product Inbox. All
credentials and messages are synthetic.
