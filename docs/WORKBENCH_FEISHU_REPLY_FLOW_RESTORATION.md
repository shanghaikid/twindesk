# Workbench Feishu Reply Flow Restoration

## Scope

The Inbox restores the presentation-safe state of one Work Item's local action
flow after a browser refresh or item switch. Restoration covers the latest
Draft and, when present, its exact Feishu reply proposal, one-time approval,
and terminal or uncertain execution receipt. It is a read-only operation and
does not create a Draft, request or decide approval, consume authority, repair
Audit, call a Connector, or retry an external write.

## Durable Resolution

Workbench accepts only one opaque Work Item ID. The Host reads the Work Item,
walks its bounded Draft revision chain, and selects the latest durable proposal
using the TwinDesk SQLite boundary. It then derives the approval and execution
attempt identities from the stored proposal rather than accepting them from
the browser.

Every recovered layer is checked before presentation:

- the Draft revision chain is complete and remains bound to the selected
  built-in Persona;
- the proposal belongs to the latest Draft and its Feishu User identity,
  account, target, media type, and content remain exact;
- approval identity, target, and content digests match the proposal;
- approval decision and proposal state agree;
- a receipt uses the derived execution attempt, proposal, account, Connector,
  and idempotency bindings; and
- a terminal proposal state has the matching durable receipt.

Missing optional layers produce an earlier valid stage. Missing or conflicting
required evidence fails closed instead of presenting an invented empty state.

## Web Boundary

`GET /api/action-flow/feishu-reply?workItemId=...` returns one of five exact
version 1 shapes: `empty`, `draft`, `proposal`, `approval`, or `execution`. The
response reuses the strict minimized Draft, proposal, approval, and execution
browser contracts. It omits proposal IDs, approval IDs, execution attempt IDs,
idempotency keys, responders, principals, SecretReferences, credentials,
Connector payloads, and filesystem state.

The endpoint is loopback-only, read-only, query-bounded, `no-store`,
frame-denied, and has no mutation or execution capability. Browser actions are
disabled while restoration is pending. Selecting another Work Item invalidates
the earlier request so a late result cannot replace the active card.

## Restart and Safety Semantics

Restoration reads existing TwinDesk business records without writing them.
Refreshing the page therefore cannot extend an approval lifetime, change a
decision, consume a one-time approval, reserve a dispatch, repair an Audit
record, or resend a reply. An approved flow with an incomplete execution may
still expose the separate explicit execution/recovery control; the existing
Host execution policy decides whether reconciliation or a same-key recovery is
safe.

Synthetic tests cover every restored stage, restart recovery through a durable
success receipt, cross-layer binding rejection, browser authority injection,
exact query validation, minimized output, and default Workbench composition.
No live credential, provider request, Keychain read, or Feishu request is used.

## Remaining Limitations

- Restoration is request-driven on page load and item selection; production
  polling and cross-window live updates remain open.
- Credential-healthy provider acceptance and a real authorized Feishu send
  have not yet passed the live-account exit gate.
