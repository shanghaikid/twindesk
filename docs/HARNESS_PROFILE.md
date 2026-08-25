# TwinDesk Harness Profile

## Purpose

The Stage 0 `workbench` Profile proves that TwinDesk can compose the pinned DeepSeek Harness runtime and activate a TwinDesk Host plugin without changing Harness core. The plugin contributes one synthetic read-only Tool for compatibility testing. It does not add external connectors, filesystem tools, or external writes.

## Composition

The generated Profile applies these Bundle layers in order:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`
3. `@twindesk/bundle-workbench`

The TwinDesk Bundle declares `dsh.bundle.patch` in its package manifest. Its patch inserts the `twindesk-work-hub` row, which loads `@twindesk/plugin-work-hub` as a formally installed Profile dependency. The Host plugin waits for the Harness Tool registry and owns its contribution through a disposable lifecycle effect.

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

The value is fixed at build time. Invocation checks the Harness cancellation signal and performs no network or filesystem operation. The adapter declares the Tool concurrency-safe because it has no mutable or external state.

`pnpm test` builds the workspace, then runs a keyless deterministic Agent adapter through the published Harness packages. The test verifies model-visible registration, direct structured output, pre-dispatch cancellation, an Agent-owned `tool/call` and `tool/result` Session trace, and removal after the Host plugin is disposed.

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

The preparation command pins the child plugin installation to pnpm 11.7.0, installs local links for the Bundle and Host plugin, and writes the ordered Bundle list. Re-running it is idempotent for the same repository and Harness home.

Dump the effective configuration without booting the Profile:

```sh
corepack pnpm@11.7.0 run profile:config
```

The dump must contain a final `@twindesk/bundle-workbench` layer with the `twindesk-work-hub` entry. Harness produces this dump with the same patch composition algorithm used during boot.

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

The smoke test checks the dumped entry, starts the Profile on port `0` so the operating system selects an available loopback port, waits for the Harness URL readiness line, and requests normal shutdown. It does not open a browser or invoke an Agent. Sandboxed development environments must permit loopback binding for this check.

## Current Limitations

- The TwinDesk packages remain private Stage 0 workspaces and are linked from the generated Profile rather than published to a registry.
- The status Tool is a compatibility probe, not a live health check; it does not inspect connectors, storage, models, or external services.
- The Host plugin exposes no settings yet; TD-022 owns that check.
- Client plugin loading is not covered until TD-030.
- Profile state under `.twindesk/` is disposable compatibility-test data, not a supported user-data location.
