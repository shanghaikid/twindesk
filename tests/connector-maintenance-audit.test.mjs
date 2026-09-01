import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  ConnectorMaintenanceAuditError,
  openTwinDeskDatabase,
} from '../packages/storage-sqlite/dist/index.js'

const REQUESTED_AT = '2026-09-01T08:00:00.000Z'
const SETTLED_AT = '2026-09-01T08:00:01.000Z'
const PRIVATE_VALUE = 'synthetic-private-maintenance-value'

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-connector-maintenance-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'twindesk.sqlite3')
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [changes]
 * @returns {import('../packages/storage-sqlite/src/connector-maintenance-audit.ts').ConnectorMaintenanceRequest}
 */
function request(id, changes = {}) {
  return /** @type {any} */ ({
    kind: 'connector_maintenance_request',
    schemaVersion: 1,
    id,
    connectorId: 'feishu',
    operation: 'credential_reconciliation',
    requestedAt: REQUESTED_AT,
    ...changes,
  })
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [changes]
 * @returns {import('../packages/storage-sqlite/src/connector-maintenance-audit.ts').ConnectorMaintenanceSettlement}
 */
function settlement(id, changes = {}) {
  return /** @type {any} */ ({
    kind: 'connector_maintenance_settlement',
    schemaVersion: 1,
    id,
    result: 'reconciled',
    settledAt: SETTLED_AT,
    ...changes,
  })
}

test('Connector maintenance request and result Audit persist atomically across restart', async (context) => {
  const path = await temporaryDatabase(context)
  const id = 'connector-maintenance:feishu:oauth:synthetic-success'
  const database = openTwinDeskDatabase(path)
  const started = database.beginConnectorMaintenance(request(id))
  assert.equal(started.disposition, 'inserted')
  assert.equal(started.operation.settlement, undefined)
  assert.deepEqual(database.getPendingConnectorMaintenance('feishu', 'credential_reconciliation'), {
    kind: 'connector_maintenance_operation',
    schemaVersion: 1,
    id,
    connectorId: 'feishu',
    operation: 'credential_reconciliation',
    requestedAt: REQUESTED_AT,
    requestAuditId: `${id}:request`,
  })
  const requestAudit = database.getAuditRecord(/** @type {any} */ (`${id}:request`))
  assert.equal(requestAudit?.outcome, 'pending')
  assert.deepEqual(requestAudit?.references, [{ kind: 'connector', id: 'feishu' }])
  assert.deepEqual(requestAudit?.details, {
    operation: 'credential_reconciliation',
    operationId: id,
    phase: 'request',
  })
  database.close()

  const restarted = openTwinDeskDatabase(path)
  assert.equal(restarted.beginConnectorMaintenance(request(id)).disposition, 'duplicate')
  const settled = restarted.settleConnectorMaintenance(settlement(id))
  assert.equal(settled.disposition, 'inserted')
  assert.deepEqual(settled.operation.settlement, {
    result: 'reconciled',
    settledAt: SETTLED_AT,
    resultAuditId: `${id}:result`,
  })
  assert.equal(
    restarted.getPendingConnectorMaintenance('feishu', 'credential_reconciliation'),
    undefined,
  )
  const resultAudit = restarted.getAuditRecord(/** @type {any} */ (`${id}:result`))
  assert.equal(resultAudit?.outcome, 'success')
  assert.equal(resultAudit?.details.result, 'reconciled')
  assert.equal(restarted.settleConnectorMaintenance(settlement(id)).disposition, 'duplicate')
  restarted.close()

  const immutable = new DatabaseSync(path)
  assert.throws(
    () =>
      immutable
        .prepare(`UPDATE connector_maintenance_operations SET result = 'failed' WHERE id = ?`)
        .run(id),
    /Connector maintenance settlement is immutable/u,
  )
  immutable.close()

  const inspection = new DatabaseSync(path, { readOnly: true })
  context.after(() => inspection.close())
  const serialized = JSON.stringify(
    inspection.prepare('SELECT * FROM connector_maintenance_operations').all(),
  )
  assert.equal(serialized.includes(PRIVATE_VALUE), false)
  assert.equal(serialized.includes('account'), false)
  assert.equal(serialized.includes('principal'), false)
  assert.equal(serialized.includes('secret'), false)
})

test('pending Connector maintenance is exclusive and conflicts fail closed', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  const id = 'connector-maintenance:feishu:oauth:synthetic-conflict'
  database.beginConnectorMaintenance(request(id))
  assert.throws(
    () =>
      database.beginConnectorMaintenance(
        request('connector-maintenance:feishu:oauth:synthetic-competing'),
      ),
    (error) => error instanceof ConnectorMaintenanceAuditError && error.code === 'operation_active',
  )
  assert.throws(
    () => database.beginConnectorMaintenance(request(id, { requestedAt: SETTLED_AT })),
    (error) =>
      error instanceof ConnectorMaintenanceAuditError && error.code === 'operation_conflict',
  )
  database.settleConnectorMaintenance(settlement(id))
  assert.throws(
    () => database.settleConnectorMaintenance(settlement(id, { result: 'failed' })),
    (error) =>
      error instanceof ConnectorMaintenanceAuditError && error.code === 'settlement_conflict',
  )
  assert.equal(database.getConnectorMaintenance(id)?.settlement?.result, 'reconciled')
  const failedId = 'connector-maintenance:feishu:oauth:synthetic-failed'
  database.beginConnectorMaintenance(request(failedId, { requestedAt: SETTLED_AT }))
  database.settleConnectorMaintenance(
    settlement(failedId, {
      result: 'failed',
      settledAt: '2026-09-01T08:00:02.000Z',
    }),
  )
  assert.equal(
    database.getAuditRecord(/** @type {any} */ (`${failedId}:result`))?.outcome,
    'failure',
  )
  database.close()
})

