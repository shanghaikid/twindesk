# Model-Backed Draft Linkage

## Scope

TwinDesk now has a Work Hub boundary for linking one completed Harness Session
and Run to one local Draft and its business Audit. This is a persistence and
recovery protocol, not yet the production model runner. Its caller must flush
the referenced Harness Session before invoking the linkage operation.

The boundary does not call a model, copy Harness events into SQLite, select a
Persona, invoke a Tool, create an ActionProposal, request approval, or perform
an external write. The resulting Draft is always `editing`, so model output
cannot bypass user review.

## Ordering and recovery

The ordering is deliberately asymmetric across the separate stores:

```text
Harness Session store
  -> durably flush Session and completed Run
  -> call Work Hub with exact Session ID, Run ID, and Draft

TwinDesk business store
  -> idempotently create the editing Draft
  -> append deterministic model-run Audit
```

The Audit references the Work Item, Draft, opaque Harness Session, and opaque
Harness Run. Existing Audit validation requires the complete
`WorkItem -> Session -> Run` chain and verifies that the Draft belongs to the
same Work Item. The Audit contains no prompt, output text, context item,
Tool argument, Tool result, model vendor, token usage, credential, or hidden
reasoning.

If the process stops after Draft persistence but before Audit persistence, the
Draft remains durable. Exact replay returns the existing Draft and appends only
the missing Audit from the original creation evidence; it remains repairable
even if the durable Draft has since advanced to a later local state. Replay does
not authorize or repeat a model invocation. Reusing the Draft or Audit identity
with different evidence fails closed.

## Input and privacy boundary

The caller supplies a version 1 Draft with both Session and Run identifiers.
Both identifiers are bounded opaque values using only letters, digits, colon,
period, underscore, and hyphen. Model output is bounded to 64 KiB of UTF-8 and
is stored only in the Draft content field. An optional rationale is bounded to
1 KiB and must be a user-visible decision summary, never hidden chain-of-thought.

The deterministic Audit records only `modelInvocation: true`, Draft revision,
and the enforced `editing` state. Normal Thread export and deletion already
include or delete the linked Draft and Audit while leaving the separate Harness
Session store unchanged.

## Verification and limitations

Synthetic tests cover exact Session/Run linkage, restart replay, Audit queries,
interruption after Draft persistence, Audit-only repair, incomplete runtime
chains, unsafe identifiers, bounded content, closed or malformed storage,
conflicting Audit evidence, hostile accessors, payload-free errors, and omission
of model output from Audit.

The pinned Harness invocation and Session-flush boundary now composes with this
protocol; see [Harness Model Draft Runtime](HARNESS_MODEL_DRAFT_RUNTIME.md). Its
tests use a deterministic keyless adapter and do not prove a live model
provider or product entry. Interactive Draft editing, exact approval UI,
production Feishu polling, and live-account acceptance remain open.
