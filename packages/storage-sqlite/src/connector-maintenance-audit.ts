import type { DatabaseSync } from 'node:sqlite'

import { parseAuditRecord, parseIsoTimestamp, type IsoTimestamp } from '@twindesk/domain'

import { appendAuditRecordsInTransaction } from './audit-timeline.ts'

export type ConnectorMaintenanceOperationType = 'credential_reconciliation'
export type ConnectorMaintenanceResult = 'reconciled' | 'still_required' | 'cancelled' | 'failed'

export interface ConnectorMaintenanceRequest {
  readonly kind: 'connector_maintenance_request'
  readonly schemaVersion: 1
  readonly id: string
  readonly connectorId: string
  readonly operation: ConnectorMaintenanceOperationType
  readonly requestedAt: IsoTimestamp
}

export interface ConnectorMaintenanceSettlement {
  readonly kind: 'connector_maintenance_settlement'
  readonly schemaVersion: 1
  readonly id: string
  readonly result: ConnectorMaintenanceResult
  readonly settledAt: IsoTimestamp
}

export interface StoredConnectorMaintenanceOperation {
  readonly kind: 'connector_maintenance_operation'
  readonly schemaVersion: 1
  readonly id: string
  readonly connectorId: string
  readonly operation: ConnectorMaintenanceOperationType
  readonly requestedAt: IsoTimestamp
  readonly requestAuditId: string
  readonly settlement?: Readonly<{
    result: ConnectorMaintenanceResult
    settledAt: IsoTimestamp
    resultAuditId: string
  }>
}

export type ConnectorMaintenanceAuditErrorCode =
  | 'database_closed'
  | 'invalid_request'
  | 'operation_conflict'
  | 'operation_active'
  | 'operation_missing'
  | 'settlement_conflict'
  | 'stored_data_invalid'
  | 'storage_error'

export class ConnectorMaintenanceAuditError extends Error {
  readonly code: ConnectorMaintenanceAuditErrorCode

  constructor(code: ConnectorMaintenanceAuditErrorCode, message: string) {
    super(message)
    this.name = 'ConnectorMaintenanceAuditError'
    this.code = code
  }
}

export interface ConnectorMaintenanceWriteResult {
  readonly disposition: 'inserted' | 'duplicate'
  readonly operation: StoredConnectorMaintenanceOperation
}

interface OperationRow {
  readonly kind: unknown
  readonly schema_version: unknown
  readonly id: unknown
  readonly connector_id: unknown
  readonly operation: unknown
  readonly requested_at: unknown
  readonly request_audit_id: unknown
  readonly result: unknown
  readonly settled_at: unknown
  readonly result_audit_id: unknown
}

const OPERATION_COLUMNS = `kind, schema_version, id, connector_id, operation,
  requested_at, request_audit_id, result, settled_at, result_audit_id`
const RESULTS = Object.freeze(['reconciled', 'still_required', 'cancelled', 'failed'] as const)

function fail(
  code: ConnectorMaintenanceAuditErrorCode,
  message: string,
): ConnectorMaintenanceAuditError {
  return new ConnectorMaintenanceAuditError(code, message)
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the typed operation failure.
  }
}

function dataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('invalid_request', 'The Connector maintenance request is invalid.')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    throw fail('invalid_request', 'The Connector maintenance request is invalid.')
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    ),
  )
}

function operationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 180 ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(value)
  ) {
    throw fail('invalid_request', 'The Connector maintenance identity is invalid.')
  }
  return value
}

function connectorId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw fail('invalid_request', 'The Connector maintenance identity is invalid.')
  }
  return value
}

function timestamp(value: unknown): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail('invalid_request', 'The Connector maintenance timestamp is invalid.')
  }
}

function requestAt(value: unknown): ConnectorMaintenanceRequest {
  try {
    const record = dataRecord(value, [
      'kind',
      'schemaVersion',
      'id',
      'connectorId',
      'operation',
      'requestedAt',
    ])
    if (
      record.kind !== 'connector_maintenance_request' ||
      record.schemaVersion !== 1 ||
      record.operation !== 'credential_reconciliation'
    ) {
      throw fail('invalid_request', 'The Connector maintenance request is invalid.')
    }
    return Object.freeze({
      kind: 'connector_maintenance_request',
      schemaVersion: 1,
      id: operationId(record.id),
      connectorId: connectorId(record.connectorId),
      operation: 'credential_reconciliation',
      requestedAt: timestamp(record.requestedAt),
    })
  } catch (error) {
    if (error instanceof ConnectorMaintenanceAuditError) throw error
    throw fail('invalid_request', 'The Connector maintenance request is invalid.')
  }
}

