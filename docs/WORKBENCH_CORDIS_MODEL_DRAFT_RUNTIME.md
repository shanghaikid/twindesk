# Workbench Cordis Model-Draft Runtime

## Scope

The Workbench Profile now owns the product Web server and model-Draft runner
through one disposable Cordis Host plugin. This connects the existing Inbox
`Generate Draft` intent to the pinned Harness Agent, Preset, Session, and LLM
services without moving Harness types into the TwinDesk domain model.

The plugin does not add approval or external-write authority. It starts only the
local `draft_only` product entry already documented in
[Workbench Model Draft Product Entry](WORKBENCH_MODEL_DRAFT_PRODUCT_ENTRY.md).

## Lifecycle and route binding

`@twindesk/bundle-workbench/cordis-runtime` requires the Harness `agents`,
`sessions`, `sessionPersistence`, `agentPresets`, and `llm` services. Its Cordis
effect performs these steps in order:

1. validate the exact Host configuration without evaluating accessors;
2. prove that the configured provider route is registered and that the model
   resolves through the same LLM generation;
3. construct the Harness adapter runner;
4. start the product Web server with the Host-owned runner, provider, and model;
5. close the Web server, cancel active Draft requests, and close TwinDesk SQLite
   when Cordis unloads the plugin.

Route inspection performs no model call and does not resolve an API key. A
registered route therefore proves composition, not credential health or remote
availability. A missing or conflicting route fails plugin startup before the
product listener binds.

## Host configuration

The Workbench Bundle supplies developer defaults for the Profile:

- `TWINDESK_WEB_PORT` defaults to `4173`;
- `TWINDESK_DATABASE_PATH` defaults to the repository-local ignored
  `.twindesk/twindesk.sqlite3`;
- `TWINDESK_MODEL_PROVIDER` defaults to `deepseek-official`;
- `TWINDESK_MODEL` defaults to `deepseek-v4-flash`;
- `TWINDESK_HOME_DIRECTORY` defaults to the operating-system home directory and
  only affects the existing fixed Workbench local-data path resolver.

These values are Host launch configuration and never browser request fields.
The provider's API key remains in Harness's credential sources and is resolved
per model request by the provider adapter. It is not copied into TwinDesk
SQLite, Cordis configuration, Session metadata, logs, or browser responses.

The repository-local database default is a development composition, not the
final production SQLite location. Choosing the production product-data and
Harness Session paths remains a separate storage decision.

## Verification and limitations

Synthetic lifecycle tests start the product Web server on an ephemeral loopback
port, verify the minimized `ready` capability, close it through the Cordis
disposer, restart against the same database, and reject unavailable routes and
hostile configuration before listening. Adapter tests separately cover exact
route resolution, cancellation, missing routes, and payload-free errors.

The Profile smoke test now uses a temporary home, temporary TwinDesk database,
and two ephemeral loopback ports. It verifies both the Harness Client artifact
and the product model-Draft capability, then requests normal shutdown and
removes the temporary product data.

No test invokes a live model. Local editing is documented separately in
[Workbench Model Draft Editing](WORKBENCH_MODEL_DRAFT_EDITING.md). Provider
credential health, authenticated remote generation, proposal and approval UI,
production data paths, Connector polling, and live Feishu acceptance remain
open Stage 2 work.
