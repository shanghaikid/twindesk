# Session Persistence Spike

## Decision

TD-041 selects the pinned Harness JSONL backend as the authoritative Stage 0
Session store. TwinDesk does not select SQLite for Session authority.

This matches the actual `@deepseek-ai/dsh-base@0.1.1-rc.2` composition: it
mounts `@deepseek-ai/dsh-session-persistence-jsonl` under the Harness home's
`sessions` directory. The adjacent `@deepseek-ai/dsh-session-query-sqlite`
service is a rebuildable full-text index. The base Bundle configures that
service with an in-memory path and `openAt: never`, so it never opens SQLite
unless a later deployment intentionally enables search.

JSONL is the narrowest useful compatibility choice because it:

- exercises the persistence backend shipped in the selected Profile;
- preserves the Harness-owned append-only Session event model without adding
  a TwinDesk schema or migration;
- durably records `agentPreset` in the Session header so resume can restore the
  same Persona and capability composition;
- exposes explicit flush, inspection, raw export, location, and cold-prepare
  seams through the published Session Persistence service; and
- has defined torn-tail repair and contiguous-sequence validation.

The choice does not make JSONL a TwinDesk domain store. External events, Inbox
state, synchronization cursors, drafts, action proposals, receipts, and
business audit records still belong in the future TwinDesk SQLite boundary.

## Compatibility Probe

The tests in `tests/session-persistence.test.mjs` use only published packages
at the repository's exact Harness pin. Each successful case performs this
sequence:

1. Boot a fresh Cordis Host composition with the JSONL backend, Agent Presets,
   scoped Persona, Skill and Tool services, and the out-of-tree Work Hub plugin.
2. Run a deterministic, keyless technical-lead turn that calls the read-only
   `twindesk_status` Tool and produces an assistant message.
3. Flush the Session and capture its persisted Preset identity, derived
   messages, Tool trace, and event sequence.
4. Dispose the Agent and every Host service so no live owner remains.
5. Boot a new Host over the same storage root. The raw-encoding case first
   appends a synthetic incomplete final record to its artifact.
6. Inspect the stored header and events, require the expected Preset identity,
   mount that Preset, resume, and flush the repaired Session.
7. Dispose and cold-start once more to prove a repaired Session remains stable.

The assertions prove that:

- both cold starts report the `resume` source and invoke no model generation;
- the technical-lead Preset identity and its exact read-only Tool scope return;
- derived messages and the successful Tool call/result pair are byte-stable
  across both restarts;
- committed event sequence numbers are contiguous;
- the first resume adds only Harness's required `session/end-seed` marker;
- the second resume adds no event; and
- the raw case's incomplete tail marker is absent after durable repair.

The probe also distinguishes the located physical artifact from the logical
raw export: default storage is `session.jsonl.zstd`, while `readRaw()` returns
decoded JSONL with the logical filename `session.jsonl`. Product diagnostics
must not treat an export filename as a deletable filesystem location.

The shipped Profile keeps the JSONL backend's default Zstandard encoding and
chunk packing, and one test exercises that exact configuration. A separate
test uses a fresh temporary root with raw UTF-8 JSONL and one-event-per-line
output only to make byte-level torn-tail injection and inspection
deterministic. Both use the same published persistence and resume services.
The pinned upstream backend rejects mixed encodings in one root; changing
encoding therefore requires a fresh root or a future explicit migration. A
third boundary test confirms that byte-tail injection fails closed unless raw
encoding is selected explicitly.

## Security, Retention, and Recovery Review

Session artifacts may contain user prompts, model output, Tool arguments and
results, approval history, and other company or personal data. They must be
treated as sensitive local user data even when the physical file is compressed.
Compression is not encryption.

The Stage 0 probe uses synthetic content only, creates its root in the system
temporary directory, and removes that root after the assertion. It writes no
credential, external identifier, company content, database, telemetry record,
or generated artifact into the repository.

The current backend has no Session deletion API and its raw export is not a
redacted product export. Before Stage 1 adopts durable user data, TwinDesk must
define and test retention, secure deletion, redacted export, diagnostic
redaction, backup behavior, encryption-at-rest expectations, and recovery from
format upgrades. Those policies belong outside Persona configuration and must
cover both Harness Session artifacts and their derived search indexes.

## Known Limits

- The spike covers orderly single-writer shutdown followed by cold restart; it
  does not authorize concurrent writers or multi-process ownership.
- It injects a torn raw final line, not filesystem loss, disk-full behavior, or
  corruption inside an already committed prefix.
- Harness's pre-release Session format is version `0` and provides no encoding
  migration. An intentional Harness upgrade must rerun this probe and supply a
  migration or explicit incompatibility decision before reading user data.
- The probe restores one top-level technical-lead Agent. Subagent and Workflow
  persistence, authority inheritance, budgets, cancellation, and attribution
  remain separate Stage 0 work.
- No TwinDesk business tables exist in this spike, so it establishes no
  migration, deletion, or export guarantee for the future business database.
