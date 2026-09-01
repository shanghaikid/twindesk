import assert from 'node:assert/strict'
import test from 'node:test'

import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import { parseAuditSnapshot } from '../packages/web/dist/audit-contract.js'

/** @param {unknown} value @returns {any} */
function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the browser accepts the versioned presentation-safe Audit response', () => {
  const service = createFixtureInboxService(':memory:', { includeAudit: true })
  try {
    const snapshot = service.readAudit()
    assert.deepEqual(parseAuditSnapshot(copy(snapshot)), snapshot)
  } finally {
    service.close()
  }
})

test('the browser accepts connector-scoped Audit references', () => {
  const service = createFixtureInboxService(':memory:', { includeAudit: true })
  try {
    const snapshot = copy(service.readAudit())
    const item = snapshot.items[0]
    assert.ok(item)
    item.referenceKinds = ['connector']
    assert.deepEqual(parseAuditSnapshot(snapshot).items[0]?.referenceKinds, ['connector'])
  } finally {
    service.close()
  }
})

test('the browser rejects malformed Audit responses without echoing data', () => {
  const service = createFixtureInboxService(':memory:', { includeAudit: true })
  const valid = copy(service.readAudit())
  service.close()
  const secret = 'synthetic-private-audit-value'

  for (const malformed of [
    { ...valid, version: 2 },
    { ...valid, fixture: false },
    { ...valid, items: [{ ...valid.items[0], category: 'unsupported' }] },
    { ...valid, items: [{ ...valid.items[0], outcome: 'unsupported' }] },
    { ...valid, items: [{ ...valid.items[0], actorType: 'unsupported' }] },
    { ...valid, items: [{ ...valid.items[0], actorLabel: { value: secret } }] },
    { ...valid, items: [{ ...valid.items[0], referenceKinds: [] }] },
    { ...valid, items: [{ ...valid.items[0], referenceKinds: ['unsupported'] }] },
    { ...valid, items: [{ ...valid.items[0], occurredAt: 'not-a-timestamp' }] },
    { ...valid, items: [{ ...valid.items[0], internalId: secret }] },
  ]) {
    assert.throws(
      () => parseAuditSnapshot(malformed),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes(secret), false)
        return true
      },
    )
  }
})
