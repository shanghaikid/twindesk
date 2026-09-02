# TwinDesk Harness Profile

## Purpose

The Stage 0 `workbench` Profile proves that TwinDesk can compose the pinned DeepSeek Harness runtime and activate TwinDesk Host and Client plugins without changing Harness core. The Bundle contributes two Agent Presets and a read-only Codex specialist provider; the plugins contribute synthetic read-only Tools, one non-secret setting, one browser diagnostic card, and one static Inbox extension spike for compatibility testing. The Profile now also owns the separate product Web and model-Draft runner through a disposable Cordis plugin. It adds local Draft persistence but no external Connector, filesystem mutation Tool, approval authority, or external write.

## Composition

The generated Profile applies these Bundle layers in order:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`
3. `@twindesk/bundle-workbench`

The TwinDesk Bundle declares `dsh.bundle.patch` in its package manifest. Its patch inserts the dedicated `twindesk-codex-readonly` provider, `twindesk-work-hub`, `twindesk-workbench-runtime`, and `twindesk-ui`. `@deepseek-ai/dsh-subagent-codex`, `@twindesk/harness-adapter`, `@twindesk/plugin-work-hub`, and `@twindesk/plugin-ui` are formally installed dependencies. The upstream Codex Bundle patch is deliberately not composed, so it cannot add a second default provider outside the TwinDesk safety configuration. The Work Hub Host plugin waits for the Harness settings and Tool registries, and both contributions are owned by its disposable lifecycle. The Workbench runtime waits for the Agent, Session, persistence, Preset, and LLM services, then owns product Web startup and shutdown. The UI Host entry is intentionally empty; its installed package metadata enrolls the browser half through Harness's `dsh.client` discovery contract.

## Read-Only Status Tool

The Host plugin registers `twindesk_status` through the adapter-owned Harness boundary. It accepts no arguments and returns this structured value:

```json
{
  "product": "TwinDesk",
  "roadmapStage": 0,
  "autonomyMode": "draft_only",
  "ready": true
}
```

The default value is fixed at build time. Invocation checks the Harness cancellation signal and performs no network or filesystem operation. The adapter declares the Tool concurrency-safe because it does not mutate state. Its output reads the in-memory settings snapshot described below.

`pnpm test` builds the workspace, then runs a keyless deterministic Agent adapter through the published Harness packages. The test verifies model-visible registration, direct structured output, pre-dispatch cancellation, an Agent-owned `tool/call` and `tool/result` Session trace, and removal after the Host plugin is disposed.

## Work Hub Settings

The Host plugin owns the `twindesk-work-hub` settings namespace. Its Stage 0 schema contains one non-secret live setting:

| Field | Type | Default | Effect |
|---|---|---|---|
| `includeRoadmapStage` | boolean | `true` | Include `roadmapStage` in later `twindesk_status` results. |

The base Profile's supported file provider persists the user layer in `settings.yaml`. The plugin reads only Harness's resolved in-memory snapshot, so a Tool invocation does not perform a file read. Setting the field to `false` removes `roadmapStage` from subsequent results and survives a provider restart.

Schemastery preserves unknown object fields by default. The adapter therefore adds an owner validation rule that accepts only `includeRoadmapStage`; undeclared fields are rejected before persistence, and the rejection text contains neither the untrusted field name nor its value. The namespace declares no credential or secret field. Browser-facing verification uses Harness's mandatory `describe({ redactSecrets: true })` projection immediately after a rejected write and again after restart, and checks the schema, resolved value, user layer, persisted document, and rejection diagnostic for a synthetic secret marker.

## Agent Presets

The Bundle owns two versioned Preset compositions:

| Preset ID | Persona behavior | Preset-scoped Skill | Additional Preset-scoped Tool |
|---|---|---|---|
| `twindesk-technical-lead` | Evidence, compatibility risk, reversibility, and a recommended decision | `technical-risk-review` | `twindesk_technical_context`, foreground `subagent_codex` |
| `twindesk-communication` | Concise stakeholder draft that preserves uncertainty and states the next update | `stakeholder-update` | None |

Both Presets also see the Host-level read-only `twindesk_status` Tool and the Harness `skill` Tool. Their Skill providers disable default roots, so the compatibility result is not affected by machine-local Skills. Neither composition includes a Harness shell, filesystem mutation, connector, approval, or external-write Tool. The technical Preset's Codex child uses a separate native read-only sandbox and does not inherit the parent Tool registry. Persona instructions require draft-only output and prohibit claiming that a message was sent or an action was executed. These identity and behavior instructions do not grant authority; future Policy and approval layers remain separate.

The compatibility test mounts the published Loader, Agent Preset, scoped registry, Persona, Skill filesystem, and Skill Tool packages against the exact Harness pin. A deterministic keyless adapter gives both Presets the same synthetic release-delay request. It verifies distinct system prompts, exact Tool and Skill visibility, distinct draft responses, correct preset identity, and independent Agent disposal. The test performs no model, network, filesystem mutation, or external-service call.

Harness `0.1.1-rc.2` lets its CLI configure only the shipped system Preset root plus the Harness-home user root; an external Bundle cannot append its own system root through the current Profile patch. Profile preparation therefore copies these versioned compositions into `$DSH_HOME/.agent-presets`, which is the supported discoverable root. It copies only a missing directory, validates an existing copy byte-for-byte, rejects links and special files, and refuses to overwrite divergent content. This is a Stage 0 deployment workaround, not a product Persona storage design.

## Codex Specialist

Profile preparation installs the exact Codex provider dependency and creates
an isolated `$DSH_HOME/twindesk-codex-readonly/config.toml` containing native
`approval_policy = "never"` and `sandbox_mode = "read-only"`. The technical
Preset exposes only a foreground one-shot delegation Tool. The communication
Preset exposes none. Harness rejects unsupported numeric depth and Tool-filter
options before starting this out-of-process provider; the Profile records the
remaining limit honestly as `maxDepth: provider-managed`. See
[`CODEX_SUBAGENT_SPIKE.md`](CODEX_SUBAGENT_SPIKE.md) for the real-process test,
authority analysis, cancellation behavior, and production gaps.

## Session Persistence

The pinned base Bundle mounts `@deepseek-ai/dsh-session-persistence-jsonl` as
the authoritative Session backend under the Harness home's `sessions`
directory. TwinDesk keeps that default for the Stage 0 spike. The SQLite
session-query plugin is a disposable full-text projection and is mounted with
`openAt: never`; it is not a second authoritative Session store.

The adapter-owned recovery probes write a synthetic technical-lead Session
containing user and assistant messages plus a successful `twindesk_status`
Tool call. It flushes the durable boundary, disposes the complete Host
composition, and starts a new composition over the same root. Recovery reads
the stored Preset identity before mounting its Persona, Skill, and Tool scope.
Each probe repeats this cold restart and compares the complete message and Tool
event projections. One runs the Profile's default Zstandard encoding and chunk
packing. A second injects an incomplete final raw JSONL record and checks that
resume repairs the tail without duplicating committed events or requesting
another model generation.

The torn-tail case uses a separate fresh root with `compression: 'none'` and
chunk packing disabled only so it can inject and then inspect a deterministic
byte tail. The Session persistence service, event validation, recovery
coordinator, and resume path are otherwise the pinned production
implementations. See
[`SESSION_PERSISTENCE_SPIKE.md`](SESSION_PERSISTENCE_SPIKE.md) for the decision,
evidence, and retention review.

## Client Diagnostic Card

`@twindesk/plugin-ui` declares a Web `dsh.client` entry with explicit graph edges to Harness's conversation, plugin-settings, and sidebar surfaces. Its browser half registers a small read-only card under the `twindesk-work-hub` namespace. The card says that the Client plugin loaded and performs no reads or writes.

Harness `0.1.1-rc.2` does not publish its internal Client build preset. TwinDesk therefore owns a deliberately narrow builder that emits the required lazy-CJS `window.__ModuleLoader__.load(...)` factory, leaves React on Harness's shared module table, rejects unsupported runtime imports, and emits a source map with embedded TypeScript source. Missing or malformed artifacts fail before Profile launch with the instruction to run `pnpm run build`; Harness also retains its own fail-loud bundle-composition diagnostics.

## Inbox Extension Spike

The same external Client package adds an Inbox footer action and a static empty page. The action owns the `#/inbox` browser hash because Harness exposes no public Router. While that route is active, the plugin uses the public single-slot priority contract to shadow `conversation`; leaving the route or disposing the plugin removes that registration and restores the shipped conversation surface. The exact extension contracts and remaining primary-navigation gap are recorded in [`INBOX_EXTENSION_SPIKE.md`](INBOX_EXTENSION_SPIKE.md).

