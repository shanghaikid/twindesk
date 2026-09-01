# ADR 0004: Feishu OAuth Recovery Journal Path

- Status: Accepted
- Date: 2026-09-01
- Decision owner: TwinDesk maintainers
- Tracker: TD-209

## Context

Feishu User token rotation and blocked-state reauthorization already use an
append-only, secret-free journal, but production composition still required an
arbitrary injected path. The product cannot truthfully present restart-safe
reauthorization or Keychain reconciliation until every Workbench process opens
the same private journal outside the checkout.

The journal is operational recovery state, not user-editable Connector
Settings, Harness Session history, or TwinDesk business data.

## Decision

The macOS Workbench data-root contract advances to version 2 and reserves:

```text
~/Library/Application Support/TwinDesk/state/connectors/feishu/oauth-rotation.jsonl
```

The stable filename does not encode the current event schema version. Each
journal event remains independently versioned, and the existing journal reader
owns compatible version 1 to version 2 recovery. Future schema upgrades must be
forward and must not depend on deleting or renaming away unresolved evidence.

`openWorkbenchFeishuSettingsStores()` prepares both the Settings and state
branches, checks every product-owned directory for effective-user ownership,
exact `0700` mode, and observed symlinks, then returns the concrete rotation
journal with the two Connector Settings stores. The existing journal keeps
`0600`, `O_NOFOLLOW`, bounded append, fsync, torn-tail repair, and transition
validation responsibility.

The journal stores sequence, state, and timestamps only. Credentials, tokens,
client secrets, principals, application IDs, SecretReferences, OAuth codes,
PKCE values, external content, and filesystem paths must not enter its events
or presentation APIs.

## Consequences

- Initial authorization, future reauthorization, rotation, and reconciliation
  can share one deterministic restart-safe recovery boundary.
- Recovery state remains separate from editable Settings and business Audit.
- Creating the default Workbench stores now prepares a private `state` branch
  even before the first journal event is written.
- A separate presentation boundary now exposes only a five-state minimized Web
  projection. This decision still does not construct a hosted reauthorization
  or reconciliation action or claim that a Keychain write was reconciled.
- Other production state, SQLite, Harness Session, and non-macOS paths remain
  separate decisions.

## Verification

Path tests cover the exact version 2 layout, private Settings and state
directories, state-branch symlink rejection, append and restart inspection,
and absence of secret-like fields. Existing journal tests continue to cover
torn tails, unsafe files, transition ordering, migration, and recovery.
Presentation tests additionally prove that sequence, timestamps, identifiers,
and filesystem paths do not cross the Web boundary.
