# Workbench Model Draft Editing

## Scope

The product Inbox can edit a generated local Draft and explicitly mark it
`ready_for_review`. Both actions remain inside the `draft_only` boundary. They
do not create an ActionProposal, request or decide an approval, resolve a
credential, call a Connector, or perform an external write.

## Revision and state rules

The browser submits one exact, same-origin, CSRF-bound version 1 request with a
Work Item ID, expected source revision, bounded text content, media type, and a
boolean `submitForReview` intent. Provider, model, prompt, Persona, runtime
identity, approval, target, and authority are not accepted.
The product caps one model-Draft chain at 100 revisions and rejects an edit
that would exceed that bound.

A changed edit never overwrites the stored model output. SQLite atomically:

1. validates the expected active source Draft and selected Persona;
2. records the source transition to `superseded`;
3. creates the next sequential Draft revision as either `editing` or
   `ready_for_review`.

Unchanged content may transition an `editing` Draft directly to
`ready_for_review`. Stable revision and transition identities make exact retry
and restart recovery deterministic. Profile recovery follows the revision
chain and returns the latest local Draft instead of presenting superseded model
output.

## Audit and privacy

Every material user edit or ready-for-review decision appends an immutable
user-attributed Draft Audit record. The record contains the source revision,
result revision, local state, and `externalWrite: false`; it does not copy Draft
text. If Draft persistence succeeds but Audit append is interrupted, retry
repairs the same Audit record without creating another revision or invoking the
model again.

Draft text is local company or personal data. The API bounds it to 64 KiB of
UTF-8, clears the request body buffer after parsing, returns payload-free
errors, and relies on the existing Thread export/deletion boundary for
retention.

## Verification and limitations

Synthetic tests cover atomic revision creation, state transition, exact replay,
cold restart, Audit interruption and repair, same-origin CSRF, forged fields,
bounded browser contracts, and the absence of another model invocation.

`ready_for_review` is not approval. Exact Feishu User reply preview is now a
separate product action documented in
[Workbench Feishu Reply Proposal UI](WORKBENCH_FEISHU_REPLY_PROPOSAL_UI.md).
Approval request and decision UI, execution confirmation, credential-healthy provider acceptance,
Connector polling, and live Feishu delivery remain separate Stage 2 work.
