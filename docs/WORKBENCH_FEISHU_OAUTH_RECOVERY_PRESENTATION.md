# Workbench Feishu OAuth Recovery Presentation

## Scope

`createWorkbenchFeishuOAuthRecoveryPresentation()` is the read-only product
boundary for the default Feishu OAuth rotation journal. It converts durable
operational evidence into an exact version 1 snapshot with only:

```text
version
connectorId
state
```

The projection never returns a sequence, timestamp, application, account,
principal, SecretReference, credential, token, scope, external reference, or
filesystem path.

## State semantics

| Journal evidence | Product state | Meaning |
| --- | --- | --- |
| No event | `not_started` | No durable rotation history; not evidence that a credential is absent |
| `completed` or `reauthorized` | `ready` | No unresolved journal transaction; not a credential-health result |
| Same-process active `reserved` event | `rotation_active` | This process currently owns an in-memory reservation |
| `reauthorization_required` | `reauthorization_required` | A separate verified reauthorization action is required |
| `uncertain`, or a `reserved` event without same-process ownership | `reconciliation_required` | The Keychain and journal must be reconciled before another authorization attempt |

A reservation owned by another process cannot be proven through this
identifier-free read boundary. Treating it as reconciliation-required is the
conservative presentation. The exclusive Feishu runtime lease remains the
authority for operation ownership.

## Web boundary

Workbench injects the presenter into `@twindesk/web`; Web does not import the
Connector journal or persistence implementation. `GET` and `HEAD`
`/api/recovery/feishu/oauth` revalidate the exact minimized response and reject
queries. A missing, failed, or malformed reader returns a fixed `503` without
serializing underlying error data.

The Connectors page labels the result as OAuth recovery state. Initial
authorization stays disabled while this status is unavailable, active, or
unresolved. `not_started` and `ready` permit the existing initial-authorization
entry. The authorization-start endpoint independently reads and validates the
same status before it accepts the app-secret body or invokes the Host, so a
direct local POST cannot bypass the browser gate. `not_started` and `ready` do
not claim that a Keychain item exists, is usable, has current scopes, or can
reach Feishu. The Connector's principal-bound persistence and
credential-existence checks remain authoritative.

The presentation itself remains read-only. When and only when it reports
`reauthorization_required`, the separate product reauthorization boundary may
offer an explicit replacement action. `rotation_active` and
`reconciliation_required` expose no retry or repair action. Neither boundary
provides deletion, revocation, credential-health, or external-write authority.

## Verification and remaining work

Synthetic tests cover every minimized state, active versus restart-visible
reservations, exact browser parsing, hostile accessors, fixed API failures,
query and method rejection, default-path Web composition, and recovery-state
restart presentation. Tests use no live account, Keychain item, credential, or
external network.

Still open:

- Keychain/rotation reconciliation actions with exact confirmation and Audit
  evidence;
- credential health, scope, disconnect, revocation, and deletion flows;
- Cordis lifecycle activation and live-account acceptance.

See
[Workbench Feishu OAuth Reauthorization UI](WORKBENCH_FEISHU_OAUTH_REAUTHORIZATION_UI.md)
for the separate action boundary.