The Profile is generated under `.twindesk/harness` and is ignored by Git. Set `TWINDESK_HARNESS_HOME` to an absolute or repository-relative path to isolate another generated Harness home. Do not point this variable at a Profile containing user data unless replacing its generated `workbench` Profile is intended.

## Prepare and Inspect

Install the frozen workspace dependencies and build the workspace first:

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 run build
```

Prepare the local Profile through Harness's supported plugin-management command:

```sh
corepack pnpm@11.7.0 run profile:prepare
```

The preparation command pins the child plugin installation to pnpm 11.7.0 and the repository-local `.pnpm-store`, verifies the Client artifacts, installs the exact Codex provider plus local links for the Bundle and both plugins, materializes matching Agent Presets without overwriting local divergence, creates the fail-closed native Codex safety configuration, and writes the ordered Bundle list. Re-running it is idempotent for the same repository and Harness home.

Dump the effective configuration without booting the Profile:

```sh
corepack pnpm@11.7.0 run profile:config
```

The dump must contain a final `@twindesk/bundle-workbench` layer with the single
`twindesk-codex-readonly` provider plus the `twindesk-work-hub`,
`twindesk-workbench-runtime`, and `twindesk-ui` entries. It must not contain the optional upstream Bundle's default `codex`
provider. Harness produces this dump with the same patch composition algorithm
used during boot.

## Launch and Smoke Test

Start the Web Profile without browser handoff:

```sh
corepack pnpm@11.7.0 run profile:start -- --port 3080
```

The default bind address for both listeners remains `127.0.0.1`. The Harness UI uses the supplied `--port`; the product Web defaults to port `4173` and reports its URL separately. Stop the process with `Ctrl-C`; Cordis awaits product Web and SQLite shutdown.

Run the automated composition and startup smoke test with:

```sh
corepack pnpm@11.7.0 run profile:check
```

Run this smoke test together with every other selected Harness boundary using:

```sh
corepack pnpm@11.7.0 run compat:check
```

The complete manifest and failure contract are documented in
[`HARNESS_COMPATIBILITY_SUITE.md`](HARNESS_COMPATIBILITY_SUITE.md).

The smoke test checks all dumped TwinDesk entries, creates a temporary product home and database, and starts the Harness and product listeners on independent operating-system-selected loopback ports. It loads the Harness production index twice, verifies a stable TwinDesk row in `__DSH_BOOT__`, fetches the bundle and source map, verifies the product's minimized model-Draft capability, and requests normal shutdown. Temporary product data is then removed. A separate bundle execution test materializes the factory across clean and direct-Inbox routes and verifies card and sidebar registration, page switching, restoration, disposal, listener cleanup, and reload isolation. The checks do not open a browser, resolve a provider credential, or invoke an Agent. Sandboxed development environments must permit loopback binding for this check.

## Current Limitations

- The TwinDesk packages remain private Stage 0 workspaces and are linked from the generated Profile rather than published to a registry.
- The status Tool is a compatibility probe, not a live health check; it does not inspect connectors, storage, models, or external services.
- The Work Hub namespace, Client card, and empty Inbox are compatibility diagnostics; they are not product settings or a data-backed Inbox.
- The generated Preset copies currently use Harness's user-trust root because the pinned CLI does not expose an external system-root extension. Product Persona authoring, upgrade, and conflict handling remain Stage 1 work.
- Harness exposes no public Router or primary sidebar navigation list. The plugin owns `#/inbox` and mounts its supported additive entry in the sidebar footer. [ADR 0002](decisions/0002-twindesk-owned-product-web-shell.md) keeps this path as a diagnostic and assigns product routing to `@twindesk/web`.
- The external Client builder covers one source module and the shared React runtime only because the upstream preset is not published.
- JSONL Session artifacts can contain user text, model output, and Tool data. The Stage 0 probe uses synthetic temporary data; product retention, redacted export, deletion, encryption-at-rest expectations, and format migration remain unresolved before Stage 1 persistence work.
- The Codex provider cannot enforce Harness numeric depth or Tool-filter options in this pin. `provider-managed` is a recorded Stage 0 limitation; TD-404 must add native child-runtime budgets before production use.
- Profile state and the default developer TwinDesk database under `.twindesk/` are not supported production user-data locations.
