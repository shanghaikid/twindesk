import assert from 'node:assert/strict'
import test from 'node:test'

import { createFixtureInboxService } from '../packages/plugin-work-hub/dist/fixture-inbox.js'
import { parseInboxSnapshot } from '../packages/web/dist/inbox-contract.js'

/** @param {unknown} value @returns {any} */
function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the browser accepts the versioned fixture Inbox response', () => {
  const service = createFixtureInboxService()
  try {
    const snapshot = service.read('needs_review')
    assert.deepEqual(parseInboxSnapshot(copy(snapshot), 'needs_review'), snapshot)
  } finally {
    service.close()
  }
})

test('the browser rejects malformed or inconsistent Inbox responses without echoing data', () => {
  const service = createFixtureInboxService()
  const valid = copy(service.read('needs_review'))
  service.close()

  for (const malformed of [
    { ...valid, version: 2 },
    { ...valid, counts: { ...valid.counts, needs_review: 2 } },
    { ...valid, items: [{ ...valid.items[0], inboxState: 'done' }] },
    { ...valid, items: [{ ...valid.items[0], sourceCount: '<synthetic-secret>' }] },
    {
      ...valid,
      items: [{ ...valid.items[0], context: { status: 'complete', missing: ['unexpected'] } }],
    },
    { ...valid, items: [{ ...valid.items[0], personaId: undefined, personaLabel: 'Unexpected' }] },
    { ...valid, items: [{ ...valid.items[0], personaLabel: 'Mismatched Persona' }] },
    { ...valid, items: [{ ...valid.items[0], updatedAt: 'not-a-timestamp' }] },
    { ...valid, items: [{ ...valid.items[0], updatedAt: '2026-08-26 08:40:00' }] },
  ]) {
    assert.throws(
      () => parseInboxSnapshot(malformed, 'needs_review'),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes('synthetic-secret'), false)
        return true
      },
    )
  }
})