function settlementAt(value: unknown): ConnectorMaintenanceSettlement {
  try {
    const record = dataRecord(value, ['kind', 'schemaVersion', 'id', 'result', 'settledAt'])
    if (
      record.kind !== 'connector_maintenance_settlement' ||
      record.schemaVersion !== 1 ||
      typeof record.result !== 'string' ||
      !RESULTS.includes(record.result as ConnectorMaintenanceResult)
    ) {
      throw fail('invalid_request', 'The Connector maintenance settlement is invalid.')
    }
    return Object.freeze({
      kind: 'connector_maintenance_settlement',
      schemaVersion: 1,
      id: operationId(record.id),
      result: record.result as ConnectorMaintenanceResult,
      settledAt: timestamp(record.settledAt),
    })
  } catch (error) {
    if (error instanceof ConnectorMaintenanceAuditError) throw error
    throw fail('invalid_request', 'The Connector maintenance settlement is invalid.')
  }
}

function storedOperation(row: OperationRow): StoredConnectorMaintenanceOperation {
  try {
    if (
      row.kind !== 'connector_maintenance_operation' ||
      row.schema_version !== 1 ||
      row.operation !== 'credential_reconciliation' ||
      typeof row.request_audit_id !== 'string'
    ) {
      throw new TypeError()
    }
    const base = {
      kind: 'connector_maintenance_operation' as const,
      schemaVersion: 1 as const,
      id: operationId(row.id),
      connectorId: connectorId(row.connector_id),
      operation: 'credential_reconciliation' as const,
      requestedAt: parseIsoTimestamp(row.requested_at),
      requestAuditId: row.request_audit_id,
    }
    if (row.result === null) {
      if (row.settled_at !== null || row.result_audit_id !== null) throw new TypeError()
      return Object.freeze(base)
    }
    if (
      typeof row.result !== 'string' ||
      !RESULTS.includes(row.result as ConnectorMaintenanceResult) ||
      typeof row.result_audit_id !== 'string'
    ) {
      throw new TypeError()
    }
    const settledAt = parseIsoTimestamp(row.settled_at)
    if (Date.parse(settledAt) < Date.parse(base.requestedAt)) throw new TypeError()
    return Object.freeze({
      ...base,
      settlement: Object.freeze({
        result: row.result as ConnectorMaintenanceResult,
        settledAt,
        resultAuditId: row.result_audit_id,
      }),
    })
  } catch {
    throw fail('stored_data_invalid', 'A stored Connector maintenance operation is invalid.')
  }
}

function readOperation(
  database: DatabaseSync,
  id: string,
): StoredConnectorMaintenanceOperation | undefined {
  const row = database
    .prepare(`SELECT ${OPERATION_COLUMNS} FROM connector_maintenance_operations WHERE id = ?`)
    .get(id) as OperationRow | undefined
  return row === undefined ? undefined : storedOperation(row)
}

function requestAudit(request: ConnectorMaintenanceRequest) {
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: `${request.id}:request`,
    category: 'system',
    outcome: 'pending',
    actor: { type: 'user', id: 'local-user' },
    summary: 'Local Connector credential reconciliation requested.',
    references: [{ kind: 'connector', id: request.connectorId }],
    details: {
      operation: request.operation,
      operationId: request.id,
      phase: 'request',
    },
    occurredAt: request.requestedAt,
  })
}

function resultAudit(
  operation: StoredConnectorMaintenanceOperation,
  settlement: ConnectorMaintenanceSettlement,
) {
  const outcome =
    settlement.result === 'reconciled'
      ? 'success'
      : settlement.result === 'still_required'
        ? 'uncertain'
        : settlement.result === 'failed'
          ? 'failure'
          : 'cancelled'
  return parseAuditRecord({
    kind: 'audit_record',
    schemaVersion: 1,
    id: `${operation.id}:result`,
    category: 'system',
    outcome,
    actor: { type: 'system' },
    summary:
      settlement.result === 'reconciled'
        ? 'Local Connector credential reconciliation completed.'
        : settlement.result === 'still_required'
          ? 'Local Connector credential reconciliation still requires attention.'
          : settlement.result === 'cancelled'
            ? 'Local Connector credential reconciliation was cancelled.'
            : 'Local Connector credential reconciliation failed.',
    references: [{ kind: 'connector', id: operation.connectorId }],
    details: {
      operation: operation.operation,
      operationId: operation.id,
      phase: 'result',
      result: settlement.result,
    },
    occurredAt: settlement.settledAt,
  })
}

function sameRequest(
  operation: StoredConnectorMaintenanceOperation,
  request: ConnectorMaintenanceRequest,
): boolean {
  return (
    operation.id === request.id &&
    operation.connectorId === request.connectorId &&
    operation.operation === request.operation &&
    operation.requestedAt === request.requestedAt
  )
}

