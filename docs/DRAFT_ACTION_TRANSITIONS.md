# Draft and ActionProposal Transitions

## Scope

TD-108 implements the local persistence boundary between Persona output and
future approval or Connector execution. `TwinDeskDatabase` can create and read
Drafts and ActionProposals, then append a versioned state-transition record and
update the current projection in one SQLite transaction.

This boundary has no Connector, Tool, approval responder, or execution input.
It cannot send content, create an approval decision, or produce an external
receipt. Stage 2 must add those capabilities through separate policy and
approval boundaries.

## State Machines

A new Draft starts in `editing` or `ready_for_review`. The local transition
graph is:

```text
editing ──→ ready_for_review ──→ superseded
   │                 │
   ├──→ superseded   └──→ cancelled
   └──→ cancelled
```

Only one `editing` or `ready_for_review` Draft may exist for a Work Item. A new
revision must be sequential and may be created only after the preceding Draft
is terminal. Its Persona must equal the Work Item's explicit selected Persona;
this check records identity and grants no authority. Draft creation must not
precede the current Work Item projection, including its explicit user actions.

A new ActionProposal always starts in `proposed`. TD-108 permits only local,
non-executing transitions:

```text
proposed ──→ awaiting_approval ──→ rejected
    │                  │
    └──→ cancelled     └──→ cancelled
```

The parser rejects transitions to `approved`, `executing`, `succeeded`,
`failed`, or `uncertain`. Those states require evidence that TD-108 does not
own. This keeps the storage API from turning a Persona choice or a local page
action into external authority.

## Binding and Idempotency

An ActionProposal optionally binds to a Draft. When it does, the Draft must be
`ready_for_review`, belong to the same Work Item, contain the exact same media
type and text, remain at least as recent as the Work Item, and precede the
proposal. Its target must exactly match one external reference on the Work
Item's Thread, including the optional source timestamp. The proposal also
stores a SHA-256 digest of canonical UTF-8 JSON containing exactly the media
type and text. Identity and target must already refer to the same Connector
account under the domain contract.

Draft IDs, `(work_item_id, revision)`, ActionProposal IDs, proposal idempotency
keys, and transition IDs are stable conflict boundaries. Exact create and
transition retries are duplicates, including after later transitions or a
restart. Reusing any boundary for different content fails closed.

Migration 3 adds versioned, immutable creation snapshots and transition
histories. The creation snapshots preserve the original state and timestamp so
a create retry can be compared with the original request after the current
record advances. Current state and its transition history commit atomically.
An interrupted update rolls both back.

## Privacy and Retention Review

Draft text, rationale, identity display names, targets, and proposal content
may contain company or personal data. They remain local business records.
Typed failures expose bounded codes and generic messages without record IDs,
targets, or content. Content digest validation rejects accessor properties
without invoking them.

The TD-110 shared redactor is now available for every future diagnostic or
export boundary. Diagnostic policies remove these business-content fields;
authorized model context or export may retain them only after credentials,
secret locators, and hidden reasoning are removed. This module itself emits no
diagnostic or export payload. TD-111 includes current Drafts and
ActionProposals, creation snapshots, and transition histories in the redacted
Thread export and deletes them atomically with their owning Thread. Approval
and receipt descendants follow the same transaction. See
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md). Approval decisions
and external execution remain later work.

## Verification

`tests/draft-action-state.test.mjs` and `tests/storage-sqlite.test.mjs` cover:

- exact create and transition replay before and after state changes;
- restart recovery of Draft revisions, proposals, and transition history;
- Persona, Work Item, Draft, digest, chronology, and stale-state failures;
- rejection of approval and execution states without evidence;
- sequential revisions and active-Draft exclusion;
- rollback after an injected interruption between transition history and the
  current projection update;
- closed handles, accessor rejection, and payload-free errors;
- absence of approval records and external action receipts.
