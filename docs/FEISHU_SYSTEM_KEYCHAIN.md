# Feishu System Keychain Resolution

## Scope

TD-209 adds the first production credential-read boundary for the Feishu
Connector. `FeishuSystemKeychainSecretResolver` resolves an already validated
Bot application-credential or User OAuth `SecretReference` from the macOS
system Keychain. It does not parse a credential bundle, refresh OAuth, obtain a
tenant token, call Feishu, persist a secret, grant a scope, or authorize an
external write.

The fixed Keychain mapping is:

```text
generic-password service = com.twindesk.feishu
generic-password account = SecretReference.id
generic-password value   = connector-owned credential bundle (not yet parsed)
```

Only `store: system_keychain` with purpose `connector_app_credential` or
`connector_oauth` is accepted. Encrypted secret stores and other purposes need
separate owners and never fall back to this adapter.

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

## Secret Lifetime and Errors

The caller receives the resolved bytes only inside `withSecret()`'s callback.
The same buffer is overwritten with zeroes immediately after that callback
settles, including cancellation, validation failure after lookup, and callback
failure. A caller that decodes or copies the bytes owns the lifetime and
redaction of those additional values; JavaScript cannot retroactively erase an
immutable string copy.

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

Synthetic tests cover exact command construction, supported purposes, invalid
references, unsupported stores and platforms, invalid callbacks, missing items,
empty and oversized values, pre-start cancellation, callback failure, hostile
error accessors, payload-free errors, frozen command metadata, and byte-buffer
zeroing. They inject a command runner and do not read a real Keychain item.

Remaining TD-209 integration includes versioned Bot/User credential-bundle
parsing, OAuth refresh and revocation, minimum-scope checks, tenant-token
acquisition, the HTTP composition boundary, runtime
composition, UI, and live-account acceptance.
