# Codex Subagent Spike

## Decision

TwinDesk can use the pinned Harness Codex provider as a Stage 0 repository
specialist, but only as a foreground, one-shot delegation behind a dedicated
native Codex safety configuration. This validates the extension seam; it is not
the Stage 4 production policy design.

The Profile installs `@deepseek-ai/dsh-subagent-codex@0.1.1-rc.2` directly and
the Workbench Bundle registers exactly one TwinDesk provider named
`twindesk-codex-readonly`. The provider starts the package-local official
`@openai/codex@0.147.0` wrapper. It uses:

- `permissionMode: never`, which prevents interactive approval escalation;
- an isolated `$DSH_HOME/twindesk-codex-readonly` `CODEX_HOME`;
- native `approval_policy = "never"` and `sandbox_mode = "read-only"`;
- disabled response storage and update checks;
- a foreground-only `subagent_codex` Tool exposed by the technical-lead Preset;
  the communication Preset receives no delegation Tool.

Profile preparation creates the safety directory with mode `0700` and its
configuration with mode `0600`. Existing matching content is accepted. A
symbolic link, special file, or divergent configuration fails closed and is
never overwritten. Authentication is not copied into this directory; an
operator who uses the real provider must configure native Codex authentication
for this isolated home without committing credentials.

## Compatibility Evidence

The adapter-owned test starts the real package-local Codex app server against a
loopback-only synthetic Responses endpoint. It creates a synthetic repository,
then exercises the same public Harness provider and Tool used by the Profile:

1. A deterministic Lead calls `subagent_codex` with a standalone request to
   read `README.md`.
2. Native Codex executes the advertised read command and the synthetic model
   receives the file evidence before returning the heading.
3. The foreground Tool result is recorded as the Lead's `tool/call` and
   successful `tool/result` Session trace.
4. Paired `subagent/start` and `subagent/end` events retain one run id, provider
   name, remote child id, stop reason, and final assistant text.
5. A second child attempts to create a marker. Native read-only sandboxing
   blocks the command, and no marker appears.
6. A held child is aborted through the request signal and settles with
   `stopReason: aborted`; disposal waits for process quiescence.

The fixture contains only synthetic content and credentials. It makes no
external network call and writes only inside a temporary test root.

## Authority and Budget Findings

The Codex provider is an out-of-process provider with
`inheritsParentContext: false`. It receives a standalone prompt and the parent
Session working directory. It does not inherit the Lead's Harness conversation,
Persona, Skills, Tool registry, credentials, or approval authority. Its native
Codex tool set is controlled by the isolated Codex configuration, not by the
Lead's Harness Tool registry. The compatibility test fails if the child sees the
Harness delegation Tool or collaboration tool names.

Harness `0.1.1-rc.2` truthfully reports that this provider cannot enforce the
one-shot `depthLimit` or `toolFilter` capabilities. Requests containing either
option are rejected before provider startup. A model-facing Tool configured
with a numeric maximum depth also fails to mount. `toolFilter` is therefore not
presented as an authority ceiling for native Codex Tools, and numeric depth is
not silently ignored.

For this spike, recursion is bounded structurally: the child is a fresh native
Codex process, it receives no parent Harness Tools, the technical Preset exposes
only a foreground one-shot Tool, and background/continuable execution is
disabled. Productionizing Codex in TD-404 still requires a native child-runtime
budget for delegation depth, tool calls, duration, tokens, and concurrency. If
Codex later exposes collaboration/delegation capabilities in this configuration,
TwinDesk must fail the compatibility gate until an equal-or-narrower authority
policy is proven.

Only the final child output and public lifecycle fields are attributed to the
Lead. TwinDesk does not persist hidden reasoning or raw child protocol traffic.

## Remaining Limitations

- A real run depends on separately configured Codex authentication and model
  availability; Stage 0 tests intentionally use a keyless loopback fixture.
- `provider-managed` depth is not sufficient for the Stage 4 product budget.
- Harness `toolFilter` cannot restrict native Codex Tools for this provider.
- The spike proves read-only repository inspection, cancellation, and
  attribution. It does not grant write, connector, public-representation,
  destructive, bulk, or permission-changing authority.
