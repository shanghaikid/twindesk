# Feishu OAuth Loopback Callback Host

## Status

TwinDesk now has a bounded, one-transaction HTTP callback listener for the
literal-loopback redirect used by the existing Feishu authorization-code and
PKCE flow. This is synthetic lifecycle evidence. It does not open a browser,
construct the production settings runtime, or prove a live Feishu account.

## Lifecycle

`FeishuOAuthLoopbackCallbackHost.listen()` binds only `127.0.0.1` or `::1`.
Port zero is supported so the operating system can allocate an isolated port;
the returned listener exposes the exact `redirectUri` that must be supplied to
`FeishuOAuthAuthorizationFlow.start()` and registered for the application.

After the authorization session exists, `listener.wait()` arms the listener
with that session's authorization URL. It independently verifies that the URL
uses Feishu's fixed authorize endpoint, contains one valid state, and binds the
listener's exact redirect URI. The browser should be opened only after this
arming call has returned its pending promise.

The listener accepts one `GET` request at the exact callback path with either:

- one bounded code and the exact state; or
- `error=access_denied` and the exact state.

Wrong state, duplicate or unknown fields, another path, a request body, a
non-GET method, an absolute request target, and targets above 8 KiB receive a
fixed 404 response and do not consume the legitimate wait. A captured callback
is still passed to `FeishuOAuthAuthorizationSession.complete()`, which remains
the authoritative state, replay, exchange, and token-cleanup boundary.

## Security and Recovery

Responses contain no code, state, token, principal, account, or credential
reference and set `no-store`, `nosniff`, no-referrer, and a deny-all content
security policy. The listener never logs or persists a request target.

Only one wait can be armed. Success, denial, timeout, caller cancellation,
manual close, and listener failure close the server. The default timeout is five
minutes and cannot be configured above the authorization-code lifetime. Errors
are typed and payload-free. Malformed local traffic remains non-terminal so it
cannot deny the legitimate callback merely by reaching the known path.

## Verification and Remaining Work

Real loopback tests use ephemeral ports and prove exact success and denial,
wrong-state and malformed-request survival, response minimization, one-shot
closure, timeout, cancellation, manual close, hostile configuration, and
authorization/redirect binding. The listener makes no external request.

Still open:

- Workbench composition that starts the listener, authorization flow, verified
  persistence or blocked-state replacement under one Host lease;
- browser launch and product recovery UI;
- settings-derived application credentials and registered redirect handling;
- live Feishu authorization and Keychain acceptance.
