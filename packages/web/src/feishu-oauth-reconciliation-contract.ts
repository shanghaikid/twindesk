export type FeishuOAuthReconciliationStatus = 'reconciled' | 'still_required'

export interface FeishuOAuthReconciliationSnapshot {
  readonly version: 1
  readonly connectorId: 'feishu'
  readonly status: FeishuOAuthReconciliationStatus
}

function invalid(): never {
  throw new Error('Local API returned an invalid Feishu OAuth reconciliation response.')
}

/** Parse the minimized result of one explicit local reconciliation action. */
export function parseFeishuOAuthReconciliationSnapshot(
  value: unknown,
): FeishuOAuthReconciliationSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Readonly<Record<string, unknown>>
  const keys = Object.keys(record)
  if (
    keys.length !== 3 ||
    !['version', 'connectorId', 'status'].every((key) => Object.hasOwn(record, key)) ||
    record.version !== 1 ||
    record.connectorId !== 'feishu' ||
    (record.status !== 'reconciled' && record.status !== 'still_required')
  ) {
    return invalid()
  }
  return Object.freeze({ version: 1, connectorId: 'feishu', status: record.status })
}
