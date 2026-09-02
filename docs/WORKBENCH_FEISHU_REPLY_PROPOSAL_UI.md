# Workbench Feishu Reply Proposal UI

## Scope

This product entry connects an exact local `ready_for_review` Draft to the
existing preview-only Feishu reply proposer. It persists one `proposed`
`ActionProposal` and presents its complete write binding in the Inbox. It does
not request approval, produce an approved capability, resolve a credential,
call Feishu, or create an execution receipt.

## Browser Contract

`GET /api/action-proposals/feishu-reply` returns only version, capability, and
the fixed `feishu.reply` action type. A ready capability receives a dedicated
process-local CSRF token.

`POST /api/action-proposals/feishu-reply/create` accepts exactly:

```json
{
  "version": 1,
  "workItemId": "opaque-local-id",
  "draftRevision": 2
}
```

The 1 KiB loopback request must be same-origin JSON with same-site Fetch
metadata and that separate CSRF token. It cannot select identity, account,
target, content, action type, risk, approval, execution, credentials, Persona,
provider, or model.

## Host Binding

Workbench reloads the versioned Feishu identity configuration and requires its
User slot. It resolves the exact Draft by `(workItemId, revision)`, requires
plain text in `ready_for_review`, and loads the owning durable Thread. The reply
target is the latest timestamped Feishu message reference for the configured
account. Two different message IDs at the same latest timestamp are ambiguous
and fail closed.

The Host supplies the configured User `ActionIdentity`, selected target, and
exact Draft content to `FeishuReplyProposer`. SQLite remains authoritative for
same-Work-Item, ready-Draft, content, target-membership, digest, and chronology
validation.

## Replay and Audit

The product controller derives a hash-only nonce from the configuration slot,
Draft, and exact target. An exact retry therefore finds and validates the same
proposal instead of creating another one. A configuration or target change
derives another binding and cannot silently reuse the old proposal.

Proposal persistence precedes a content-free user-attributed Audit record. If
Audit append is interrupted, retry validates the durable proposal and repairs
only that Audit record. Restart tests prove one proposal and one Audit record,
with no approval or receipt rows.

## Presentation and Authority

The Inbox shows the exact account, User identity label and type, external
message target and timestamp, `write` risk, Draft revision, and final content.
The response carries `approvalAvailable: false` and
`executionAvailable: false`, and the page states that no Feishu message was
sent. Creating a preview is not consent to send.

Account, identity, target, and Draft content are local business data covered by
the existing export, deletion, and redaction policies. Principal IDs,
SecretReference locators, credential values, proposal IDs, content digests, and
idempotency keys do not cross the browser boundary.

## Verification and Limits

Synthetic tests cover exact Host binding, restart replay, unavailable User
identity, stale Drafts, cancellation, strict browser parsing, forged authority
fields, same-origin CSRF, cross-site rejection, service shutdown, and product
composition. They use no live account, credential, provider, or network call.

Exact approval request and decision UI is the next product step. Production
polling, credential-health acceptance, approved execution presentation, and a
live Feishu send remain separate Stage 2 exit requirements.
