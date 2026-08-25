/** Minimal Cordis lifecycle surface used by the Stage 0 Profile spike. */
interface WorkHubHostContext {
  effect(effect: () => () => void, label: string): void
}

/** Stable Host plugin name. */
export const name = 'twindesk-work-hub'

/**
 * Register an owned lifecycle effect without adding product behavior.
 *
 * @param ctx - the Harness-owned Host context, represented by the narrow
 * TwinDesk interface this spike consumes.
 */
export function apply(ctx: WorkHubHostContext): void {
  ctx.effect(() => () => undefined, 'twindesk-work-hub.lifecycle()')
}
