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

/** Required Client service; the target slot is reached through its package graph edge. */
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

/** Register the diagnostic card under the Work Hub settings namespace. */
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
}
