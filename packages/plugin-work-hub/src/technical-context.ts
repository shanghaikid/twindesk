import { registerReadonlyHarnessTool, type HarnessHostContext } from '@twindesk/harness-adapter'

import { renderRedactedModelContext } from './model-context.ts'

/** Stable preset-scoped Tool plugin name. */
export const name = 'twindesk-technical-context'

/** The Tool registry is the only required Host service. */
export const inject = ['tools']

/** Stable model-facing name available only to the technical-lead Preset. */
export const TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME = 'twindesk_technical_context'

/** Synthetic Stage 0 payload with no external or filesystem reads. */
export const TWIN_DESK_TECHNICAL_CONTEXT = Object.freeze({
  product: 'TwinDesk',
  perspective: 'technical_lead',
  autonomyMode: 'draft_only',
  evidenceRequired: true,
  externalWrites: false,
})

/** Register the technical-lead-only read capability in the Preset's scope. */
export function apply(ctx: HarnessHostContext): void {
  ctx.effect(
    () =>
      registerReadonlyHarnessTool(ctx, {
        name: TWIN_DESK_TECHNICAL_CONTEXT_TOOL_NAME,
        description:
          'Report the synthetic Stage 0 constraints for the TwinDesk technical-lead Persona.',
        async read(signal) {
          signal.throwIfAborted()
          return TWIN_DESK_TECHNICAL_CONTEXT
        },
        render(value) {
          return renderRedactedModelContext(value)
        },
      }),
    'twindesk-work-hub.twindesk-technical-context()',
  )
}
