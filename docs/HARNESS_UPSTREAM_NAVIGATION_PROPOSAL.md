# Harness Upstream Proposal: Generic Top-Level Pages and Primary Navigation

- Status: Reference draft — not submitted and not a TwinDesk product blocker
- Target: DeepSeek Harness GitHub Discussion
- Evidence revision: `dsh-v0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Prepared: 2026-08-26

## Summary

> ADR 0002 selected a TwinDesk-owned standalone Web shell. This proposal is
> retained as optional ecosystem input for Harness Client extensibility; its
> acceptance, implementation, or release is not required for TwinDesk Stage 1.

Could Harness expose a product-neutral Client extension for additive primary
navigation and keyed top-level pages?

External Client plugins can already compose UI through the slot system, but a
plugin that needs a dashboard, queue, audit viewer, or other top-level page has
no public way to register a primary navigation entry, own a deep link, or
participate in browser history. The smallest useful addition would preserve the
existing slot model while adding a root-scoped page route service and two shell
seats:

- an additive primary-navigation list;
- a keyed top-level page seat selected by the route service.

The proposal is deliberately generic. It does not require Inbox, work-item,
Connector, Persona, approval, or other downstream product concepts in Harness.

## Current Public Surface

On the evidence revision:

- `ui-layout` declares the root `sidebar`, `conversation`, `details`, and
  `shell.overlay` seats, but no top-level page seat;
- `ui-sidebar` declares brand, workspace, settings, and
  `sidebar.footer.action` seats, but no additive primary-navigation list;
- `ui-slots` already provides keyed and list entries, deterministic ordering,
  duplicate-cell diagnostics, recursive child teardown, and registration
  disposal;
- the Client exposes no public route registry or browser-history service.

The relevant pinned sources are the
[layout declaration](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-layout/src/client/index.ts),
[sidebar declaration](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-sidebar/src/client/contract/slots.ts),
and
[slot lifecycle implementation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-slots/src/index.ts).

An external plugin can currently simulate a page by listening to
`window.location`, contributing a footer action, and replacing the
`conversation` slot at another priority. That technique gives the plugin a
private route protocol, places a primary destination in the footer, and
temporarily removes the conversation registrant's child seats. It is useful as
an extension probe, but it is not a reusable page lifecycle.

## Requested Behavior

### Page route service

A root-scoped Client service should own a small page-route namespace. It should:

- register an opaque page identifier and one canonical route;
- reject duplicate identifiers and duplicate canonical routes at registration;
- navigate by registered identifier with push or replace semantics;
- expose a stable observable snapshot containing the active identifier or an
  explicit unknown-route state;
- restore its snapshot from the browser URL on direct load and reload;
- react to browser back and forward navigation;
- remove the registration through an idempotent disposer;
- return to the default shell route with replace semantics if the active page
  is disposed.

The public service should own the URL encoding. A namespaced fragment route is
sufficient for the first version and avoids requiring server-side SPA fallback;
callers should navigate by page identifier rather than concatenate URLs.

An illustrative service face is:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type PageId = Branded<'PageId'>

interface PageRouteSpec {
  id: PageId
  route: string
}

type PageRouteSnapshot =
  | { kind: 'default' }
  | { kind: 'page'; id: PageId }
  | { kind: 'unknown'; route: string }

interface PageNavigation {
  register(spec: PageRouteSpec): () => void
  navigate(id: PageId, options?: { replace?: boolean }): void
  getSnapshot(): PageRouteSnapshot
  subscribe(listener: () => void): () => void
}
```

The names are illustrative. The final service should follow Harness's existing
Service Definition, Provider, and Consumer conventions. Components should
receive the live snapshot and navigation callbacks through framework-bound
props or hooks; they should not receive a service object or create their own
browser subscription.

The canonical route should be a non-empty normalized path below the service's
namespace, without a leading hash, query, or fragment. The provider should
reject invalid routes during registration and perform URL encoding itself.

### Top-level page seat

The layout shell should declare one root-scoped keyed seat, for example
`shell.page`. External plugins would register page components through the
existing `ctx.slots.register` API with their page identifier as the entry key.

