import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseModelDraftCreateRequest,
  parseModelDraftCreateSnapshot,
  parseModelDraftStatusSnapshot,
} from '../packages/web/dist/index.js'

test('model Draft browser contracts accept only minimized versioned data', () => {
  assert.deepEqual(
    parseModelDraftStatusSnapshot({ version: 1, capability: 'ready', autonomy: 'draft_only' }),
    {
      version: 1,
      capability: 'ready',
      autonomy: 'draft_only',
    },
  )
  assert.deepEqual(
    parseModelDraftCreateRequest({ version: 1, workItemId: 'work-item:synthetic' }),
    {
      version: 1,
      workItemId: 'work-item:synthetic',
    },
  )
  assert.deepEqual(
    parseModelDraftCreateSnapshot({
      version: 1,
      disposition: 'created',
      autonomy: 'draft_only',
      externalWritesAvailable: false,
      draft: {
        workItemId: 'work-item:synthetic',
        personaLabel: 'Communication',
        revision: 1,
        state: 'editing',
        content: { mediaType: 'text/plain', text: 'Synthetic local Draft.' },
        updatedAt: '2026-09-02T09:01:00.000Z',
      },
    }),
    {
      version: 1,
      disposition: 'created',
      autonomy: 'draft_only',
      externalWritesAvailable: false,
      draft: {
        workItemId: 'work-item:synthetic',
        personaLabel: 'Communication',
        revision: 1,
        state: 'editing',
        content: { mediaType: 'text/plain', text: 'Synthetic local Draft.' },
        updatedAt: '2026-09-02T09:01:00.000Z',
      },
    },
  )
})

test('model Draft browser intent cannot select runtime, prompt, Persona, or authority', () => {
  for (const extra of [
    { provider: 'browser-provider' },
    { model: 'browser-model' },
    { prompt: 'browser prompt' },
    { personaId: 'communication' },
    { autonomy: 'execute' },
    { apiKey: 'synthetic-secret' },
  ]) {
    assert.throws(
      () =>
        parseModelDraftCreateRequest({ version: 1, workItemId: 'work-item:synthetic', ...extra }),
      /invalid/u,
    )
  }
  assert.throws(
    () =>
      parseModelDraftCreateSnapshot({
        version: 1,
        disposition: 'created',
        autonomy: 'draft_only',
        externalWritesAvailable: true,
        draft: {},
      }),
    /invalid/u,
  )
})
