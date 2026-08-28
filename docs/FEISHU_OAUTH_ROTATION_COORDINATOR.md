# Feishu OAuth Rotation Coordinator

## Scope

TD-209 now composes the existing system Keychain reader, credential parser,
OAuth v3 refresher, rotated-bundle encoder, and Keychain replacer behind
`FeishuOAuthRotationCoordinator`. The coordinator refreshes only an already
principal-bound User credential whose access token is `refresh_required`. It
does not start authorization, grant scopes, expose tokens to an operation
client, or authorize an external write.

The current boundary is designed for one TwinDesk Host process. Instances that
share one resolved journal path serialize inside that process. Starting two
independent Host processes against the same account is unsupported until the
runtime owns an exclusive cross-process Connector lease.

## Durable Ordering

The coordinator enforces this order:

```text
read and identity-bind current Keychain bundle
  -> fsync reserved journal event
  -> call Feishu OAuth v3 refresh once
  -> encode a strictly newer, distinctly rotated bundle
  -> replace the exact User OAuth Keychain item
  -> fsync completed journal event
```

No remote refresh starts unless the reservation is durable. A second call in
the same Host sees the active reservation and returns `rotation_pending`
without reading the refresh transport. A completed record permits a later
rotation only when the next source credential has not regressed behind the
previous result.

## Restart and Uncertain Outcomes

Each reservation records only the old credential's non-secret canonical
`obtainedAt` timestamp. After restart, an unfinished reservation is reconciled
by reading and parsing the exact configured Keychain reference again:

- a credential with a strictly newer `obtainedAt` proves that replacement
  reached durable Keychain state, so the journal appends `completed` and returns
  `recovered`;
- the same or an older credential cannot prove whether Feishu consumed the
  single-use refresh token, so the journal becomes `uncertain` and the old
  token is never submitted again;
- an explicit invalid, expired, revoked, or used-token response appends
  `reauthorization_required` and remains blocked until a newer authorized
  credential is installed.

Every other failure after reservation is conservative. Network failure,
malformed success, bundle-encoding failure, uncertain Keychain replacement,
completion-journal failure, and cancellation all leave durable blocking
evidence. Cancellation still propagates after the coordinator first records
uncertainty.

## Journal Privacy and Integrity

The append-only JSONL journal contains only:

- schema version and monotonically increasing sequence;
- `reserved`, `completed`, `uncertain`, or `reauthorization_required` state;
- source, result, and local record timestamps when applicable.

It stores no app ID, account ID, principal, SecretReference locator, client
secret, access token, refresh token, scope, raw response, or error payload. The
file must be a private regular file, is opened with `O_NOFOLLOW`, is limited to
1 MiB, and is `fsync`ed after every event. A torn final line is truncated and
synced during recovery; invalid transitions and non-private or linked files
fail closed. There is no automatic compaction yet. Connector account removal
must eventually own explicit journal retention and deletion.

## Verification and Remaining Work

Synthetic tests cover durable-before-remote ordering, exact one-call rotation,
fresh-instance Keychain reading, crash recovery after Keychain replacement,
network uncertainty, persistent reauthorization, concurrent calls,
cancellation, torn-tail repair, unsafe files, payload-free errors, and absence
of identity or credential values in the journal. They use injected transports
and Keychain runners and make no live network or Keychain change.

The isolated authorization-code/PKCE exchange is now implemented. Remaining
work includes composition with verified initial persistence, an exclusive
runtime Connector lease, replacement of
blocked state after explicit reauthorization, operation scope checks, reply
HTTP composition, hosted ingestion or polling, UI, and live-account acceptance.
