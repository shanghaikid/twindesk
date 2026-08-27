# Feishu User Message Discovery

TD-202 adds the incremental discovery boundary for messages returned under the
separately authorized Feishu User identity. It does not claim to enumerate the
user's complete account history, resolve OAuth credentials, call Feishu without
an installed search adapter, normalize messages into `ExternalEvent` records,
or grant any external-write authority.

## Visibility Boundary

`FeishuUserMessageDiscoverer` accepts only a search response explicitly bound
to the configured account, application, tenant, User principal, and
`identityType: user`. A Bot response or a response for another identity fails
closed.

The intended adapter uses user-identity message search with a bounded time
filter, then retrieves the returned message details and conversation context.
This depends on all of the following:

- an unexpired user access token resolved outside ordinary business storage;
- the application's granted scopes and the user's matching authorization;
- the user's access to each conversation;
- Feishu search indexing, API retention, pagination, and result behavior.

Consequently every batch reports `coverage.status: partial` with
`basis: authorized_user_message_search`. It does not imply access to every
private message, group, thread reply, document notification, deleted message,
historical edit, or item visible in a Feishu client. Bot event delivery remains
the separate TD-201 path.

The adapter contract does not request reactions or resource downloads. The
future concrete adapter is expected to require the minimum scopes for search,
message detail retrieval, and chat context (currently `search:message`,
`im:message:readonly`, and `im:chat:read`) and to surface authorization or scope
failures rather than returning an empty successful page. Scope health and
diagnostics remain TD-208 work.

## Bounded Incremental Windows

The default discovery schedule is deliberately bounded:

- first run: the previous 24 hours;
- indexing delay: stop 30 seconds behind the local clock;
- subsequent runs: restart five minutes before the durable watermark;
- page size: caller-selected from 1 through 50;
- execution: one search page per discovery call.

These values are validated configuration, not completeness guarantees. The
overlap makes recent delayed indexing and edits replayable, while message-level
TD-204 idempotency makes those replays harmless. An edit to a message
created outside the overlap may still be missed. A longer or periodic backfill
policy must be an explicit future product decision with measured cost and
retention behavior.

## Candidate Cursor Protocol

The discoverer never persists a cursor. It returns a versioned domain
`ConnectorCursor` candidate for the `user_visible_messages` stream. Work Hub may
commit that candidate only in the same TwinDesk storage transaction that
durably commits every normalized event from the page.

The opaque position contains either:

- a watermark for the last fully exhausted time window; or
- that watermark plus an active window and the next Feishu page token.

While a window has more pages, `committedThrough` remains at the previous
completed watermark. The last page advances it to the window end. A restart can
therefore resume the exact time window and page. If Feishu rejects an expired
page token, the discoverer restarts the same window without a token; already
committed pages replay and must be deduplicated by TD-204.

If the local clock moves behind a persisted cursor's `updatedAt`, discovery
fails before making a Feishu request. This avoids producing a regressing cursor;
an operator must restore a trustworthy clock before polling resumes.

The page token is opaque Connector state. It may be stored only inside the
TwinDesk cursor record and must not appear in diagnostics, model context,
exports, or error messages.

## Partial Results and Failure Semantics

The search adapter returns full messages and a separate list of message IDs for
which detail retrieval failed. If any detail is unavailable, the batch:

- retains the available messages;
- exposes a count-only retryable issue;
- reports the missing IDs as source references, not as an empty result;
- omits the candidate cursor and reports `hasMore: true` so the same page is
  retried.

Authentication, missing-scope, rate-limit, network, malformed-response, and
unknown adapter failures become payload-free typed errors. Cancellation is
checked before and after the external call. Response identity, page size,
pagination shape, timestamps, message state, JSON depth, duplicate message IDs,
dense data-only arrays, and overlap between available and unavailable results
are validated before a candidate cursor is produced. Sparse or accessor-backed
arrays fail without evaluating their elements.

## Privacy and External Effects

Discovered messages are deeply immutable in-memory values. They can contain
message content, sender and chat names, principal IDs, chat IDs, and thread IDs,
all of which may be company or personal data. TD-202 persists none of those
values and sends none to a model, log, telemetry sink, or export. Later callers
must apply the shared redaction policy at every outbound boundary.

This path performs reads only. It creates no Draft, ActionProposal, approval,
reply, send request, or other Feishu write.

## Remaining Work

- A concrete Feishu HTTP/SDK search adapter, OAuth secret resolution, and
  polling scheduler are not wired yet.
- TD-203 now defines bounded conversation, document-excerpt, and attachment
  context retrieval; its concrete SDK/HTTP adapter is not wired yet.
- TD-204 now normalizes Bot and User sources into durable ExternalEvents and
  Work Items and atomically commits User events, projections, and candidate
  cursors; polling/runtime composition remains unwired.
- TD-208 exposes identity, scope, cursor, rate-limit, and health diagnostics.

## Verification

`tests/feishu-user-discovery.test.mjs` covers the bounded first window, rolling
overlap, exact identity binding, multi-page restart, final-page watermark
advance, expired-token replay, out-of-order messages, missing detail retry,
malformed and hostile responses, cursor conflicts, cancellation, typed adapter
failures, clock regression, immutability, and the caught-up no-request path. All
fixtures are synthetic.
