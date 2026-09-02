# Harness Model Draft Runtime

## Scope

TwinDesk now composes the pinned Harness Agent lifecycle with the Work Hub
model-Draft persistence protocol. `createHarnessModelDraftRunner()` owns all
Harness-specific types and lifecycle calls. `createWorkHubHarnessModelDraftOperation()`
maps one installed Persona to its immutable Agent Preset, invokes the runner,
and persists only the bounded visible result as a local `editing` Draft plus
the existing business Audit.

The separate Workbench product entry now calls this boundary from a strict
Work Item-only browser intent. This runtime still does not select or credential
a production model provider, grant a Tool, create an ActionProposal, request
approval, or perform an external write. Persona selection changes behavior
only; it does not change authority.

## Durability ordering

The runner uses the pinned public APIs in this order:

```text
validate Work Item, Persona, request, and deterministic Session identity
  -> create Harness Agent with the mapped Agent Preset
  -> submit one identified user message
  -> await Agent idle and a completed turn
  -> require SessionStore.flush() participation and success
  -> dispose the live Agent
  -> inspect the Session again from cold persistence
  -> validate exact prompt, Preset, provider/model provenance, turn/end, and visible text
  -> return opaque Session ID, TwinDesk run ID, text, and completion time
  -> create the local editing Draft
  -> append the deterministic business Audit
```

`whenIdle()` alone is not treated as durability evidence. Cold inspection is
deliberately performed only after Agent disposal because the pinned
`SessionPersistence.inspect()` contract may return a live in-memory snapshot
while the Session is attached.

The TwinDesk run identity is deterministically derived as
`<session-id>:turn-1`. It identifies the single completed turn represented by
the Draft; it is not an upstream Harness type or an authority token.

## Recovery and failure behavior

Before creating an Agent, the runner lists durable Sessions. An exact existing
Session is validated against the requested Preset, prompt, provider/model
provenance, one completed turn, and bounded plain visible text. Exact replay
returns `recovered` without a model call. A partial, cancelled, failed,
max-token, multiply-driven, identity-conflicting, or non-text Session fails
closed and is never silently rerun.

A Session still present in the live Agent Registry is never accepted as
recovery evidence, even if its turn appears complete in an in-memory
`inspect()` view. Concurrent retries therefore cannot cross the durability
boundary during the interval between `whenIdle()` and `flush()`.

The Work Hub operation selects `recover_only` whenever its Draft identity is
already present. If that Draft's Session is missing, recovery fails instead of
authorizing a replacement model call. This remains true after the Draft has
advanced state or the Work Item's selected Persona has changed; exact replay
may repair missing Audit evidence but cannot generate a new result under stale
selection.

This recovery closes the crash window between Harness durability and TwinDesk
Draft creation. A later retry can recover the exact model result, idempotently
create the Draft, and repair a missing business Audit without calling the model
again. Cancellation before TwinDesk persistence creates no Draft; a Session
that became durable first remains recoverable by a later explicit retry.

## Privacy and limitations

The prompt and model transcript remain in the separate Harness Session store.
TwinDesk SQLite receives only the bounded visible Draft text, optional
user-visible rationale, opaque Session/Run references, and payload-free Audit
metadata. Reasoning blocks, Tool calls/results, provider identity, prompt, and
model output are not copied into Audit. Hidden chain-of-thought is never copied
into the Draft.

Synthetic tests use the real pinned Agent, Preset, Agent Loop, Session Store,
and JSONL persistence with a deterministic keyless LLM adapter. They verify one
model call, durable cold inspection, cold-Host recovery with zero model calls,
empty-output refusal, installed-Persona mapping, target preflight, cancellation,
malformed result rejection, local Draft/Audit persistence, and Audit privacy.
They do not prove a live provider, real Feishu message, credential-healthy
Cordis lifecycle, or authorized external send. The product-entry contract and
its Host-owned provider/model route are covered separately by
[Workbench Model Draft Product Entry](WORKBENCH_MODEL_DRAFT_PRODUCT_ENTRY.md).
