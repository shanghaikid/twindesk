# Workbench Local Data Paths

## Scope

`resolveWorkbenchLocalDataPaths()` defines the first production-owned local
data location for the macOS MVP. It does not touch disk. Version 2 of the path
record uses this fixed root:

```text
~/Library/Application Support/TwinDesk
```

This location is separate from the repository-local `.twindesk/` compatibility
and fixture state, which remains disposable development data. The current path
record covers two non-secret Feishu Settings documents and one secret-free
operational recovery journal:

```text
settings/connectors/feishu/identity.v1.json
settings/connectors/feishu/oauth-authorization.v1.json
state/connectors/feishu/oauth-rotation.jsonl
```

Harness Sessions and TwinDesk SQLite business data keep their existing separate
ownership boundaries. This slice does not move them or choose their eventual
production paths.

## Preparation and Safety

`openWorkbenchFeishuSettingsStores()` walks the fixed directory hierarchy one
component at a time. It rejects a symbolic link or non-directory at every
component and requires `TwinDesk` plus every product-owned descendant to have
exact mode `0700`. Every observed component must belong to the effective user;
device and inode identities are rechecked before stores are returned so a
replacement during preparation fails closed. New directories are created with
mode `0700`. The returned concrete
identity and authorization stores retain their existing `O_NOFOLLOW`, bounded
document, strict validation, private-file, atomic-replacement, and restart
semantics. The returned rotation journal retains its `0600`, `O_NOFOLLOW`,
bounded append, fsync, torn-tail repair, versioned-event, and transition
validation boundaries.

Only canonical absolute home paths are accepted. Root, relative, NUL-containing,
and lexically aliased paths fail before filesystem access. Unsupported platforms
fail explicitly instead of reusing a macOS path. The injectable platform and
home values exist for composition tests; production composition uses the Node
process platform and system home directory.

Directory and file paths may contain a local account name. They must not be
logged, audited, exported, sent to model context, or returned to browser APIs.
Neither Settings document nor the recovery journal may contain a client secret,
OAuth code, verifier, token, cookie, private key, principal, application ID, or
SecretReference. The journal contains only sequence, state, and timestamps;
credentials remain in the system Keychain.

## Verification and Remaining Work

Synthetic tests verify the exact macOS layout, deep immutability, private
directory modes, restart recovery through newly constructed stores and the
rotation journal, absence of secret-like fields, unsupported and aliased path
rejection, hostile accessor avoidance, and refusal to traverse linked or
publicly accessible Settings or state directories. The contract covers observed
preparation-time state; it is not a filesystem lock against a same-user process
that mutates directories after the stores are returned.
They use a temporary synthetic home and do not inspect or change the user's
actual Application Support directory.

Still open:

- hosted reauthorization and Keychain/rotation reconciliation actions; the
  presentation-safe read boundary is now implemented separately;
- explicit disconnect, configuration deletion, OAuth revocation, and Keychain
  deletion as separate user actions;
- product paths for SQLite business data and Harness Sessions;
- non-macOS path and secret-store decisions;
- Cordis lifecycle activation and live-account acceptance.
