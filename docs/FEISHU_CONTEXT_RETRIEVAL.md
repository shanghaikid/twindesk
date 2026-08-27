# Feishu Context Retrieval

TD-203 adds the bounded, read-only context boundary used after a Feishu message,
thread, document, or attachment reference has been selected. It does not resolve
OAuth secrets, make SDK or HTTP calls without an installed adapter, persist raw
responses or files, send content to a model, or grant any external-write
authority.

## User Identity and Visibility

`FeishuContextRetriever` requires the separately authorized Feishu User
identity. Every request sent to the adapter is bound to the configured account,
application, tenant, and User principal. Every response and returned source
reference is checked against the same identity and the exact requested anchor.
A Bot result, another account or tenant, or a substituted anchor fails closed.
Every non-unavailable result must also contain the requested message, document,
or attachment source; a thread result must contain a message explicitly bound
to that thread. A matching response envelope cannot smuggle unrelated context.

Successful retrieval still means only “visible through the authorized API call.”
It does not prove that the application can see every chat message, thread reply,
document, historical revision, or attachment visible in the Feishu client.
Missing authorization, scope, deletion, pagination, rate limiting, and network
failures remain explicit.

## Fixed Read Boundaries

The product-owned request to a concrete adapter always sets these safe defaults:

- at most 50 total context items, with the caller normally selecting less;
- descending conversation order with the caller's optional `before` time;
- no reaction enrichment;
- simple, referenced document excerpts capped at 20,000 characters;
- attachment text excerpts capped at 8,000 characters and 256 KiB read;
- no binary attachment value returned to TwinDesk.

All bounds except the 50-item protocol maximum can be reduced or adjusted within
validated hard caps when constructing the retriever. A conversation item must
carry its source timestamp and cannot exceed `before`. The response cannot
return more successful plus failed source items than requested. Duplicate
sources, inconsistent timestamps, oversized excerpts, sparse arrays, accessors,
symbols, unknown fields, and raw binary fields fail before any context bundle is
produced. An attachment excerpt must use a case-insensitive textual media type,
cannot read beyond either its declared file size or request byte cap, and must
account for the entire file when marked complete. A reply must identify its
thread.

These parameters reflect current Feishu constraints: thread replies are bounded
by sort order and pagination rather than a native time filter; document reads
should use simple local excerpts instead of fetching an entire unknown document;
and message resource binaries are opt-in downloads rather than implicit context.

## Normalized Context Items

The adapter boundary accepts only three presentation-independent item shapes:

- a message item with normalized text, message type, edit/deletion state,
  relation to the anchor, and an optional thread reference;
- a plain-text document excerpt with revision, referenced-excerpt scope, and an
  explicit truncation flag;
- attachment metadata with either a bounded text excerpt or an explicit
  `metadata_only` reason such as binary, too large, unsupported, deleted, or not
  authorized.

No SDK type, HTTP body, message reaction payload, document block tree, file bytes,
base64 value, cookie, token, or credential reference is part of a context item.
The returned values use the product-owned `ConnectorContextBundle` and
`ExternalReference` types.

## Complete, Partial, and Unavailable

Availability is checked for internal consistency rather than accepted as a
label:

- `complete` requires at least one item, no remaining conversation page, no
  truncated excerpt, no metadata-only attachment body, and no resource problem;
- `partial` requires a concrete missing category while retaining every valid
  item that was retrieved;
- `unavailable` requires zero items plus at least one explicit resource problem.

Partial missing categories name bounded conversation history, truncated document
content, unavailable attachment bodies, and document or attachment failures.
Conversation, document, and attachment authorization, scope, rate-limit, and
network problems preserve whether retry may help. Issues use fixed, payload-free
messages, and failed-source counts remain inside the total item budget. A failed
lookup never silently becomes an empty complete bundle.

Whole-request authorization, missing-scope, rate-limit, network, malformed
response, and unknown adapter failures become typed, payload-free errors.
Cancellation is checked before and after the adapter call.

## Privacy, Retention, and Effects

Conversation text, document excerpts, filenames, attachment text, titles, source
IDs, and principal-bound references may contain company or personal data. TD-203
keeps them only in the returned immutable in-memory bundle. It writes no
database, file, cursor, log, telemetry record, model context, Draft,
ActionProposal, approval, receipt, or Feishu object.

Callers must apply the shared redactor and an explicit purpose/data-selection
policy before model context, diagnostics, telemetry, or export. A later
retention decision is required before any fetched context is cached. Binary
attachments remain outside this boundary.

## Adapter and Scope Limitations

A concrete Feishu SDK/HTTP adapter, OAuth secret resolver, resource-type parser,
and polling/runtime wiring are still not installed. The adapter will need the
minimum User scopes for the selected message, conversation, document, and
resource operations. TD-208 now defines exact runtime scope-health reporting;
the concrete probe remains unwired. Embedded Sheets,
Base, whiteboards, and other structured document objects are reported as partial
or unsupported until a separately bounded reader exists; they are not flattened
into invented text.

TD-204 now normalizes Bot and User sources into durable events and Work Items.
TD-205 now packages an existing ready-for-review Draft as a preview-only reply
proposal, still without sending it. Draft generation from selected context
remains separate runtime/UI work.

## Verification

`tests/feishu-context-retrieval.test.mjs` covers exact User and anchor identity,
all three normalized context item types, fixed and custom limits, complete,
partial, and unavailable results, conversation time bounds, document truncation,
metadata-only attachments, resource failures, duplicate and oversized sources,
raw-binary rejection, sparse and accessor arrays, cancellation, and typed
payload-free adapter failures. All fixtures are synthetic.
