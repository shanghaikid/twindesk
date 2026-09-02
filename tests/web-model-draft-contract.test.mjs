import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseModelDraftCreateRequest,
  parseModelDraftCreateSnapshot,
  parseModelDraftEditRequest,
  parseModelDraftEditSnapshot,
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
    parseModelDraftEditRequest({
      version: 1,
      workItemId: 'work-item:synthetic',
      sourceRevision: 1,
      content: { mediaType: 'text/plain', text: 'A local user edit.' },
      submitForReview: true,
    }),
    {
      version: 1,
      workItemId: 'work-item:synthetic',
      sourceRevision: 1,
      content: { mediaType: 'text/plain', text: 'A local user edit.' },
      submitForReview: true,
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
  assert.deepEqual(
    parseModelDraftEditSnapshot({
      version: 1,
      disposition: 'submitted',
      autonomy: 'draft_only',
      externalWritesAvailable: false,
      draft: {
        workItemId: 'work-item:synthetic',
        personaLabel: 'Communication',
        revision: 2,
        state: 'ready_for_review',
        content: { mediaType: 'text/plain', text: 'A local user edit.' },
        updatedAt: '2026-09-02T09:02:00.000Z',
      },
    }),
    {
      version: 1,
      disposition: 'submitted',
      autonomy: 'draft_only',
      externalWritesAvailable: false,
      draft: {
        workItemId: 'work-item:synthetic',
        personaLabel: 'Communication',
        revision: 2,
        state: 'ready_for_review',
        content: { mediaType: 'text/plain', text: 'A local user edit.' },
        updatedAt: '2026-09-02T09:02:00.000Z',
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
  assert.throws(
    () =>
      parseModelDraftCreateSnapshot({
        version: 1,
        disposition: 'submitted',
        autonomy: 'draft_only',
        externalWritesAvailable: false,
        draft: {},
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseModelDraftEditSnapshot({
        version: 1,
        disposition: 'created',
        autonomy: 'draft_only',
        externalWritesAvailable: false,
        draft: {},
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseModelDraftEditRequest({
        version: 1,
        workItemId: 'work-item:synthetic',
        sourceRevision: 1,
        content: { mediaType: 'text/plain', text: 'Synthetic edit.' },
        submitForReview: true,
        approved: true,
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseModelDraftEditRequest({
        version: 1,
        workItemId: 'work-item:synthetic',
        sourceRevision: 100,
        content: { mediaType: 'text/plain', text: 'Synthetic edit.' },
        submitForReview: false,
      }),
    /invalid/u,
  )
  assert.throws(
    () =>
      parseModelDraftEditSnapshot({
        version: 1,
        disposition: 'saved',
        autonomy: 'draft_only',
        externalWritesAvailable: false,
        draft: {
          workItemId: 'work-item:synthetic',
          personaLabel: 'Communication',
          revision: 101,
          state: 'editing',
          content: { mediaType: 'text/plain', text: 'Synthetic edit.' },
          updatedAt: '2026-09-02T09:02:00.000Z',
        },
      }),
    /invalid/u,
  )
})
