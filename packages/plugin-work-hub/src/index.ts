import {
  registerBooleanHarnessSetting,
  registerReadonlyHarnessTool,
  type HarnessHostContext,
} from '@twindesk/harness-adapter'

import { renderRedactedModelContext } from './model-context.ts'

export * from './action-execution-host.ts'
export * from './model-draft-linkage.ts'
export { renderRedactedModelContext } from './model-context.ts'

/** Stable Host plugin name. */
export const name = 'twindesk-work-hub'

/** Wait until the Harness settings and Tool services are available before mounting. */
export const inject = ['settings', 'tools']

/** Stable model-facing Tool name. */
export const TWIN_DESK_STATUS_TOOL_NAME = 'twindesk_status'

/** Stable namespace for Work Hub-owned, non-secret user settings. */
export const TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE = 'twindesk-work-hub'

/** The only declared Work Hub setting in the Stage 0 compatibility spike. */
export const TWIN_DESK_INCLUDE_ROADMAP_STAGE_SETTING = 'includeRoadmapStage'

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
export function apply(ctx: HarnessHostContext): void {
  const settings = registerBooleanHarnessSetting(ctx, {
    namespace: TWIN_DESK_WORK_HUB_SETTINGS_NAMESPACE,
    key: TWIN_DESK_INCLUDE_ROADMAP_STAGE_SETTING,
    defaultValue: true,
    description: 'Include the numeric roadmap stage in twindesk_status results.',
    applies: 'live',
  })

  ctx.effect(
    () =>
      registerReadonlyHarnessTool(ctx, {
        name: TWIN_DESK_STATUS_TOOL_NAME,
        description:
          'Report TwinDesk product status; user settings may omit the numeric roadmap stage.',
        async read(signal) {
          signal.throwIfAborted()
          if (settings.get().includeRoadmapStage) return TWIN_DESK_STATUS
          const { roadmapStage: _roadmapStage, ...statusWithoutRoadmapStage } = TWIN_DESK_STATUS
          return statusWithoutRoadmapStage
        },
        render(value) {
          return renderRedactedModelContext(value)
        },
      }),
    'twindesk-work-hub.twindesk-status()',
  )
}
