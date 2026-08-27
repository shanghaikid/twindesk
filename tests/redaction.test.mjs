import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REDACTED_VALUE,
  RedactionConfigurationError,
  parseSecretReference,
  redactForBoundary,
} from '../packages/domain/dist/index.js'

const SECRET = 'synthetic-secret-value-td110'
const COMPANY_TEXT = 'Synthetic confidential project detail'
const HIDDEN_REASONING = 'Synthetic hidden reasoning'

function secretReference() {
  return parseSecretReference({
    kind: 'secret_reference',
    schemaVersion: 1,
    id: 'secret-ref:synthetic-connector-oauth',
    store: 'system_keychain',
    purpose: 'connector_oauth',
  })
}

function fixture() {
  return {
    service: 'twindesk',
    status: 'failure',
    operation: 'fixture_sync',
    apiKey: SECRET,
    authorization: `Bearer ${SECRET}`,
    authorizationHeader: `Bearer ${SECRET}`,
    cookie: `session=${SECRET}`,
    env: { SYNTHETIC_TOKEN: SECRET },
    processEnvironmentVariables: { SYNTHETIC_PASSWORD: SECRET },
    secretReference: 'secret-ref:synthetic-string-locator',
    credentialsRef: 'secret-ref:synthetic-credentials',
    oauthToken: SECRET,
    content: COMPANY_TEXT,
    chainOfThought: HIDDEN_REASONING,
    reference: secretReference(),
    nested: {
      toolName: 'fixture_tool',
      note: `A value containing ${SECRET}`,
    },
    customPrivateField: 'Synthetic explicitly private value',
  }
}

test('diagnostic boundaries preserve bounded metadata and remove content and credentials', () => {
  const boundaries =
    /** @type {import('../packages/domain/src/redaction.ts').RedactionBoundary[]} */ ([
      'logs',
      'errors',
      'telemetry',
    ])
  for (const boundary of boundaries) {
    const input = fixture()
    const result = redactForBoundary(input, {
      boundary,
      knownSecrets: [SECRET],
      sensitiveKeys: ['customPrivateField'],
    })
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(SECRET), false)
    assert.equal(serialized.includes(COMPANY_TEXT), false)
    assert.equal(serialized.includes(HIDDEN_REASONING), false)
    assert.equal(serialized.includes('secret-ref:synthetic-connector-oauth'), false)
    assert.equal(serialized.includes('secret-ref:synthetic-string-locator'), false)
    assert.equal(serialized.includes('Synthetic explicitly private value'), false)
    const value = /** @type {any} */ (result.value)
    assert.equal(value.service, 'twindesk')
    assert.equal(value.status, 'failure')
    assert.equal(value.content, REDACTED_VALUE)
    assert.ok(result.summary.total >= 6)
    assert.equal(result.summary.boundary, boundary)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.value), true)
    assert.equal(input.apiKey, SECRET)
  }
})

test('model context and exports retain authorized content but never secrets or hidden reasoning', () => {
  const boundaries =
    /** @type {import('../packages/domain/src/redaction.ts').RedactionBoundary[]} */ ([
      'model_context',
      'exports',
    ])
  for (const boundary of boundaries) {
    const result = redactForBoundary(fixture(), {
      boundary,
      knownSecrets: [SECRET],
      sensitiveKeys: ['customPrivateField'],
    })
    const serialized = JSON.stringify(result.value)
    assert.equal(serialized.includes(COMPANY_TEXT), true)
    assert.equal(serialized.includes(SECRET), false)
    assert.equal(serialized.includes(HIDDEN_REASONING), false)
    assert.equal(serialized.includes('secret-ref:synthetic-connector-oauth'), false)
    assert.equal(serialized.includes('secret-ref:synthetic-string-locator'), false)
    const value = /** @type {any} */ (result.value)
    assert.equal(value.content, COMPANY_TEXT)
    assert.equal(value.customPrivateField, REDACTED_VALUE)
    assert.ok(result.summary.counts.known_secret >= 1)
    assert.ok(result.summary.counts.secret_reference >= 1)
    assert.ok(result.summary.counts.hidden_reasoning >= 1)
  }
})

