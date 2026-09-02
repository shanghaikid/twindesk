# Feishu Reply Proposal

## Scope

TD-205 implements the preview-only `propose` boundary for a Feishu message
reply. `FeishuReplyProposer` converts an exact `ConnectorActionRequest` into a
version 1 `ActionProposal` in `proposed` state. It performs no Feishu API call,
resolves no credential, invokes no model, changes no approval state, and sends
no message.

This boundary packages content from an existing Draft; it does not generate
the reply text. A Feishu reply request must include a `draftId`. When Work Hub
persists the result with `createActionProposal()`, the existing storage boundary
requires that Draft to be `ready_for_review`, belong to the same Work Item, and
contain the exact same media type and text. The target must also be a current
external reference on that Work Item's Thread. A proposal that cannot pass
those checks must not be presented as durable or eligible for approval.

## Exact Binding

The proposer accepts only action type `feishu.reply` and binds:

- the Work Item and ready-for-review Draft identities;
- one explicitly selected configured Bot or User identity;
- the current Feishu account and exact `message` target, including its source
  timestamp;
- plain-text content and its canonical SHA-256 digest;
- an opaque proposal ID and send idempotency key;
- `risk: write`, `state: proposed`, and one creation timestamp.

Bot and User remain separate choices even under the same Feishu application.
The request identity must exactly match the configured identity type, account,
and display name. This records which principal is proposed to speak; it does
not grant credentials, scopes, policy authority, or approval.

The MVP preview supports non-empty `text/plain` content with product-side
bounds of 20,000 characters and 64 KiB of UTF-8. Markdown/rich-post
serialization is not implied. The eventual execution adapter may impose a
narrower verified platform limit before any send attempt.

## Idempotency and State Separation

Each new preview receives a random opaque nonce. TwinDesk hashes the nonce with
the account identity to derive non-content-bearing proposal and idempotency
identities. New proposals use a fixed 46-character key (`tdfr1:` plus a
truncated SHA-256 fingerprint), below the Feishu reply request limit of 50
characters. The fingerprint binds the proposal identity plus the configured
app, principal, and credential reference, allowing TD-207 to reject
identity-slot changes without persisting those values in the proposal. A
160-bit fingerprint is retained after truncation. Creating another preview
intentionally creates another proposal.
Once a proposal is persisted, TD-207 must reuse its exact idempotency key for
every retry of that approved action; it must never call `propose` again to make
a retry key.

The TD-205 path stops at `proposed`:

```text
ready_for_review Draft -> proposed ActionProposal -> stop
```

It creates no `awaiting_approval` transition, `ApprovalRecord`, approved-action
capability, execution attempt, `ActionReceipt`, or external effect. TD-206 owns
the separate one-time approval binding, and TD-207 owns the later
reconcile-before-send execution boundary.

## Validation, Privacy, and Failure

Request objects, nested identity, target, and content values must be plain data
with exact fields and no accessors or symbols. Unsupported action or media
types, missing Draft identity, identity spoofing, wrong account, non-message
targets, missing source timestamps, invalid content, invalid clocks, and
cancellation fail before a proposal is returned. Typed failures use bounded
codes and fixed messages without echoing content or identity values.

Draft text, identity display name, target reference, and proposal content are
local business data covered by the existing redaction, export, and deletion
policies. Credentials and SecretReference locators are never accepted by this
boundary. The proposal ID and idempotency key contain hashes only, not message,
Draft, Work Item, principal, or content values.

## Product Integration

The Workbench composition now resolves one exact `ready_for_review` Draft by
Work Item and revision, reads the configured Feishu User identity, selects the
latest unique timestamped Feishu message reference from the durable Thread,
invokes `propose`, and persists the result. The Inbox displays the exact
account, identity label and type, target, risk, Draft revision, and content.
The browser cannot supply any of those bound values.

The product operation uses a configuration-, Draft-, and target-bound stable
nonce. Exact retry therefore recovers the same proposal after restart and can
repair a missing content-free user Audit record without creating another
preview. See
[Workbench Feishu Reply Proposal UI](WORKBENCH_FEISHU_REPLY_PROPOSAL_UI.md).

## Remaining Integration Work

- TD-206 now binds one-time approval to the exact proposal identity, target,
  content digest, responder, and expiration. The Workbench Inbox composes its
  request and decision UI with a fixed 15-minute lifetime and stops before
  consumption or execution.
- TD-207 now defines and tests the credential-resolving client contract,
  idempotent execution, reconciliation, and uncertain-result receipts. The
  Workbench reply runtime composes production-compatible credential, HTTP,
  lease, and durable dispatch boundaries, and the product exposes the separate
  approved execution control and durable browser-refresh restoration.
  Live-account acceptance remains open.

## Verification

`tests/feishu-reply-proposal.test.mjs` starts from a synthetic normalized Feishu
message, applies an explicit Persona selection, stores a ready-for-review
Draft, creates and persists its User-identity reply preview, and recovers the
exact proposal after restart. It verifies Bot/User separation, exact content
digest and target binding, absence of approvals and receipts, cancellation,
missing Draft rejection, unsupported content, identity spoofing, hostile
accessors, and payload-free errors. Existing Draft/ActionProposal storage tests
continue to cover stale or mismatched Drafts and targets, exact replay,
interrupted persistence, and forbidden approval/execution transitions.
The Workbench controller and Web tests additionally cover Host-owned target and
User identity selection, same-origin CSRF, restart replay, Audit recovery,
forged authority fields, cancellation, and the absence of approval or receipt
rows.
