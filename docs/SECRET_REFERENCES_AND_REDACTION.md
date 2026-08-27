# Secret References and Shared Redaction

TD-110 establishes a dependency-free safety boundary for secret locators and
outbound data. It does not add credentials, resolve the system Keychain,
connect an external account, implement Thread export, or grant any Tool or
Connector authority.

## SecretReference contract

`SecretReference` is a version 1 TwinDesk domain record with exactly four data
fields:

- `kind: secret_reference` and `schemaVersion: 1`;
- a lowercase, namespaced `secret-ref:` opaque locator;
- `store`, either `system_keychain` or `encrypted_secret_store`;
- `purpose`, one of Connector application credential, Connector OAuth,
  Connector API key, model API key, or other.

There is no value, token, password, cookie, private key, account scope, Tool
scope, approval, or authority field. Unknown fields, accessors, symbols,
unsupported stores or purposes, and locators outside the bounded format are
rejected without echoing their values. The syntax prevents accidental use of a
raw token-shaped value, but callers remain responsible for creating locators
that contain no secret material.

The record identifies where a future Connector or model adapter may resolve a
secret. TD-110 intentionally does not implement a resolver: actual Keychain
integration belongs with the concrete credential owner. A resolved value must
remain short-lived, must never enter ordinary SQLite or Session data, and must
be supplied as a known secret to the redactor before any outbound boundary.

## Boundary policies

`redactForBoundary()` requires one explicit policy:

| Boundary | Authorized business text | Always removed |
|---|---|---|
| `logs`, `errors`, `telemetry` | Only allowlisted structured metadata text, such as status, category, operation, type, bounded code, and timestamps | Credentials, secret locators, hidden reasoning, identifiers, summaries, content, prompts, payloads, and non-allowlisted text |
| `model_context` | Business text explicitly selected for the model | Credentials, secret locators, supplied secret values, recognizable inline credentials, caller-sensitive fields, and hidden reasoning |
| `exports` | Business text explicitly selected for an authorized export | The same always-removed data as model context |

All policies recognize credential-bearing field names, environment containers,
versioned SecretReference objects, supplied exact in-memory secret values,
Bearer values, common token/password assignments, cookies, and PEM private-key
blocks. Callers can declare additional sensitive field names. Known-secret
matching is literal and never records the values.

The result contains a deeply immutable JSON-compatible value and a count-only
summary by reason. It contains no paths, rejected field names, secret values,
or original Error messages. The summary can support safe diagnostics and
testing without becoming another data-leak channel.

## Fail-closed behavior

The redactor never invokes accessors. Cycles, symbols, unsupported JavaScript
values, non-finite numbers, excessive depth or node count, invalid options,
hostile Proxies, and oversized arrays become a fixed redaction marker or a
generic configuration error. Errors retain only a bounded Error name and
machine code; their message and custom payload are omitted.

Diagnostic policies deliberately redact unclassified string values. This
requires structured logging and telemetry instead of passing arbitrary text
and assuming a pattern matcher can recognize every company or personal datum.
The redactor is defense in depth, not a replacement for collecting less data,
selecting bounded model context, or authorizing an export.

## Current integration

Both current Work Hub Tool renderers use
`renderRedactedModelContext()` before returning text to Harness. Their existing
fixture payloads contain no credentials, so observable Tool behavior remains
unchanged. The integration test injects only synthetic secret markers and
proves authorized fixture context remains while credentials, opaque locators,
and hidden reasoning do not reach the rendered value.

Current storage operations expose bounded typed errors and do not emit product
logs, telemetry, or model context. Future code creating any such boundary must
call the shared redactor and add a field-specific leakage test. TD-111
implements the first Thread export and applies the `exports` policy to the
entire aggregate before returning authorized business content. Callers can
provide exact, resolved in-memory secret values for removal; those values are
never persisted or returned. See
[Thread Export and Deletion](THREAD_EXPORT_AND_DELETION.md).

TD-200 uses the same SecretReference boundary for Feishu identity
configuration. The Bot slot accepts only an application-credential reference,
the User slot accepts only a distinct OAuth reference, and the configuration
store persists neither resolved value. Keychain resolution, credential refresh,
revocation, and short-lived known-secret registration with the redactor remain
future work. See [Feishu Bot and User Identities](FEISHU_IDENTITIES.md).

## Verification

The domain, redaction, and Work Hub tests cover:

- strict immutable SecretReference parsing with no value or implicit scope;
- API keys, OAuth and session tokens, authorization headers, cookies,
  environment containers, passwords, and PEM private keys;
- exact known-secret removal and caller-declared sensitive fields;
- business-content differences across diagnostic, model-context, and export
  policies;
- hidden-reasoning removal on every boundary;
- count-only immutable summaries and unchanged inputs;
- accessors, symbols, cycles, functions, non-finite values, depth and size
  limits, malformed options, Error payloads, and hostile Proxy traps;
- the actual Work Hub model-context renderer and unchanged synthetic Tool
  traces.
