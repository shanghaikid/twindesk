# Local Audit Timeline

TD-109 implements the local, user-visible business timeline without merging
TwinDesk business storage with the Harness Session store. It introduces no
external write, approval decision, credential, model call, or hidden reasoning
persistence.

## Record and store boundary

`AuditRecord` remains a versioned domain record with an attributable actor,
category, outcome, user-visible summary, structured details, references, and a
canonical occurrence time. The TwinDesk SQLite store owns the Audit record and
its reference index. Records are immutable; explicit future retention and
Thread deletion may remove them transactionally.

References can link a record to:

- a stable Connector identity for global maintenance and recovery history;
- ExternalEvent, ExternalThread, WorkItem, and ConnectorCursor;
- Draft, ActionProposal, ApprovalRecord, and ActionReceipt;
- Harness Session, Run, and Tool-call identities.

The last group is deliberately opaque. TwinDesk stores only the identifiers
needed to associate a business decision with runtime evidence. It does not
copy Harness messages, prompts, model output, Tool arguments, Tool results, or
Session events into the business database. A runtime reference must include a
WorkItem; a Run must also include a Session, and a Tool call must include a Run.
A Connector reference is an intrinsic typed identity rather than a foreign key
to a local entity table. It does not by itself associate the record with a
Thread; Thread export and deletion include only Audit records connected through
Thread-owned references.

## Append and reference rules

`TwinDeskDatabase.appendAuditRecords()` validates the complete version 1 input
before writing and uses one `BEGIN IMMEDIATE` transaction for the batch.

- A new identity is inserted with its ordered references.
- An exact semantic replay is reported as a duplicate, including after restart.
- Reusing an identity for different content fails the whole batch closed.
- Local references must exist and may not predate the referenced record; an
  ExternalEvent uses its durable local receive time, not only its source time.
- WorkItem-owned child records must match an explicit WorkItem reference;
  unprojected Events or Threads cannot be presented as linked to one.
- An interrupted reference insert rolls back its Audit record and the rest of
  the batch.
- SQLite schema Migration 7 admits only the documented reference kinds and
  prevents older builds from opening a database that may contain Connector
  references they cannot parse.

Approval and receipt references are supported when those records exist, but
TD-109 does not itself implement approval decisions or Connector execution.
TD-206 now owns ApprovalRecord decisions and one-time consumption; callers must
still append their user-visible approval Audit records through this timeline.
TD-207 owns Feishu execution and normalized receipt persistence but likewise
does not append Audit records automatically; TD-209 must preserve execution and
reconciliation history here while the receipt projection advances.
Migration 8 now provides an atomic Connector maintenance request/result Audit
protocol and restart-visible pending state. The Workbench Feishu composition
now binds it to current rotation-journal evidence and repairs interruption
without repeating the local reconciliation effect. See
[Connector Maintenance Audit Protocol](CONNECTOR_MAINTENANCE_AUDIT.md).
The Work Hub model Draft linkage now also records a complete opaque
WorkItem -> Session -> Run chain after the caller has durably flushed Harness,
with exact replay repairing a missing Audit without repeating a model Run. See
[Model-Backed Draft Linkage](MODEL_BACKED_DRAFT_LINKAGE.md). The tests use
synthetic rows and cause no external side effect.

## Queries and presentation

`queryAuditTimeline()` reads a consistent SQLite snapshot and supports exact
WorkItem or reference filters, category and outcome filters, a bounded limit,
and stable descending chronological keyset pagination. Equal instants with
different valid timestamp precision remain deterministic through timestamp
text and record identity tie-breakers.

The loopback-only Web API exposes a narrower version 1 projection. It returns
only category, outcome, actor type, a safe actor label, summary, reference
kinds, and occurrence time. It omits Audit IDs, referenced IDs, actor IDs,
details, external account or object IDs, and runtime payloads. The browser
rejects malformed or unsupported responses before rendering and escapes all
returned strings.

The current Audit page shows four synthetic `routing` records, one for each
fixture WorkItem, plus two Persona-attributed `draft` records from the
deterministic Stage 1 fixture flow. They demonstrate durable restart and UI
behavior only; they do not claim that a model or Persona Run, approval, Tool
call, or external action took place.

## Privacy and remaining work

Audit summaries and details may eventually contain authorized company or
personal data. They stay inside the TwinDesk business store and are never
included in validation error messages. The TD-110 shared redactor now removes
them from logs, errors, and telemetry; an authorized model-context or export
policy may retain necessary business text while still removing credentials,
secret locators, and hidden reasoning. The current presentation-safe Audit API
continues to use its narrower explicit projection. TD-111 includes related
business Audit records in an authorized Thread export and deletes Thread-owned
Audit records atomically with the Thread. Session, Run, and Tool-call links
disappear from TwinDesk with their owning records, while the separate Harness
Session store is unchanged. New Audit records cannot span Work Items from
multiple Threads; an older cross-Thread record makes export or deletion fail
closed rather than leaking or silently removing another Thread's history. See
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md). Hidden
chain-of-thought must never be stored.

The fixture Inbox → Persona → Draft → Audit path now satisfies the
[Stage 1 exit gate](STAGE_1_EXIT_GATE.md). Its Draft Audit entries deliberately
omit Session and Run references because deterministic fixture generation does
not invoke Harness or a model. The separate model Draft linkage protocol accepts
those references but does not yet invoke Harness itself.

## Verification

The domain, storage, fixture, browser-contract, and Web server tests cover:

- strict actor and reference validation;
- idempotent replay, conflicts, restart recovery, filtering, and pagination;
- missing, cross-WorkItem, incomplete runtime, and impossible-time references;
- Draft, ActionProposal, ApprovalRecord, and ActionReceipt resolution;
- Connector-only persistence, restart replay, exact-reference queries, and
  exclusion from unrelated Thread export and deletion;
- transaction rollback under an interrupted reference write;
- immutable records and references, closed handles, and payload-free errors;
- presentation omission, malformed API responses, HEAD behavior, method
  rejection, and loopback-only serving.
