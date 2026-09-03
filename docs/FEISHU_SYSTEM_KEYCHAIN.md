# Feishu System Keychain Resolution and Replacement

## Scope

TD-209 adds production credential read and replacement primitives for the
Feishu Connector. `FeishuSystemKeychainSecretResolver` resolves an already
validated Bot application-credential or User OAuth `SecretReference` from the
macOS system Keychain. It also resolves a separate `connector_api_key`
reference for the app-bound Bot event-subscription bundle.
`FeishuSystemKeychainSecretInstaller` creates one Bot application-credential
item without update mode, while `FeishuSystemKeychainSecretReplacer` replaces
only a User OAuth bundle at the same validated reference. The separate
[Feishu Credential Bundles](FEISHU_CREDENTIAL_BUNDLES.md) boundary now parses
these bytes and encodes rotated User bundles. Neither Keychain primitive
refreshes OAuth, obtains a tenant token, calls Feishu, grants a scope, or
authorizes an external write.

The fixed Keychain mapping is:

```text
generic-password service = com.twindesk.feishu
generic-password account = SecretReference.id
generic-password value   = versioned connector-owned credential bundle
```

Only `store: system_keychain` with purpose `connector_app_credential`,
`connector_oauth`, or `connector_api_key` is accepted for reads. Replacement
remains restricted to `connector_oauth`, and create-only installation is
restricted to `connector_app_credential`. Encrypted secret stores and other
purposes need separate owners and never fall back to this adapter.

## Process Boundary

The production reader invokes `/usr/bin/security` without a shell:

```text
/usr/bin/security find-generic-password
  -s com.twindesk.feishu
  -a <opaque SecretReference.id>
  -w
```

The executable, operation, service, argument order, and 64 KiB output bound are
fixed. Only the validated opaque locator becomes the Keychain account argument.
The adapter rejects non-macOS hosts before starting a process and propagates an
AbortSignal to the child process.

The production replacer invokes one exact update without a shell:

```text
/usr/bin/security add-generic-password
  -U
  -s com.twindesk.feishu
  -a <opaque SecretReference.id>
  -w
```

macOS documents that a final `-w` prompts for the value. TwinDesk writes the
bounded bundle bytes to child stdin followed by one newline, so credentials do
not enter process arguments. Stdout is discarded; stderr chunks are counted up
to 8 KiB, overwritten, and never serialized. Tests inject the process boundary
and do not modify a live Keychain item.

The production Bot installer invokes the same fixed executable without the
`-U` update flag. It therefore cannot silently replace an existing item:

```text
/usr/bin/security add-generic-password
  -s com.twindesk.feishu
  -a <opaque SecretReference.id>
  -w
```

The exact versioned Bot bundle is again written through stdin. Any failure
after process start remains uncertain because the item may have been created;
callers must inspect credential health and must not retry automatically.

## Secret Lifetime and Errors

The caller receives the resolved bytes only inside `withSecret()`'s callback.
The same buffer is overwritten with zeroes immediately after that callback
settles, including cancellation, validation failure after lookup, and callback
failure. A caller that decodes or copies the bytes owns the lifetime and
redaction of those additional values; JavaScript cannot retroactively erase an
immutable string copy.

The installer and replacer take ownership of supplied `Uint8Array` values and
overwrite them on every exit, including validation failure, pre-start
cancellation, command failure, and cancellation after command start. Once a
command starts, every non-successful observation is `write_uncertain`: the
Keychain may already contain the new value. Callers must inspect or reconcile
the exact reference before another attempt.

An invalid callback fails before Keychain access. Empty and oversized values
fail before callback invocation. Missing items, unsupported
platform/store/purpose, command failure, and invalid references use fixed typed
errors that contain neither the locator nor command output. Error
classification inspects only safe own data properties and does not invoke a
thrown object's accessors. AbortSignal cancellation stops before callback use,
and any already resolved buffer is still zeroed. Partial stdout is zeroed when
the macOS command fails. No secret or locator is written to SQLite, Session
storage, logs, telemetry, model context, or Audit by this boundary.

## Feishu Reply Constraint Found During Integration

The official [reply-message API](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
documents a maximum 50-character `uuid` and a one-hour deduplication window.
Its success response returns the generated `message_id`, but not the request
`uuid`. The official [message-history API](https://open.feishu.cn/document/server-docs/im-v1/message/list)
also omits `uuid`. Therefore, scanning visible message content cannot prove
whether an uncertain reply request succeeded.

The local Feishu executor now requires a durable dispatch-journal reservation
before its injected client can send. Production HTTP composition must preserve
that ordering. It must not implement `reconcile()` by
assuming an absent local receipt means an absent remote reply, and it must not
silently resend after the one-hour Feishu deduplication window.

## Verification and Remaining Work

Synthetic tests cover exact read, create-only installation, and stdin-only
replacement commands, supported purposes, invalid references, unsupported stores and platforms, invalid
callbacks, missing items, empty and oversized values, pre/post-start
cancellation, callback and command failure, uncertain-write classification,
hostile error accessors, payload-free errors, frozen command metadata, and
byte-buffer zeroing. They inject command runners and do not read or write a real
Keychain item.

Versioned Bot/User credential parsing and rotated User-bundle encoding now
compose with these callback boundaries in synthetic tests, and a bounded Fetch
transport validates OAuth v3 refresh responses. The
[Feishu OAuth Rotation Coordinator](FEISHU_OAUTH_ROTATION_COORDINATOR.md) now
persists a reservation before remote refresh and reconciles an unfinished
attempt through the exact Keychain reference after restart. The exclusive Host
lease now passes real cross-process tests, and the bounded Bot tenant-token
client composes with exact Keychain resolution, remote Bot-principal
verification, and tenant-only scope observation in synthetic contracts. The
Workbench root now composes User rotation, exact Keychain replacement and
resolution, scope checks, and fixed-endpoint reply HTTP under the actual lease.
Remaining TD-209 integration includes hosted recovery lifecycle, UI, and
live-account acceptance.
Verified blocked-state replacement is covered
by [Feishu OAuth Reauthorization Replacement](FEISHU_OAUTH_REAUTHORIZATION.md).
