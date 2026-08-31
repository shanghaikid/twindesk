# Feishu Bot Keychain Scope Probe

## Scope

TD-209 adds the first production-shaped Bot operation-scope probe. It composes
the exact configured `connector_app_credential` SecretReference, the macOS
Keychain resolver, version 1 Bot credential parsing, bounded tenant-token
acquisition, remote Bot identity lookup, and current application-scope lookup.
The existing operation authorizer consumes the resulting evidence for only the
fixed `bot_reply` policy.

The successful ordering is:

```text
validate the exact Bot reply probe request
  -> resolve and parse the configured Bot application credential
  -> exchange it for one callback-scoped tenant token
  -> GET the current Bot identity and require its open_id to match configuration
  -> GET the current application permission list
  -> retain only scopes whose token_types includes tenant
  -> return fresh credential-free evidence to the fixed policy authorizer
```

This is scope evidence only. It grants no approval, creates no external write,
and cannot broaden Bot visibility or Persona authority.

## Fixed Remote Contract

`FeishuBotIdentityScopeHttpClient` sends two fixed, sequential `GET` requests
with the callback-scoped tenant token:

```text
GET https://open.feishu.cn/open-apis/bot/v3/info
GET https://open.feishu.cn/open-apis/application/v6/applications/{app_id}?lang=zh_cn
Authorization: Bearer <tenant_access_token>
Accept: application/json
```

The first response supplies the actual Bot `open_id`. TwinDesk requires an
exact match with the configured Bot principal, because possession of valid
application credentials alone does not prove that the configuration names the
same Bot. The second response supplies application scopes. A scope counts for
the Bot only when its `token_types` list includes `tenant`; User-only scopes are
discarded and cannot authorize a Bot reply.

This contract follows the official Lark CLI's use of
[`/bot/v3/info` for the authenticated Bot](https://github.com/larksuite/cli/blob/main/shortcuts/common/runner.go)
and its parsing of application scope
[`token_types`](https://github.com/larksuite/cli/blob/main/cmd/auth/auth.go).
The tenant token is still acquired through Feishu's official
[internal tenant access-token endpoint](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal).

Both responses must be successful JSON with valid UTF-8 and no duplicate
object keys. Each declared or streamed body is limited to 256 KiB. Redirects,
ambient credentials, referrers, and caching are disabled. The two calls share
one 30-second timeout by default, configurable only up to two minutes.

## Failure and Recovery

- a missing Keychain item, rejected application credential, unauthorized token,
  or remote Bot-principal mismatch requires Bot configuration repair;
- a missing required tenant scope requires an application permission change;
- HTTP or application-level rate limiting and temporary service or network
  failures are retryable through a new probe;
- malformed credentials, responses, scope records, unknown application error
  codes, substituted identities, operations, references, or scope lists fail
  closed as invalid adapter state;
- cancellation propagates and never reaches the operation callback.

The application permission response is current configuration evidence, not a
guarantee that the immediately following message request will succeed. A scope
can be revoked between the probe and operation, so the reply HTTP primitive
keeps authorization and missing-scope failures authoritative.

## Secret Lifetime and Privacy

The Keychain buffer, parsed application-secret buffer, tenant-token request and
response buffers, tenant-token buffer, and both observation response buffers
are callback-scoped and overwritten after use. JavaScript HTTP headers and JSON
parsing still create temporary immutable strings that cannot be retroactively
erased, so production Fetch must not be wrapped with credential or body logging.

The authorizer-visible result contains only account, identity type, operation,
tenant scope names, and observation time. It excludes the Bot principal,
SecretReference, application secret, tenant token, raw Bot profile, raw
application data, and upstream error payloads. Nothing in this probe is written
to TwinDesk SQLite or Harness Session storage.

## Verification and Remaining Work

Synthetic tests cover fixed URLs and Fetch options, exact Bot-principal
matching, tenant-versus-User scope filtering, Keychain-to-authorizer success,
missing scope, missing and malformed credentials, application credential
rejection, HTTP and application-level rate limits, malformed and oversized
responses, duplicate values, cancellation, timeout, payload-free failures, and
transient-buffer clearing. They use no live Keychain item, credential, account,
or network request.

The reply execution adapter now consumes this probe under an already-held Host
lease, then reacquires a callback-scoped tenant token for fixed-endpoint HTTP.
The Connector-neutral Host operation now owns approval, dispatch, receipt, and
Audit ordering under injected exclusive ownership. Remaining work includes
binding both boundaries plus User rotation under the actual Feishu lease,
wiring production diagnostics and settings, hosted event or polling lifecycle,
and live-account acceptance.