test('inline credential patterns are removed without a supplied secret value', () => {
  const privateKey = [
    '-----BEGIN PRIVATE KEY-----',
    'synthetic-key-material',
    '-----END PRIVATE KEY-----',
  ].join('\n')
  const input = [
    'Authorization: Bearer synthetic-bearer-token',
    'auth_header=synthetic-auth-header',
    'api_key=synthetic-api-key',
    'password: synthetic-password',
    privateKey,
  ].join('\n')
  const result = redactForBoundary(input, { boundary: 'exports' })
  const output = String(result.value)
  assert.equal(output.includes('synthetic-bearer-token'), false)
  assert.equal(output.includes('synthetic-auth-header'), false)
  assert.equal(output.includes('synthetic-api-key'), false)
  assert.equal(output.includes('synthetic-password'), false)
  assert.equal(output.includes('synthetic-key-material'), false)
  assert.ok(result.summary.counts.inline_credential >= 5)
})

test('accessors, cycles, unsupported values, and errors fail closed without evaluation', () => {
  let accessed = false
  const accessor = Object.defineProperty({ operation: 'fixture' }, 'payload', {
    enumerable: true,
    get() {
      accessed = true
      return SECRET
    },
  })
  const cyclic = /** @type {any} */ ({ operation: 'fixture', accessor })
  cyclic.self = cyclic
  cyclic.unsupported = () => SECRET
  cyclic.nonFinite = Number.NaN
  cyclic[Symbol('synthetic-secret')] = SECRET
  const redacted = redactForBoundary(cyclic, { boundary: 'logs', knownSecrets: [SECRET] })
  assert.equal(accessed, false)
  assert.equal(JSON.stringify(redacted).includes(SECRET), false)
  assert.ok(redacted.summary.counts.unsafe_value >= 5)

  const error = /** @type {Error & { code?: string, payload?: unknown }} */ (
    new Error(`${COMPANY_TEXT}; access_token=${SECRET}`)
  )
  error.name = 'ConnectorError'
  error.code = 'storage_error'
  error.payload = { secret: SECRET }
  const safeError = redactForBoundary(error, { boundary: 'errors', knownSecrets: [SECRET] })
  assert.deepEqual(safeError.value, {
    name: 'ConnectorError',
    message: REDACTED_VALUE,
    code: 'storage_error',
  })
  assert.equal(JSON.stringify(safeError).includes(SECRET), false)
  assert.equal(JSON.stringify(safeError).includes(COMPANY_TEXT), false)

  let deep = /** @type {any} */ ({ value: 'leaf' })
  for (let index = 0; index < 18; index += 1) deep = { nested: deep }
  const deepResult = redactForBoundary(deep, { boundary: 'exports' })
  assert.ok(deepResult.summary.counts.unsafe_value >= 1)
  const largeArrayResult = redactForBoundary(new Array(10_001).fill('fixture'), {
    boundary: 'exports',
  })
  assert.equal(largeArrayResult.value, REDACTED_VALUE)
})

test('invalid redaction options do not invoke accessors or echo rejected values', () => {
  let accessed = false
  const options = Object.defineProperty({}, 'boundary', {
    enumerable: true,
    get() {
      accessed = true
      return SECRET
    },
  })
  assert.throws(
    () =>
      redactForBoundary(
        fixture(),
        /** @type {import('../packages/domain/src/redaction.ts').RedactionOptions} */ (
          /** @type {unknown} */ (options)
        ),
      ),
    (error) => {
      if (!(error instanceof RedactionConfigurationError)) return false
      assert.equal(error.message.includes(SECRET), false)
      return true
    },
  )
  assert.equal(accessed, false)

  assert.throws(
    () => redactForBoundary(fixture(), { boundary: 'logs', knownSecrets: [SECRET, SECRET] }),
    (error) => error instanceof RedactionConfigurationError,
  )

  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(SECRET)
      },
    },
  )
  const result = redactForBoundary(proxy, { boundary: 'exports', knownSecrets: [SECRET] })
  assert.equal(result.value, REDACTED_VALUE)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})
