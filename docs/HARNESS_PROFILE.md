# TwinDesk Harness Profile

## Purpose

The Stage 0 `workbench` Profile proves that TwinDesk can compose the pinned DeepSeek Harness runtime and activate TwinDesk Host and Client plugins without changing Harness core. The plugins contribute one synthetic read-only Tool, one non-secret setting, and one browser diagnostic card for compatibility testing. They do not add external connectors, filesystem tools, or external writes.

## Composition

The generated Profile applies these Bundle layers in order:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`
3. `@twindesk/bundle-workbench`

The TwinDesk Bundle declares `dsh.bundle.patch` in its package manifest. Its patch inserts `twindesk-work-hub` and `twindesk-ui`, which load `@twindesk/plugin-work-hub` and `@twindesk/plugin-ui` as formally installed Profile dependencies. The Work Hub Host plugin waits for the Harness settings and Tool registries, and both contributions are owned by its disposable lifecycle. The UI Host entry is intentionally empty; its installed package metadata enrolls the browser half through Harness's `dsh.client` discovery contract.

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

## Client Diagnostic Card

`@twindesk/plugin-ui` declares a Web `dsh.client` entry with an explicit graph edge to Harness's plugin-settings surface. Its browser half registers a small read-only card under the `twindesk-work-hub` namespace. The card says that the Client plugin loaded and performs no reads or writes; its purpose is to prove external component delivery before the Inbox extension spike.

Harness `0.1.1-rc.2` does not publish its internal Client build preset. TwinDesk therefore owns a deliberately narrow builder that emits the required lazy-CJS `window.__ModuleLoader__.load(...)` factory, leaves React on Harness's shared module table, rejects unsupported runtime imports, and emits a source map with embedded TypeScript source. Missing or malformed artifacts fail before Profile launch with the instruction to run `pnpm run build`; Harness also retains its own fail-loud bundle-composition diagnostics.

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

The preparation command pins the child plugin installation to pnpm 11.7.0 and the repository-local `.pnpm-store`, verifies the Client artifacts, installs local links for the Bundle and both plugins, and writes the ordered Bundle list. Re-running it is idempotent for the same repository and Harness home.

Dump the effective configuration without booting the Profile:

```sh
corepack pnpm@11.7.0 run profile:config
```

The dump must contain a final `@twindesk/bundle-workbench` layer with the `twindesk-work-hub` and `twindesk-ui` entries. Harness produces this dump with the same patch composition algorithm used during boot.

## Launch and Smoke Test

Start the Web Profile without browser handoff:

```sh
corepack pnpm@11.7.0 run profile:start -- --port 3080
```

The default bind address comes from the pinned Web Bundle and remains `127.0.0.1`. Stop the process with `Ctrl-C`.

Run the automated composition and startup smoke test with:

```sh
corepack pnpm@11.7.0 run profile:check
```

The smoke test checks both dumped entries, starts the Profile on port `0` so the operating system selects an available loopback port, and waits for the Harness URL readiness line. It then loads the production index twice, verifies a stable TwinDesk row in `__DSH_BOOT__`, fetches the bundle and source map through Harness's plugin routes, and requests normal shutdown. A separate bundle execution test materializes the factory twice and verifies card registration, rendering, disposal, and reload isolation. The checks do not open a browser or invoke an Agent. Sandboxed development environments must permit loopback binding for this check.

## Current Limitations

- The TwinDesk packages remain private Stage 0 workspaces and are linked from the generated Profile rather than published to a registry.
- The status Tool is a compatibility probe, not a live health check; it does not inspect connectors, storage, models, or external services.
- The Work Hub namespace and Client card remain compatibility diagnostics; they are not product settings or an Inbox surface.
- The external Client builder covers one source module and the shared React runtime only because the upstream preset is not published. TD-031 owns the decision about the larger Inbox surface and any additional extension requirements.
- Profile state under `.twindesk/` is disposable compatibility-test data, not a supported user-data location.
