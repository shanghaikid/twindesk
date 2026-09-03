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

The production HTTP primitive uses the User-token form of the official
[IM v1 message search](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=search&project=im&resource=message&version=v1)
endpoint with a bounded time filter, then reads each result through the official
[IM v1 message detail](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=get&project=im&resource=message&version=v1)
endpoint. It deliberately uses IM v1 search rather than
[Search v2](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=create&project=search&resource=message&version=v2):
the current official SDK contract makes the Search v2 query text mandatory, so
it cannot represent an unfiltered incremental time window. If indexed metadata
omits the optional chat mode, the primitive uses the official
[IM v1 chat detail](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=get&project=im&resource=chat&version=v1)
endpoint required by the declared `im:chat:read` scope instead of guessing a
conversation type. The primitive validates exact fixed endpoints, pagination,
message metadata/detail consistency, chat type, sender and mention identifier
types, response bounds, and cancellation. It maps inaccessible individual
details to the existing explicit partial-result path while global authorization,
scope, rate-limit, network, and malformed-response failures stay terminal or
retryable according to the discovery contract.

The configured `FeishuUserMessageSearchAdapter` wraps this primitive only while
the Host's exclusive Feishu lease remains held. It binds the exact account,
application, tenant, and User principal; runs durable OAuth rotation; authorizes
the fixed `user_message_discovery` scope policy; rereads the exact Keychain item
to close the scope-check/use gap; rechecks scopes and lease ownership; and lends
the current access token only for the HTTP callback. The primitive still never
resolves or retains a credential itself. Workbench constructs this adapter
lazily inside the polling runtime's already-held Host lease, and Cordis now
activates that composition through its shared owner. This path depends on all of
the following:

- an unexpired user access token resolved outside ordinary business storage;
- the application's granted scopes and the user's matching authorization;
- the user's access to each conversation;
- Feishu search indexing, API retention, pagination, and result behavior.

Consequently every batch reports `coverage.status: partial` with
`basis: authorized_user_message_search`. It does not imply access to every
private message, group, thread reply, document notification, deleted message,
historical edit, or item visible in a Feishu client. Bot event delivery remains
the separate TD-201 path.

The adapter does not request reactions or resource downloads. It must pass the
fixed `user_message_discovery` operation policy, which requires
`search:message`, `im:message:readonly`, and `im:chat:read`, and surfaces
authorization or scope failures rather than returning an empty successful page.
Scope health and diagnostics are defined by
[Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md); its production
diagnostics probe remains unwired. The concrete local credential probe is
defined by
[Feishu User Credential Scope Probe](FEISHU_USER_CREDENTIAL_SCOPE_PROBE.md).

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

- The Workbench now owns a supervised polling loop that holds the Host lease,
  restores the durable cursor for every page, atomically commits normalized
  events/projections/cursors, and applies bounded retry. The concrete bounded
  Feishu HTTP search/detail primitive and its lease-held, rotation-, scope-, and
  Keychain-bound adapter, Workbench factory, and Cordis shared-owner activation
  now exist. Product-mediated lifecycle reconstruction is also covered;
  production diagnostics, out-of-process configuration watching, and live
  acceptance remain open. See
  [Workbench Feishu User Polling Runtime](WORKBENCH_FEISHU_USER_POLLING_RUNTIME.md).
- TD-203 now defines bounded conversation, document-excerpt, and attachment
  context retrieval; its concrete SDK/HTTP adapter is not wired yet.
- TD-204 now normalizes Bot and User sources into durable ExternalEvents and
  Work Items and atomically commits User events, projections, and candidate
  cursors; the Workbench polling lifecycle composes this path through an
  production search adapter beneath one Cordis-owned shared lease. Live
  acceptance remains unwired.
- TD-208 now exposes the runtime identity, scope, cursor, rate-limit, and health
  diagnostics contract. Its concrete Feishu/SQLite probe remains unwired. See
  [Feishu Connector Diagnostics](FEISHU_CONNECTOR_DIAGNOSTICS.md).

## Verification

`tests/feishu-user-message-search-http-client.test.mjs` covers the fixed search
and detail requests, rounded API time bounds with exact result filtering,
pagination, unavailable details, chat-mode fallback, authorization/scope/rate-
limit/page-token mapping, identity/detail consistency, response-size limits,
cancellation, timeout, and hostile borrowed-token handling.
`tests/feishu-user-message-search-adapter.test.mjs` covers rotation-before-use,
fresh scope authorization, the final Keychain reread, exact identity and opaque
page-token forwarding, lease loss, missing scope, blocked credential recovery,
cancellation, and transient secret cleanup.
`tests/feishu-user-discovery.test.mjs` covers the bounded first window, rolling
overlap, exact identity binding, multi-page restart, final-page watermark
advance, expired-token replay, out-of-order messages, missing detail retry,
malformed and hostile responses, cursor conflicts, cancellation, typed adapter
failures, clock regression, immutability, and the caught-up no-request path. All
fixtures are synthetic. The separate Workbench runtime test covers durable
page restart, bounded retry, cancellation, lease loss checks, and atomic commit
interruption.
