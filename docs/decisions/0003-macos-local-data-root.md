# ADR 0003: macOS Local Data Root

- Status: Accepted
- Date: 2026-09-01
- Decision owner: TwinDesk maintainers
- Tracker: TD-209

## Context

The Feishu identity and OAuth authorization stores are restart-safe, but their
callers previously had to choose arbitrary file paths. The repository-local
`.twindesk/` directory belongs to compatibility tests and fixture development;
product settings stored there could be deleted with a checkout, accidentally
committed, or confused with Harness state. The macOS MVP also needs a stable
location before the product Settings UI can read and edit configuration.

## Decision

The macOS Workbench composition root owns this default product data root:

```text
~/Library/Application Support/TwinDesk
```

Versioned non-secret Feishu identity and OAuth authorization documents live
under `settings/connectors/feishu/`. The composition root constructs the
Connector-owned stores; it does not move their validation or persistence logic
out of `@twindesk/plugin-feishu`.

Product-owned directories require effective-user ownership and exact private
mode. Observed symbolic links and preparation-time directory replacement fail
closed; this does not claim to lock the tree against later same-user mutation.
The resolver supports only macOS until another platform receives an explicit
data-root and secret-store decision. Credentials remain in Keychain and never
enter this tree.

## Consequences

- Product Settings no longer depend on the current checkout or working
  directory.
- The Web and Cordis compositions will share one deterministic configuration
  location.
- Repository-local fixture data remains disposable and cannot be presented as
  production persistence.
- Tests inject a temporary synthetic home and never write the real Application
  Support directory.
- Other production data paths and non-macOS support require follow-up decisions.
- [ADR 0004](0004-feishu-oauth-recovery-journal-path.md) extends this root with
  a separate secret-free Feishu OAuth recovery-state branch.

## Verification

Path contract tests cover exact resolution, private directory creation,
symlink and broad-mode rejection, hostile inputs, restart recovery, and absence
of credential material. Any future path migration must be forward and
non-destructive; deleting a user's existing data directory is not an upgrade
strategy.
