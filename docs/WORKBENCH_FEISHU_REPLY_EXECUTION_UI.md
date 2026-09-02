# Workbench Feishu Reply Execution UI

## Scope

The Workbench Inbox now exposes a separate external-write step after exact
one-time approval. It composes the existing Connector-neutral execution Host,
the real Feishu runtime lease, system-Keychain resolution, User OAuth rotation,
scope checks, durable dispatch reservation, bounded reply HTTP client, receipt
persistence, and business Audit ordering.

The visible states stay separate:

```text
ready_for_review Draft
  -> exact reply preview
  -> one-time approval
  -> explicit execute click
  -> succeeded | failed | uncertain
```

Approval does not send. Only the final **Send approved reply** action may
perform the external write.

## Exact Host Resolution

The browser submits only a version 1 Work Item ID and Draft revision through a
dedicated same-origin, CSRF-bound, 1 KiB endpoint. It cannot submit an approval
ID, proposal ID, identity, target, content, credential reference, idempotency
key, execution attempt, or retry policy.

Workbench reloads the durable proposal and current User identity, derives the
stable ApprovalRecord ID, verifies that the approval decision is `approved`,
and constructs the production-shaped execution Host from Host-owned
collaborators. The Host recomputes bindings and consumes the exact approval
once before dispatch. Configuration changes invalidate the old proposal rather
than silently redirecting it.

Immediately before the execution click, the Inbox re-displays the exact
account, User identity, timestamped message target, write risk, and final text.

## Result and Retry Semantics

The browser receives only the exact display fields plus a minimized durable
outcome. Success exposes the resulting Feishu message reference and time.
Known failure exposes a bounded issue and either `do_not_retry` or
`retry_same_key`. An uncertain result exposes `reconcile_first`; the UI does
not automatically resend it. Approval IDs, proposal IDs, attempt IDs,
idempotency keys, principals, SecretReferences, tokens, and raw Connector
payloads are omitted.

Only a durable `retry_same_key` result enables the explicit retry control.
Terminal success, terminal failure, and uncertainty disable another send.
The underlying Host can recover a terminal receipt and missing Audit after
restart without another external effect.

## Current Limitations

- The UI does not yet restore the full proposal/approval/result card
  automatically after a browser refresh; exact API replay and durable Host
  recovery remain available.
- Credential health and a real authorized Feishu send have not been accepted
  against a live account.
- Hosted ingestion or polling and the broader Connector lifecycle remain open.

## Verification

Synthetic controller tests prove that browser intent cannot select
authority-bearing IDs and that a mismatched Host result fails closed. Web
contract and loopback tests cover exact response bindings, distinct CSRF,
cross-origin and unknown-field rejection, minimized outcome data, unavailable
capability, and the explicit external-write copy. Existing execution Host and
Workbench reply-runtime tests retain approval consumption, restart recovery,
idempotent dispatch, uncertain-result, Keychain cleanup, OAuth rotation, lease,
receipt, and Audit evidence without a live account or request.
