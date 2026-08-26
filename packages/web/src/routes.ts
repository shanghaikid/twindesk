/** Stable identifiers for TwinDesk-owned product pages. */
export type TwinDeskRouteId = 'inbox' | 'personas' | 'connectors' | 'audit' | 'settings'

/** Product navigation metadata that contains no user or Connector data. */
export interface TwinDeskRoute {
  readonly id: TwinDeskRouteId
  readonly path: `/${string}`
  readonly label: string
  readonly eyebrow: string
  readonly description: string
}

/** Product-owned top-level routes in deterministic navigation order. */
export const TWIN_DESK_ROUTES: readonly TwinDeskRoute[] = Object.freeze([
  Object.freeze({
    id: 'inbox',
    path: '/inbox',
    label: 'Inbox',
    eyebrow: 'Work hub',
    description: 'Prioritized work that needs a reply, review, follow-up, or final record.',
  }),
  Object.freeze({
    id: 'personas',
    path: '/personas',
    label: 'Personas',
    eyebrow: 'Identity',
    description: 'Identity and behavior stay separate from Tools, data scopes, and authority.',
  }),
  Object.freeze({
    id: 'connectors',
    path: '/connectors',
    label: 'Connectors',
    eyebrow: 'Sources',
    description: 'Feishu and Jira identities, visibility, synchronization, and health.',
  }),
  Object.freeze({
    id: 'audit',
    path: '/audit',
    label: 'Audit',
    eyebrow: 'Traceability',
    description: 'Sources, Runs, drafts, approvals, Tool calls, receipts, errors, and retries.',
  }),
  Object.freeze({
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    eyebrow: 'Local control',
    description: 'Runtime, retention, model, and local data configuration.',
  }),
])

/** Default route used for the root URL and explicit product-home navigation. */
export const DEFAULT_TWIN_DESK_ROUTE = TWIN_DESK_ROUTES[0] as TwinDeskRoute

/**
 * Resolve one browser pathname without accepting partial or similar matches.
 * @param pathname - URL pathname from the local Web server or browser.
 * @returns the matching product route, or undefined for an unknown path.
 */
export function resolveTwinDeskRoute(pathname: string): TwinDeskRoute | undefined {
  if (pathname === '/') return DEFAULT_TWIN_DESK_ROUTE
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname
  return TWIN_DESK_ROUTES.find((route) => route.path === normalized)
}