When the route snapshot is `default`, the shipped conversation and details
surface should render exactly as it does today. When a registered page is
active, the layout should render the matching keyed page in a dedicated main
area while keeping the sidebar. The page must not register over or shadow
`conversation`; switching back should reveal the original conversation
registration and all of its child seats without rebuilding their slot
declarations.

An unknown direct route should render an explicit generic not-found state. It
must not silently become the default page or a registered page with similar
text.

### Primary-navigation seat

The sidebar shell should declare one root-scoped list seat, for example
`sidebar.primary.action`, in the primary destination region rather than the
footer. Existing list semantics can own stable entry identifiers, order,
priority, collision diagnostics, and disposal.

Each entry needs enough owner data and callbacks to render consistently in both
expanded and collapsed sidebar states:

- whether the sidebar is wide;
- the active page identifier or default state;
- a callback that navigates by registered page identifier.

The entry component can own its icon and localized label through the existing
slot and locale mechanisms. Page registration and navigation-entry
registration may remain separate so a deployment can expose a page through a
different command surface. Route and slot collisions should fail at
registration; calling the navigation callback with an unregistered identifier
should fail immediately rather than create an implicit route.

## Lifecycle and Failure Semantics

- Page identifiers and canonical routes are unique across the active root
  composition. A collision fails the later registration and names the
  conflicting identifier or route without exposing unrelated configuration.
- Repeating navigation to the active page is a no-op and does not add a browser
  history entry.
- Back and forward events update one published snapshot before consumers
  render; consumers do not observe an intermediate default page.
- Disposing an inactive page leaves the current URL and snapshot unchanged.
- Disposing the active page replaces the current history entry with the
  default shell route and publishes the default snapshot.
- Plugin reload does not retain route registrations, browser listeners,
  navigation entries, page entries, or stale observables from the disposed
  fiber.
- A route that is unknown after Client boot remains an explicit unknown state.
  Registration order during boot must not cause a valid deep link to flash the
  default shell or be rewritten prematurely.

## Acceptance Coverage

The upstream implementation should have keyless coverage for:

1. two independent plugins registering ordered primary actions and keyed pages;
2. direct loading of every registered route;
3. push navigation, duplicate-navigation no-op, replace navigation, browser
   back, and browser forward;
4. reload recovery on a registered page;
5. unknown-route rendering without silent fallback;
6. identifier and route collision failures;
7. invalid canonical-route rejection and navigation to an unregistered
   identifier;
8. disposal of inactive and active registrations;
9. plugin reload with no leaked listeners, entries, or registrations;
10. expanded and collapsed primary-navigation rendering;
11. conversation registration and its child seats surviving page switches;
12. built declarations, package exports, dynamic Client loading, and an
    assembled Web snapshot or browser smoke path.

## Compatibility and Ownership

This can be additive to the current Client surface. Existing deployments that
register no page continue rendering the default conversation shell. External
plugins opt in by registering route metadata plus ordinary slot entries.

Harness would own the route namespace, URL and history behavior, generic page
render seat, primary-navigation render seat, collision rules, and lifecycle.
External plugins would own their page identifiers, labels, icons, components,
data, commands, authorization, and product behavior.

No downstream product domain type or business behavior belongs in Harness core.
Registering a page grants presentation and navigation only; it must not grant a
Tool, credential, filesystem, model, Connector, approval, or external-write
capability.

## Out of Scope

- a general-purpose nested application router;
- server-side rendering or arbitrary server route fallback;
- query-string schemas owned by Harness;
- product-specific navigation, badges, data loading, or persistence;
- changing the Session and conversation route model;
- authorization or capability grants implied by page visibility;
- an external Client build preset, which is a separate packaging concern.

## Open Design Questions

1. Should the first public URL encoding use a namespaced fragment so it works
   with the current Web host without server fallback?
2. Should the route service live with `ui-layout`, or in a small dedicated
   Client capability package consumed by `ui-layout` and `ui-sidebar`?
3. Should an unregistered navigation entry fail during its first resolved
   render, or should a small metadata validator pair it with page registration
   during plugin activation?
4. Should switching to a top-level page keep conversation React state mounted
   off-screen, or is preserving slot registrations and Session state sufficient
   for the initial contract?
