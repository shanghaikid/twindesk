# Inbox Client Extension Spike

## Result

TD-031 proves that an empty top-level TwinDesk Inbox can be added to DeepSeek Harness `0.1.1-rc.2` entirely from the external `@twindesk/plugin-ui` package. The spike adds a `#/inbox` deep link, an additive sidebar entry, and a static empty-state page. It does not patch Harness, import an unexported source path, or add Work Hub data and actions.

The implementation is sufficient for Stage 0 compatibility validation. [ADR 0002](decisions/0002-twindesk-owned-product-web-shell.md) retains these seams as diagnostics only and assigns the long-term product routes to a standalone TwinDesk-owned Web shell without a Harness fork or patch.

## Extension Path

1. The package metadata declares Client graph edges to the published conversation, plugin-settings, and sidebar packages.
2. `slots.inject("sidebar.footer.action", ...)` waits for the sidebar declaration and registers the stable `twindesk-inbox` list entry.
3. The entry changes the browser hash to `#/inbox`. Harness does not expose a Router or page registry, so the external plugin owns this route state using the standard browser hash API.
4. `slots.inject("conversation", ...)` observes the route. While the Inbox route is active, it registers the empty page into the published top-level `conversation` single slot at priority `-100`.
5. Harness SlotCore renders the lowest-priority live entry. Removing the Inbox registration on route exit, declaration collapse, or plugin disposal restores the shipped conversation entry.

The static page deliberately contains no Connector, Inbox, persistence, model, approval, or external-write behavior.

## Contracts and Stability

| Contract | Source | Status for the spike |
|---|---|---|
| `package.json#dsh.client` discovery and graph edges | Published package metadata contract | Supported but developer-preview |
| `ctx.slots.inject()` and `ctx.slots.register()` | Published Client runtime and UI slot packages | Supported but developer-preview |
| `sidebar.footer.action` list slot | Exported sidebar `/client` contract | Supported additive sidebar seam |
| `conversation` single slot | Exported layout `/client` contract | Supported replacement seam |
| Lower numeric priority shadows a single-slot occupant | Published SlotCore contract | Supported and pinned by an adapter probe |
| `window.location.hash` and `hashchange` | Browser platform | Plugin-owned; not a Harness routing API |
| Harness lazy-CJS wrapper and shared React module | Client module loader contract | Required because no external build preset is published |

No internal Harness API is required. In particular, TwinDesk does not import from `/src`, reach into the renderer, mutate the session manager, or replace Harness source files.

## Remaining Gaps and Risks

- Harness exposes no public Router, route registry, or navigation service. The hash route is therefore owned by TwinDesk and cannot participate in a future Harness route lifecycle without adaptation.
- The only additive sidebar-level action seam is `sidebar.footer.action`; there is no generic primary-navigation list. The Stage 0 Inbox entry consequently appears in the footer rather than beside Workspace and Session navigation.
- The Inbox page uses supported single-slot priority shadowing. Another plugin with a lower priority could win the same cell, and a duplicate `-100` priority fails loudly at registration. The exact priority remains a pinned compatibility assumption.
- Replacing `conversation` is safe only while the route is active and only because the disposer restores the shipped entry. A leaked registration would hide the conversation surface, so reload and disposal tests are mandatory.
- The narrow external builder still supports one TypeScript source module and shared React only. A product Inbox with stylesheets and multiple modules needs either a deliberate builder expansion or a published upstream Client preset.

ADR 0002 rejects these constraints for the product path. `@twindesk/web` owns the Inbox route and navigation, while this spike remains a compatibility diagnostic. The optional upstream proposal stays product-neutral and no TwinDesk Inbox logic enters Harness core.

## Verification

- The adapter executes the exact pinned `SlotCore` and verifies Inbox shadowing, conversation restoration, footer mounting, and footer disposal.
- The production lazy-CJS bundle test exercises navigation from an empty hash, a direct `#/inbox` load, empty-page rendering, return navigation, plugin disposal, listener cleanup, and module reload isolation.
- Artifact preflight requires all three Client graph edges and rejects missing or malformed production output.
- The live Profile smoke test starts the installed Profile and fetches the production bundle and embedded-source map from the stable boot graph.
