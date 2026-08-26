# Persona to Harness Preset Mapping

TD-107 adds a fail-closed mapping from TwinDesk's two installed, versioned
Persona configurations to the pinned Harness Agent Presets. It does not create
a general dynamic Preset generator.

## Boundary

```text
versioned built-in Persona configuration
  -> exact configuration validation
  -> fixed installed Preset ID and observable composition
  -> Harness adapter / Agent Preset registry

Policy, credentials, Connector scopes, and approvals
  -> separate boundaries; never produced by this mapping
```

The mapping lives in `@twindesk/plugin-work-hub` and returns TwinDesk-owned
strings and records. It does not import Harness types or lifecycle APIs. The
existing adapter remains responsible for exercising the pinned Harness Preset
registry.

## Installed mappings

| Persona ID | Harness Preset | Skill | Model-facing Tools |
|---|---|---|---|
| `technical-lead` | `twindesk-technical-lead` | `technical-risk-review` | `skill`, `subagent_codex`, `twindesk_status`, `twindesk_technical_context` |
| `communication` | `twindesk-communication` | `stakeholder-update` | `skill`, `twindesk_status` |

The technical Persona's Codex Tool remains the already validated foreground,
read-only specialist. Neither mapping contains a Connector, credential, shell,
filesystem mutation, approval, or external-write Tool.

Each result states `authorityEffect: none`, `externalWritesAvailable: false`,
and `autonomy: draft_only`. These are enforced constraints and observations,
not permissions granted by Persona selection. Any future external action must
still pass the separate Policy and one-time approval path.

## Fail-closed behavior

Version 1 accepts only the complete installed configuration shape. It rejects:

- unsupported versions or Persona IDs;
- unknown or missing fields;
- accessors, symbols, and non-plain objects;
- changes to the installed mission, tone, output preference, or Preset profile;
- autonomy above `draft_only`;
- injected Tool, permission, credential, or Connector-scope fields.

Diagnostics name only the error category and never serialize rejected values.
The Harness composition test uses the mapped Preset IDs and compares the
actual model-facing Skills and Tools with the mapping declaration.

## Limitations

- User-created Personas and dynamic Preset materialization are not implemented.
- Changing a built-in Persona requires a versioned source change to both its
  configuration and installed Preset composition; silent runtime divergence is
  rejected.
- Model and reasoning-effort selection, memory policy, budgets, data-source
  access, and Team templates remain future work.
