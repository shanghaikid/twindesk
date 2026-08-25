# ADR 0001: Upstream Generic Inbox Extension Points

- Status: Accepted
- Date: 2026-08-25
- Decision owner: TwinDesk maintainers
- Tracker: TD-032

## Context

TD-031 proved that DeepSeek Harness `0.1.1-rc.2` can display an external Inbox without a core patch. The TwinDesk Client plugin owns `#/inbox`, contributes a `sidebar.footer.action`, and temporarily shadows the top-level `conversation` slot.

Those seams are adequate for a compatibility spike but not for the product Inbox:

- Harness has no public Router, route registry, or navigation service, so the plugin cannot participate in browser history and route ownership through a Harness contract.
- The only additive sidebar action is in the footer, not the primary navigation region where a top-level Inbox belongs.
- Shadowing `conversation` relies on global priority arbitration and removes the conversation-owned child slots while active.
- Another plugin can collide with the route, navigation identity, or replacement priority without a common page-registration contract.

TwinDesk must choose whether to accept these constraints, propose generic upstream support, or maintain a Harness patch.

## Pinned Upstream Evidence

The decision is based on the exact Harness commit pinned by TwinDesk, not a floating branch:

- The published layout contract declares `sidebar`, `conversation`, `details`, and `shell.overlay`; its documentation states that replacing `conversation` also removes the occupant's child slots ([pinned `ui-layout` source](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-layout/src/client/index.ts#L33-L83)).
- The sidebar declares brand, workspace, settings, and `sidebar.footer.action` children, with no additive primary-navigation list ([pinned `ui-sidebar` source](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-sidebar/src/client/index.ts#L41-L53)).
- SlotCore defines lower-priority cell shadowing, exact-priority collision failure, and priority-ordered entries ([pinned `ui-slots` source](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-slots/src/index.ts#L721-L723), [registration and ordering implementation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-slots/src/index.ts#L795-L868)).

The absence of a public Router, page registry, and primary-navigation list is an observation of this pinned public Client surface. It is not a claim about future Harness versions.

## Decision

TwinDesk will propose a product-neutral upstream extension point for primary navigation and keyed top-level pages. TwinDesk will not maintain a Harness fork or a temporary core patch for the Inbox.

The smallest acceptable upstream contract consists of:

1. An additive primary-navigation list whose entries have stable identifiers, deterministic ordering, collapsed and expanded rendering support, and ordinary plugin disposal semantics.
2. A root-scoped page and navigation service that registers keyed pages, owns their deep links, exposes the active page, integrates with browser back and forward navigation, rejects key and path collisions clearly, and removes registrations cleanly on plugin disposal.
3. A render seat for the active registered page that does not require replacing `conversation` or any other feature-owned slot.

The contract must remain generic. It must not contain TwinDesk names, Work Item schemas, Connector behavior, Persona rules, credentials, approval logic, or any other TwinDesk domain concern.

The current hash route and conversation shadow remain a Stage 0 compatibility diagnostic only. They are not the supported implementation path for the Stage 1 product Inbox. Stage 1 Inbox UI work must target a released, exactly pinned Harness version that exposes the generic contract. If that contract is unavailable at the Stage 0 exit review, the project must record a new ADR and explicitly choose between accepting the out-of-tree limitations or maintaining a temporary patch; it must not introduce a patch silently.

## Ownership

Harness upstream owns the generic navigation service, page registry, primary-navigation render seam, collision behavior, browser-history integration, and lifecycle contract.

TwinDesk owns its external plugin registration, Inbox route key and presentation, all Work Hub data and actions, compatibility probes, and migration away from the Stage 0 diagnostic path.

No TwinDesk domain type or business behavior may enter Harness core. A separate upstream contribution, if created, must be independently useful to other Client plugins.

## Upgrade Consequences

- TwinDesk continues pinning an exact Harness version and does not consume a floating upstream branch while the proposal is developed.
- A Harness release is eligible for adoption only after adapter and live-Profile checks cover page registration, primary-navigation registration, direct deep-link load, back and forward navigation, collision failure, disposal, and reload recovery.
- The temporary `#/inbox` listener and `conversation` priority probe stay in the compatibility suite until migration, then are removed in the same change that adopts the public contract.
- An upstream rename or semantic change fails the compatibility suite before an upgrade is accepted.
- If upstream rejects or materially changes the proposal, TwinDesk reassesses the decision in a superseding ADR. Rejection alone does not authorize a local core patch.

## Consequences

### Positive

- TwinDesk keeps a replaceable, out-of-tree integration and avoids carrying a fork.
- Route ownership, navigation placement, history behavior, collisions, and teardown become explicit public contracts.
- The product Inbox can coexist with Harness conversations and other plugins without priority-based replacement.

### Negative

- The product Inbox UI now depends on an upstream API that does not exist in the pinned release.
- Stage 1 cannot treat the TD-031 page-switching technique as production architecture.
- TwinDesk must prepare and maintain an upstream-quality generic proposal and compatibility coverage.

## Alternatives Considered

### Keep the current out-of-tree workaround permanently

Rejected for the product path. It proves viability but gives TwinDesk private route ownership, footer-only navigation, and priority-based replacement without a shared routing lifecycle.

### Maintain a minimal temporary Harness patch

Rejected. No immediate product delivery requires a patch during Stage 0, and carrying one would add merge, release, security-review, and support obligations before upstream feasibility is known.

### Replace the complete sidebar or layout slot

Rejected. Replacing feature-owned shells would also replace their child-slot declarations and couple TwinDesk to substantially more Harness presentation behavior than the requested generic seam.