export function beginConnectorMaintenance(
  database: DatabaseSync,
  requestValue: ConnectorMaintenanceRequest,
): ConnectorMaintenanceWriteResult {
  const request = requestAt(requestValue)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The Connector maintenance transaction could not start.')
  }
  try {
    const existing = readOperation(database, request.id)
    if (existing !== undefined) {
      if (!sameRequest(existing, request)) {
        throw fail('operation_conflict', 'The Connector maintenance identity conflicts.')
      }
      appendAuditRecordsInTransaction(database, [requestAudit(request)])
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', operation: existing })
    }
    const active = database
      .prepare(
        `SELECT id FROM connector_maintenance_operations
         WHERE connector_id = ? AND operation = ? AND result IS NULL`,
      )
      .get(request.connectorId, request.operation)
    if (active !== undefined) {
      throw fail('operation_active', 'A Connector maintenance operation is already pending.')
    }
    const audit = requestAudit(request)
    appendAuditRecordsInTransaction(database, [audit])
    database
      .prepare(
        `INSERT INTO connector_maintenance_operations (
           kind, schema_version, id, connector_id, operation, requested_at, request_audit_id
         ) VALUES ('connector_maintenance_operation', 1, ?, ?, ?, ?, ?)`,
      )
      .run(request.id, request.connectorId, request.operation, request.requestedAt, audit.id)
    const operation = readOperation(database, request.id)
    if (operation === undefined) throw new TypeError()
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', operation })
  } catch (error) {
    rollback(database)
    if (error instanceof ConnectorMaintenanceAuditError) throw error
    throw fail('storage_error', 'The Connector maintenance request could not be stored.')
  }
}

export function settleConnectorMaintenance(
  database: DatabaseSync,
  settlementValue: ConnectorMaintenanceSettlement,
): ConnectorMaintenanceWriteResult {
  const settlement = settlementAt(settlementValue)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch {
    throw fail('storage_error', 'The Connector maintenance transaction could not start.')
  }
  try {
    const operation = readOperation(database, settlement.id)
    if (operation === undefined) {
      throw fail('operation_missing', 'The Connector maintenance operation is missing.')
    }
    if (Date.parse(settlement.settledAt) < Date.parse(operation.requestedAt)) {
      throw fail('invalid_request', 'The Connector maintenance settlement is too early.')
    }
    if (operation.settlement !== undefined) {
      if (
        operation.settlement.result !== settlement.result ||
        operation.settlement.settledAt !== settlement.settledAt ||
        operation.settlement.resultAuditId !== `${operation.id}:result`
      ) {
        throw fail('settlement_conflict', 'The Connector maintenance settlement conflicts.')
      }
      const audit = resultAudit(operation, settlement)
      appendAuditRecordsInTransaction(database, [audit])
      database.exec('COMMIT')
      return Object.freeze({ disposition: 'duplicate', operation })
    }
    const audit = resultAudit(operation, settlement)
    appendAuditRecordsInTransaction(database, [audit])
    const updated = database
      .prepare(
        `UPDATE connector_maintenance_operations
         SET result = ?, settled_at = ?, result_audit_id = ?
         WHERE id = ? AND result IS NULL`,
      )
      .run(settlement.result, settlement.settledAt, audit.id, operation.id)
    if (updated.changes !== 1) throw new TypeError()
    const settled = readOperation(database, operation.id)
    if (settled?.settlement === undefined) throw new TypeError()
    database.exec('COMMIT')
    return Object.freeze({ disposition: 'inserted', operation: settled })
  } catch (error) {
    rollback(database)
    if (error instanceof ConnectorMaintenanceAuditError) throw error
    throw fail('storage_error', 'The Connector maintenance settlement could not be stored.')
  }
}

export function readConnectorMaintenanceOperation(
  database: DatabaseSync,
  idValue: string,
): StoredConnectorMaintenanceOperation | undefined {
  return readOperation(database, operationId(idValue))
}

export function readPendingConnectorMaintenance(
  database: DatabaseSync,
  connectorIdValue: string,
  operationValue: ConnectorMaintenanceOperationType,
): StoredConnectorMaintenanceOperation | undefined {
  const parsedConnectorId = connectorId(connectorIdValue)
  if (operationValue !== 'credential_reconciliation') {
    throw fail('invalid_request', 'The Connector maintenance operation is invalid.')
  }
  const row = database
    .prepare(
      `SELECT ${OPERATION_COLUMNS} FROM connector_maintenance_operations
       WHERE connector_id = ? AND operation = ? AND result IS NULL`,
    )
    .get(parsedConnectorId, operationValue) as OperationRow | undefined
  return row === undefined ? undefined : storedOperation(row)
}
