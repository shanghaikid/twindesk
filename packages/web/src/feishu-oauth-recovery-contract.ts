export type FeishuOAuthRecoveryState =
  | 'not_started'
  | 'ready'
  | 'rotation_active'
  | 'reauthorization_required'
  | 'reconciliation_required'

export interface FeishuOAuthRecoverySnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly state: FeishuOAuthRecoveryState
}

const STATES: readonly FeishuOAuthRecoveryState[] = Object.freeze([
  'not_started',
  'ready',
  'rotation_active',
  'reauthorization_required',
  'reconciliation_required',
])

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu OAuth recovery response.')
}

/** Parse the exact identifier-free recovery projection before server or browser use. */
export function parseFeishuOAuthRecoverySnapshot(value: unknown): FeishuOAuthRecoverySnapshot {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.length !== 3 ||
      !['version', 'connectorId', 'state'].every((key) => keys.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      return invalid()
    }
    const version = descriptors.version?.value
    const connectorId = descriptors.connectorId?.value
    const state = descriptors.state?.value
    if (
      version !== 1 ||
      connectorId !== 'feishu' ||
      typeof state !== 'string' ||
      !STATES.includes(state as FeishuOAuthRecoveryState)
    ) {
      return invalid()
    }
    return Object.freeze({
      version: 1,
      connectorId: 'feishu',
      state: state as FeishuOAuthRecoveryState,
    })
  } catch {
    return invalid()
  }
}
