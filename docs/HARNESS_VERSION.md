# DeepSeek Harness Version

## Selection Policy

TwinDesk follows the latest published DeepSeek Harness release when a Harness
upgrade is intentionally performed. The resolved release is then pinned by
both its package version and Git commit. TwinDesk must not use the npm
`latest` specifier, a floating Git branch, or an unqualified Git tag in a
committed dependency.

This policy keeps TwinDesk current without making otherwise unrelated builds
silently consume a breaking Harness developer-preview update.

## Current Pin

The following values were verified on 2026-08-25:

| Item | Pinned value |
|---|---|
| npm package | `@deepseek-ai/dsh@0.1.1-rc.2` |
| Git tag | `dsh-v0.1.1-rc.2` |
| Git commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| License | MIT |
| Node.js | Node 24 for local development and CI |
| Supported Node.js range upstream | `^22.19.0 || >=24.0.0` |
| Package manager | `pnpm@11.7.0` |

At the time of selection, npm resolved both the `latest` and `next` dist-tags
to `0.1.1-rc.2`. The official Git tag resolved directly to the commit above.
The upstream project does not publish a GitHub Release object for this version;
the npm publication and Git tag are the release records.

The authoritative upstream metadata is available in the pinned
[`package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/package.json),
[`@deepseek-ai/dsh` package manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/package.json),
and [MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE).

## Dependency Acquisition

The TwinDesk workspace manifest and `pnpm-lock.yaml` record the exact package
version. The manifest entry uses
`0.1.1-rc.2`, not `latest`, `next`, a caret range, or a tilde range. The
lockfile is the dependency source for both local development and CI.

Local development and CI must use Node 24 and pnpm 11.7.0. CI must install
with the frozen lockfile:

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
```

When source inspection or source-based compatibility testing is required, use
an exact checkout and verify it before running tests:

```sh
git clone --depth 1 --branch dsh-v0.1.1-rc.2 \
  https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
test "$(git -C deepseek-harness rev-parse HEAD)" = \
  "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
```

The source checkout is for compatibility investigation only. TwinDesk must
consume published packages through its adapter boundary rather than copying
Harness source into the repository.

The conventional local inspection checkout is the sibling directory
`../deepseek-harness`. It must remain detached at the pinned commit; TwinDesk
builds and Profile launches continue to consume the frozen npm artifacts, so a
missing source checkout does not change runtime resolution.

## Verification Record

A clean shallow clone of `dsh-v0.1.1-rc.2` was performed on 2026-08-25. It
resolved to the pinned commit, reported the expected version and MIT license,
and declared pnpm 11.7.0 with the upstream Node.js range shown above.

A separate clean `pnpm@11.7.0 dlx` resolution of the exact npm package
completed successfully and the CLI reported `0.1.1-rc.2`. The TD-011 workspace
install pins React and React DOM to 18.3.1, matching the pinned Harness source,
and `pnpm peers check` reports no peer-dependency issues. pnpm still reports
the upstream deprecated transitive dependency `node-domexception@1.0.0`; this
does not run an install script or block the Stage 0 scaffold checks.

The selected npm artifact reported this integrity value:

```text
sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==
```

TD-011 preserves this resolution in `pnpm-lock.yaml`. A clean temporary copy
completed frozen installation and the full workspace `check` command on
2026-08-25. TD-050 will later extend this scaffold verification into the full
TwinDesk compatibility smoke suite.

TD-012 adds adapter-owned compatibility probes for
`@deepseek-ai/cordis@4.0.1` and
`@deepseek-ai/dsh-app-boot@0.1.1-rc.2`. Consuming the app-boot public
declarations also requires `@types/js-yaml@4.0.9`, which the upstream package
uses during development but does not declare for downstream TypeScript
consumers. TwinDesk declares that type package explicitly instead of enabling
`skipLibCheck`.

TD-020 validates the public Profile machinery against the same package pin.
The generated `workbench` Profile composes `@deepseek-ai/dsh-base`,
`@deepseek-ai/dsh-web-app`, and `@twindesk/bundle-workbench` in that order. Its
smoke test verifies the effective configuration and starts the Web surface on
an operating-system-assigned loopback port before requesting normal shutdown.

## Upgrade Procedure

For each intentional Harness upgrade:

1. Resolve the current npm `latest` dist-tag and the matching official Git tag.
2. Verify that the package version, tag, and source `package.json` agree.
3. Replace the exact version, commit, toolchain metadata, integrity value, and
   verification date in this document.
4. Regenerate the lockfile without changing unrelated dependencies.
5. Run the TD-050 compatibility suite before accepting the upgrade.
6. Commit the upgrade as an isolated compatibility change.
