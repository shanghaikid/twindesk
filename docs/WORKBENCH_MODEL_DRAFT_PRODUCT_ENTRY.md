# Workbench Model Draft Product Entry

## Scope

TwinDesk now has a product-owned entry for creating one local model-backed
Draft from an Inbox Work Item. The browser can submit only the version and the
opaque Work Item ID. The Workbench Host resolves the persisted Work Item,
selected built-in Persona, pinned Agent Preset, prompt, deterministic
Session/Draft identities, and configured provider/model route.

This entry creates or recovers a Draft. The separate
[local editing boundary](WORKBENCH_MODEL_DRAFT_EDITING.md) now creates revisioned
user edits and `ready_for_review` state, but neither path constructs an
ActionProposal, requests approval, calls a Connector, or performs an external
write. The returned capability and result both state `draft_only`; a result
also states that external writes are unavailable.

## Request boundary

The loopback API exposes:

- `GET /api/model-drafts`, which returns only version, `ready` or `unavailable`,
  and `draft_only`;
- `POST /api/model-drafts/create`, which accepts exactly `{ version,
  workItemId }` behind the bound Host, Origin, Fetch Metadata, process-local
  CSRF token, exact JSON media type, and a 1 KiB declared-body ceiling.

Provider, model, prompt, Persona, Preset, runtime identity, credentials, Tools,
policy, and autonomy are not browser fields. Unknown fields fail before the
Host service runs. The API revalidates the minimized Host result and requires
it to reference the requested Work Item before serialization.

## Host composition

`createWorkbenchModelDraftController()` accepts a TwinDesk database, the
Harness adapter runner, and a non-secret provider/model route owned by Host
configuration. It constructs a fixed instruction plus a shared-redaction pass
over bounded Work Item fields. It then delegates to the existing Work Hub
runtime and linkage boundary.

The generated Draft and business Audit remain in TwinDesk SQLite; the prompt
and runtime transcript remain in Harness Session persistence. Provider/model,
prompt, and model output are not copied into Audit. Exact replay uses the same
deterministic identities and the existing `recover_only` behavior. The product
result reports the Draft's current persisted state instead of assuming it is
still editing.

`startWorkbenchWebServer()` accepts this runtime only through an explicit
Host-side `modelDraftRuntime` option. The default standalone Web launcher does
not invent a provider connection: it advertises `unavailable` and renders a
disabled entry. The Workbench Harness Profile injects the runner and route
through the separate disposable
[Cordis runtime](WORKBENCH_CORDIS_MODEL_DRAFT_RUNTIME.md).

## Verification and limitations

Synthetic tests cover strict browser contracts, request forgery, browser field
injection, Host-owned provider/model selection, model-context redaction,
durable Draft/Audit recovery, and missing-Persona failure without a live model
or external account.

This does not prove a live production model provider. Provider credential
health, browser-refresh action restoration, polling, and live Feishu acceptance
remain open Stage 2 work.