test('an interrupted result Audit leaves a restart-repairable pending operation', async (context) => {
  const path = await temporaryDatabase(context)
  const id = 'connector-maintenance:feishu:oauth:synthetic-repair'
  const database = openTwinDeskDatabase(path)
  database.beginConnectorMaintenance(request(id))
  const fault = new DatabaseSync(path)
  assert.throws(() =>
    fault
      .prepare(
        `UPDATE connector_maintenance_operations
         SET result = 'failed', settled_at = '2026-08-31T23:59:59.000Z',
             result_audit_id = 'synthetic-too-early-result'
         WHERE id = ?`,
      )
      .run(id),
  )
  fault.exec(`
    CREATE TRIGGER synthetic_connector_maintenance_result_failure
    BEFORE INSERT ON audit_references
    WHEN NEW.audit_record_id = '${id}:result'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic private result Audit interruption');
    END;
  `)
  fault.close()
  assert.throws(
    () => database.settleConnectorMaintenance(settlement(id)),
    (error) => {
      assert.ok(error instanceof ConnectorMaintenanceAuditError)
      assert.equal(error.code, 'storage_error')
      assert.equal(error.message.includes('synthetic private'), false)
      return true
    },
  )
  assert.equal(database.getConnectorMaintenance(id)?.settlement, undefined)
  assert.equal(database.getAuditRecord(/** @type {any} */ (`${id}:result`)), undefined)
  database.close()

  const repair = new DatabaseSync(path)
  repair.exec('DROP TRIGGER synthetic_connector_maintenance_result_failure')
  repair.close()
  const restarted = openTwinDeskDatabase(path)
  assert.equal(
    restarted.getPendingConnectorMaintenance('feishu', 'credential_reconciliation')?.id,
    id,
  )
  assert.equal(restarted.settleConnectorMaintenance(settlement(id)).disposition, 'inserted')
  restarted.close()
})

test('Connector maintenance inputs and closed handles fail without inspecting payloads', async (context) => {
  const path = await temporaryDatabase(context)
  const database = openTwinDeskDatabase(path)
  let accessed = false
  const hostile = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      accessed = true
      return PRIVATE_VALUE
    },
  })
  assert.throws(
    () => database.beginConnectorMaintenance(/** @type {never} */ (hostile)),
    (error) => {
      assert.ok(error instanceof ConnectorMaintenanceAuditError)
      assert.equal(error.code, 'invalid_request')
      assert.equal(error.message.includes(PRIVATE_VALUE), false)
      return true
    },
  )
  assert.equal(accessed, false)
  const hostileProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(PRIVATE_VALUE)
      },
    },
  )
  assert.throws(
    () => database.beginConnectorMaintenance(/** @type {never} */ (hostileProxy)),
    (error) => {
      assert.ok(error instanceof ConnectorMaintenanceAuditError)
      assert.equal(error.code, 'invalid_request')
      assert.equal(error.message.includes(PRIVATE_VALUE), false)
      return true
    },
  )
  assert.throws(
    () =>
      database.beginConnectorMaintenance(
        request('invalid-timestamp', { requestedAt: PRIVATE_VALUE }),
      ),
    (error) => {
      assert.ok(error instanceof ConnectorMaintenanceAuditError)
      assert.equal(error.code, 'invalid_request')
      assert.equal(error.message.includes(PRIVATE_VALUE), false)
      return true
    },
  )
  database.close()
  for (const operation of [
    () => database.beginConnectorMaintenance(request('closed-request')),
    () => database.settleConnectorMaintenance(settlement('closed-request')),
    () => database.getConnectorMaintenance('closed-request'),
    () => database.getPendingConnectorMaintenance('feishu', 'credential_reconciliation'),
  ]) {
    assert.throws(
      operation,
      (error) =>
        error instanceof ConnectorMaintenanceAuditError && error.code === 'database_closed',
    )
  }
})
