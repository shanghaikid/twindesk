# Workbench Feishu Reply Runtime

## Scope

`createWorkbenchFeishuReplyExecutionHost()` is the production-shaped Workbench
composition boundary for one approved Feishu reply. It binds the
Connector-neutral `WorkHubActionExecutionHost` to:

- the real kernel-backed `FeishuRuntimeLeaseManager`;
- the durable `FeishuOAuthRotationCoordinator` for configured User identity;
- `FeishuReplyExecutor` and its durable dispatch-reservation callback;
- the lease-held `FeishuReplyExecutionAdapter`;
- the exact configured Bot or User scope probe, Keychain resolver, token
  acquirer when required, and bounded reply HTTP client.

The factory does not create approval authority or accept reply content. Its
Host operation accepts only the Approval and proposal IDs; every identity,
target, content, and idempotency binding comes from durable TwinDesk records.

## Ownership and Ordering

The default lease manager owns the fixed loopback lease for the complete Host
callback. Approval validation and consumption, approval Audit, execution
start, durable User credential rotation when required, durable reply dispatch
reservation, credential and scope preflight, HTTP dispatch, receipt settlement,
and execution Audit therefore run without another Feishu runtime entering the
callback. The adapter checks the held lease after rotation, before credential
access, and immediately before the external write.

The factory validates the required database methods and concrete security
collaborators before returning a Host. A User configuration requires its User
scope probe and rotation coordinator. A Bot configuration requires both its Bot
scope probe and tenant token acquirer. Missing or substituted collaborators
fail before approval consumption.

## Verification

The synthetic composition test uses the real loopback lease and real
production classes with injected Keychain-command and Fetch boundaries. It
proves:

- one exact User approval is consumed and audited before dispatch;
- an expired User access token rotates once before reply dispatch reservation,
  then three callback-scoped Keychain reads cover rotation, scope, and
  send-time credential validation;
- one durable dispatch reservation precedes one reply request;
- the successful receipt, proposal settlement, and execution Audit persist;
- secret, response, and request buffers are cleared at their boundaries;
- a fresh database and composition instance recover the terminal receipt after
  approval expiry without another Keychain read or HTTP call;
- incomplete identity or database composition fails before execution.

No live Keychain item, credential, Feishu account, or network endpoint is used.

## Remaining Work

This factory is an executable composition API, not yet a hosted Cordis
Connector lifecycle. A rotation result that requires reauthorization or
Keychain reconciliation terminates the approved reply without blind retry;
hosted recovery and reauthorization UX remain open. The Workbench Inbox now
invokes this Host through a separate approved-action execution control and
restores its durable presentation after refresh. Hosted callback or polling and
an authorized live-account acceptance run also remain open. Synthetic
evidence must not be presented as a live Feishu guarantee.
