import type { HarnessClientContext } from '@twindesk/harness-adapter'

interface ReactElementLike {
  readonly type: unknown
  readonly props: Readonly<Record<string, unknown>>
}

interface ReactRuntime {
  createElement(
    type: string,
    props: Readonly<Record<string, unknown>> | null,
    ...children: readonly unknown[]
  ): ReactElementLike
}

declare const require: (specifier: 'react') => ReactRuntime

const { createElement } = require('react')

/** Stable package id used by the Harness lazy-CJS module table. */
export const TWIN_DESK_CLIENT_PLUGIN_ID = '@twindesk/plugin-ui'

/** Host settings namespace whose presence controls whether the card is rendered. */
export const TWIN_DESK_CLIENT_SETTINGS_NAMESPACE = 'twindesk-work-hub'

/** Browser-owned deep link for the Stage 0 Inbox surface. */
export const TWIN_DESK_INBOX_ROUTE = '#/inbox'

/** Stable list identity for the additive sidebar action. */
export const TWIN_DESK_INBOX_NAVIGATION_ID = 'twindesk-inbox'

/** Lower priorities shadow the shipped conversation occupant in Harness SlotCore. */
export const TWIN_DESK_INBOX_PAGE_PRIORITY = -100

/** Required Client service; target slots are reached through package graph edges. */
export const inject = ['slots']

const cardStyle = Object.freeze({
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: '12px',
  display: 'grid',
  gap: '8px',
  padding: '16px',
})

const statusStyle = Object.freeze({
  color: 'var(--dsw-alias-content-success, #16803c)',
  fontWeight: 600,
  margin: 0,
})

const navigationStyle = Object.freeze({
  alignItems: 'center',
  background: 'transparent',
  border: 0,
  borderRadius: '8px',
  color: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  font: 'inherit',
  gap: '10px',
  minHeight: '36px',
  padding: '8px 10px',
  textAlign: 'left',
  width: '100%',
})

const navigationGlyphStyle = Object.freeze({
  alignItems: 'center',
  border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
  borderRadius: '6px',
  display: 'inline-flex',
  fontSize: '11px',
  fontWeight: 700,
  height: '20px',
  justifyContent: 'center',
  width: '20px',
})

const closeButtonStyle = Object.freeze({ ...navigationStyle, width: 'auto' })

const inboxPageStyle = Object.freeze({
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-content-primary, CanvasText)',
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  height: '100%',
  padding: '24px 32px',
  width: '100%',
})

const inboxHeaderStyle = Object.freeze({
  alignItems: 'center',
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
})

const emptyStateStyle = Object.freeze({
  alignSelf: 'center',
  justifyItems: 'center',
  justifySelf: 'center',
  maxWidth: '480px',
  textAlign: 'center',
})

function openInbox(): void {
  if (window.location.hash !== TWIN_DESK_INBOX_ROUTE) {
    window.location.hash = TWIN_DESK_INBOX_ROUTE
  }
}

function closeInbox(): void {
  if (window.location.hash === TWIN_DESK_INBOX_ROUTE) window.location.hash = ''
}

/** Small diagnostic card proving an out-of-tree component reached the settings surface. */
export function TwinDeskCompatibilityCard(): ReactElementLike {
  return createElement(
    'section',
    {
      'aria-label': 'TwinDesk compatibility',
      'data-twindesk-client-plugin': 'ready',
      style: cardStyle,
    },
    createElement('h3', { style: { margin: 0 } }, 'TwinDesk'),
    createElement('p', { style: statusStyle }, 'Client plugin loaded'),
    createElement(
      'p',
      { style: { margin: 0 } },
      'This Stage 0 diagnostic is mounted from an external dsh.client bundle.',
    ),
  )
}

/** Additive sidebar footer entry that opens the plugin-owned Inbox deep link. */
export function TwinDeskInboxNavigation(
  props: Readonly<Record<string, unknown>>,
): ReactElementLike {
  const wide = props['wide'] !== false
  return createElement(
    'button',
    {
      'aria-label': 'Open TwinDesk Inbox',
      'data-twindesk-inbox-navigation': 'ready',
      onClick: openInbox,
      style: navigationStyle,
      title: wide ? undefined : 'Inbox',
      type: 'button',
    },
    createElement('span', { 'aria-hidden': 'true', style: navigationGlyphStyle }, 'IN'),
    wide ? createElement('span', null, 'Inbox') : null,
  )
}

/** Static empty state proving a top-level surface can shadow and restore conversation. */
export function TwinDeskInboxEmptyState(): ReactElementLike {
  return createElement(
    'main',
    {
      'aria-label': 'TwinDesk Inbox',
      'data-twindesk-inbox-page': 'empty',
      style: inboxPageStyle,
    },
    createElement(
      'header',
      { style: inboxHeaderStyle },
      createElement('h1', { style: { fontSize: '24px', margin: 0 } }, 'Inbox'),
      createElement(
        'button',
        {
          'aria-label': 'Return to conversations',
          onClick: closeInbox,
          style: closeButtonStyle,
          type: 'button',
        },
        'Conversations',
      ),
    ),
    createElement(
      'section',
      { style: emptyStateStyle },
      createElement('h2', { style: { margin: '0 0 8px' } }, 'No work items yet'),
      createElement(
        'p',
        { style: { margin: 0 } },
        'Connector-backed Inbox data belongs to Stage 1. This page only validates the Client extension seam.',
      ),
    ),
  )
}

/** Register the diagnostic card and the out-of-tree Stage 0 Inbox surface. */
export function apply(ctx: HarnessClientContext): void {
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: TWIN_DESK_CLIENT_SETTINGS_NAMESPACE,
      },
      TwinDeskCompatibilityCard,
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: TWIN_DESK_INBOX_NAVIGATION_ID,
        order: -100,
      },
      TwinDeskInboxNavigation,
    ),
  )

  ctx.slots.inject('conversation', () => {
    let disposeInboxPage: (() => void) | undefined
    const reconcileRoute = (): void => {
      if (window.location.hash === TWIN_DESK_INBOX_ROUTE) {
        disposeInboxPage ??= ctx.slots.register(
          { name: 'conversation', priority: TWIN_DESK_INBOX_PAGE_PRIORITY },
          TwinDeskInboxEmptyState,
        )
      } else {
        disposeInboxPage?.()
        disposeInboxPage = undefined
      }
    }

    window.addEventListener('hashchange', reconcileRoute)
    try {
      reconcileRoute()
    } catch (error) {
      window.removeEventListener('hashchange', reconcileRoute)
      throw error
    }
    return () => {
      window.removeEventListener('hashchange', reconcileRoute)
      disposeInboxPage?.()
    }
  })
}
