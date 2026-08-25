import { registerReadonlyHarnessTool, type HarnessToolHostContext } from '@twindesk/harness-adapter'

/** Stable Host plugin name. */
export const name = 'twindesk-work-hub'

/** Wait until the Harness Tool service is available before mounting. */
export const inject = ['tools']

/** Stable model-facing Tool name. */
export const TWIN_DESK_STATUS_TOOL_NAME = 'twindesk_status'

/** Deterministic Stage 0 status payload returned by the read-only Tool. */
export const TWIN_DESK_STATUS = Object.freeze({
  product: 'TwinDesk',
  roadmapStage: 0,
  autonomyMode: 'draft_only',
  ready: true,
})

/**
 * Mount the deterministic TwinDesk status Tool in the Harness registry.
 *
 * The Tool reads no filesystem or network state. Its only asynchronous input
 * is the invocation cancellation signal, which it checks before returning.
 */
export function apply(ctx: HarnessToolHostContext): void {
  ctx.effect(
    () =>
      registerReadonlyHarnessTool(ctx, {
        name: TWIN_DESK_STATUS_TOOL_NAME,
        description:
          'Report the fixed TwinDesk product stage, default autonomy mode, and readiness state.',
        async read(signal) {
          signal.throwIfAborted()
          return TWIN_DESK_STATUS
        },
        render(value) {
          return JSON.stringify(value)
        },
      }),
    'twindesk-work-hub.twindesk-status()',
  )
}
