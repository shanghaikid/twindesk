# Stage 1 Exit Gate

- Audit date: 2026-08-27
- Tracker: TD-112
- Scope: fixture Inbox → Persona → Draft → Audit

## Decision

**PASSED. Stage 2 may begin.**

Stage 1 now proves the complete local Work Hub path with durable synthetic
records and no external side effects. The gate uses deterministic fixture
Drafts so it can verify persistence, routing, Persona identity, partial
context, auditability, restart recovery, and failure behavior without claiming
that a model or Connector ran.

## Criteria

| Criterion | Result | Evidence |
|---|---|---|
| Persona selection maps to installed behavior without granting authority | **Pass** | The Communication and Technical Lead Personas must match their exact installed Preset mappings. Both remain `draft_only`, report `authorityEffect: none`, and expose no external write. An explicit Persona mismatch fails before any fixture Draft or Draft audit is created. |
| Persona output becomes a reviewable Draft | **Pass** | Two deterministic version 1 Drafts are persisted in `ready_for_review`, including a Technical Lead Draft that explicitly preserves partial context. They contain no ActionProposal, approval, receipt, Session, or Run claim. |
| Draft activity is visible in the business Audit Timeline | **Pass** | Two immutable `draft` AuditRecords link each Persona actor to its Work Item, source event, and Draft. Together with the four routing records, the loopback Audit page exposes six presentation-safe records. |
| The flow is replayable and restart-safe | **Pass** | Reopening the same database returns identical Inbox, Draft, and Audit projections without duplicate events, Drafts, or Audit records. Interrupted Draft creation or Audit append is repaired idempotently on restart without duplicating durable records. |
| Stage 1 remains local and side-effect free | **Pass** | The fixture flow performs no model call, Harness Run, Connector execution, external write, approval decision, or action receipt. Thread export and deletion have explicit redaction, revision, tombstone, shared-event, cursor, and separate Harness Session retention behavior. |

## Verified Path

```text
synthetic ExternalEvent
  -> durable Thread and Work Item projection
  -> exact built-in Persona / Preset mapping
  -> deterministic ready_for_review Draft
  -> immutable Draft AuditRecord
  -> presentation-safe loopback Audit page
  -> identical projection after restart
```

The deterministic Draft content is repository fixture data. It is evidence for
the TwinDesk domain and persistence path, not evidence of model quality or an
executed Agent Session.

## Verification

The Stage 1 gate and related repository checks cover:

- duplicate-free restart recovery for events, projections, Drafts, and Audit;
- all-or-nothing Persona preflight before fixture Draft creation;
- fail-closed handling of changed Persona identity and mismatched durable
  Draft content;
- partial-context language in the Technical Lead fixture Draft;
- interrupted Draft and Audit writes followed by idempotent repair;
- absence of ActionProposals, approvals, receipts, and external effects;
- presentation omission of internal IDs and Audit details;
- versioned, redacted Thread export and revision-bound deletion.

## Remaining Limitations

- Draft generation is deterministic fixture behavior. A real model-backed
  Persona Run, Session association, budgets, cancellation, and runtime failure
  handling remain future work.
- The current pages do not let the user select a Persona, edit a Draft, create
  an ActionProposal, approve content, or execute an action.
- No real Feishu identity, event subscription, context retrieval, attachment
  retrieval, scope diagnostic, or reply Tool is connected.
- Stage 2 must keep reading, drafting, approval, and execution separate while
  adding one-time exact-content approval, idempotent execution, and uncertain
  result handling.
