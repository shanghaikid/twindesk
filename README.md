# TwinDesk

TwinDesk is a local-first personal work agent console. It brings information from Feishu, Jira, and other work systems into a unified Inbox, where multiple configurable work personas can understand context, prepare replies, advance tasks, and act within explicit permission boundaries.

> TwinDesk is a working name and has not yet undergone trademark or domain-name clearance.

## Product Positioning

TwinDesk is not an auto-reply bot or another general-purpose chat window. It is a user-controlled work console that:

- collects and organizes Feishu messages, document mentions, Jira issues, and comments;
- configures Personas, Skills, tool permissions, and memory scopes for different work identities;
- uses a single Agent for simple tasks and can dynamically assemble an Agent Team for complex work;
- produces drafts by default and executes external writes only after approval;
- stores sources, context, drafts, approvals, tool calls, and final outcomes locally;
- keeps the Agent Runtime, models, and external connectors replaceable.

## Current Technical Direction

The first version will be built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) using a plugin-first strategy:

- DeepSeek Harness provides the Agent Loop, Sessions, Skills, Subagents, Workflows, approvals, and Web UI;
- TwinDesk provides the Work Inbox, external event model, Persona experience, business audit trail, and retention policies;
- Feishu and Jira are implemented as independent Connector plugins;
- Agent Session logs and TwinDesk business data are stored separately;
- the product domain model is not coupled to DeepSeek, Codex, or any single model provider.

DeepSeek Harness is still in developer preview, so the integration layer must pin a compatible version and remain isolated from TwinDesk domain code.

## Documentation

- [Product Goals](docs/PRODUCT_GOALS.md): vision, user journeys, scope, acceptance criteria, and non-goals.
- [Architecture](docs/ARCHITECTURE.md): plugin boundaries, data boundaries, event flow, security model, and technical risks.
- [Roadmap](docs/ROADMAP.md): delivery sequence from technical validation to a usable MVP.
- [TODO](TODO.md): current execution checklist, dependencies, completion checks, and gated backlog.
- [Harness Version](docs/HARNESS_VERSION.md): current exact upstream pin, toolchain requirements, and upgrade procedure.
- [Harness Profile](docs/HARNESS_PROFILE.md): Stage 0 Profile composition, local launch, and configuration inspection.

## Current Status

The project is in Roadmap Stage 0, validating DeepSeek Harness compatibility.
The reproducible monorepo scaffold is available, but product behavior has not
been implemented.

## Development

TwinDesk uses Node.js 24 and pnpm 11.7.0. From a clean checkout, install the
exact dependency graph and run every scaffold check with:

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 run check
```

The combined check covers formatting, TypeScript validation, unit tests, all
project-reference builds, the built Harness adapter boundary, a real Harness
Profile startup, and repository structure. The Profile smoke test binds only a
temporary loopback port and does not call a model or external service.

Prepare and inspect the generated local Profile with:

```sh
corepack pnpm@11.7.0 run build
corepack pnpm@11.7.0 run profile:prepare
corepack pnpm@11.7.0 run profile:config
```

Start the Web Profile without automatically opening a browser:

```sh
corepack pnpm@11.7.0 run profile:start -- --port 3080
```

Generated Harness state stays under the ignored `.twindesk/` directory.
