import { FeishuOAuthRotationJournal } from '@twindesk/plugin-feishu'

export type WorkbenchFeishuOAuthRecoveryState =
  | 'not_started'
  | 'ready'
  | 'rotation_active'
  | 'reauthorization_required'
  | 'reconciliation_required'

export interface WorkbenchFeishuOAuthRecoverySnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly state: WorkbenchFeishuOAuthRecoveryState
}

export interface WorkbenchFeishuOAuthRecoveryPresentation {
  read(): Promise<WorkbenchFeishuOAuthRecoverySnapshot>
}

export interface WorkbenchFeishuOAuthRecoveryPresentationOptions {
  readonly rotationJournal: FeishuOAuthRotationJournal
}

function invalid(): TypeError {
  return new TypeError('The Workbench Feishu OAuth recovery presentation is invalid.')
}

function readJournal(value: unknown): FeishuOAuthRotationJournal {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const rotationJournal = descriptors.rotationJournal
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      rotationJournal === undefined ||
      !Object.hasOwn(rotationJournal, 'value') ||
      !(rotationJournal.value instanceof FeishuOAuthRotationJournal)
    ) {
      throw new TypeError()
    }
    return rotationJournal.value as FeishuOAuthRotationJournal
  } catch {
    throw invalid()
  }
}

function snapshot(state: WorkbenchFeishuOAuthRecoveryState): WorkbenchFeishuOAuthRecoverySnapshot {
  return Object.freeze({ version: 1, connectorId: 'feishu', state })
}

/**
 * Minimize durable rotation evidence for product presentation. This projection
 * deliberately says nothing about current Keychain presence, token validity,
 * granted scopes, or live Feishu connectivity.
 */
export function createWorkbenchFeishuOAuthRecoveryPresentation(
  optionsValue: WorkbenchFeishuOAuthRecoveryPresentationOptions,
): WorkbenchFeishuOAuthRecoveryPresentation {
  const journal = readJournal(optionsValue)
  async function read(): Promise<WorkbenchFeishuOAuthRecoverySnapshot> {
    const latest = await journal.inspect()
    if (latest === undefined) return snapshot('not_started')
    switch (latest.state) {
      case 'completed':
      case 'reauthorized':
        return snapshot('ready')
      case 'reauthorization_required':
        return snapshot('reauthorization_required')
      case 'uncertain':
        return snapshot('reconciliation_required')
      case 'reserved':
        return snapshot(
          journal.isActiveReservation(latest.sequence)
            ? 'rotation_active'
            : 'reconciliation_required',
        )
    }
  }

  return Object.freeze({ read })
}
