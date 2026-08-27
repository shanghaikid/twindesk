import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSecretReference } from '../packages/domain/dist/index.js'
import { renderRedactedModelContext } from '../packages/plugin-work-hub/dist/model-context.js'

test('the Work Hub model-context serializer removes secret material and hidden reasoning', () => {
  const secret = 'synthetic-model-context-secret'
  const authorizedContent = 'Synthetic authorized fixture context'
  const rendered = renderRedactedModelContext(
    {
      content: authorizedContent,
      apiKey: secret,
      note: `Context containing ${secret}`,
      hiddenReasoning: 'Synthetic hidden reasoning',
      credential: parseSecretReference({
        kind: 'secret_reference',
        schemaVersion: 1,
        id: 'secret-ref:synthetic-model-context',
        store: 'system_keychain',
        purpose: 'model_api_key',
      }),
    },
    [secret],
  )

  assert.equal(rendered.includes(authorizedContent), true)
  assert.equal(rendered.includes(secret), false)
  assert.equal(rendered.includes('Synthetic hidden reasoning'), false)
  assert.equal(rendered.includes('secret-ref:synthetic-model-context'), false)
})
