import type { JsonValue } from './model.ts'

export const REDACTED_VALUE = '[REDACTED]' as const

export type RedactionBoundary = 'logs' | 'model_context' | 'errors' | 'telemetry' | 'exports'

export type RedactionReason =
  | 'credential_field'
  | 'secret_reference'
  | 'known_secret'
  | 'inline_credential'
  | 'hidden_reasoning'
  | 'business_content'
  | 'unsafe_value'

export interface RedactionOptions {
  readonly boundary: RedactionBoundary
  /** Exact secret values currently in memory. Values are never returned in metadata. */
  readonly knownSecrets?: readonly string[]
  /** Additional field names that the caller knows must not cross this boundary. */
  readonly sensitiveKeys?: readonly string[]
}

export interface RedactionSummary {
  readonly boundary: RedactionBoundary
  readonly total: number
  readonly counts: Readonly<Record<RedactionReason, number>>
}

export interface RedactionResult {
  readonly value: JsonValue
  readonly summary: RedactionSummary
}

/** Configuration failure with no rejected key or value in its diagnostic. */
export class RedactionConfigurationError extends TypeError {
  constructor() {
    super('The redaction configuration is invalid.')
    this.name = 'RedactionConfigurationError'
  }
}

const BOUNDARIES = Object.freeze([
  'logs',
  'model_context',
  'errors',
  'telemetry',
  'exports',
] as const)
const REASONS = Object.freeze([
  'credential_field',
  'secret_reference',
  'known_secret',
  'inline_credential',
  'hidden_reasoning',
  'business_content',
  'unsafe_value',
] as const)
const DIAGNOSTIC_BOUNDARIES = new Set<RedactionBoundary>(['logs', 'errors', 'telemetry'])
const HIDDEN_REASONING_KEYS = new Set([
  'chainofthought',
  'hiddenreasoning',
  'internalreasoning',
  'modelreasoning',
])
const BUSINESS_CONTENT_KEYS = new Set([
  'attentionreason',
  'content',
  'contenttext',
  'details',
  'displayname',
  'externalid',
  'issuesummary',
  'messages',
  'normalized',
  'payload',
  'prompt',
  'rationale',
  'rawpayload',
  'subject',
  'summary',
  'text',
  'title',
  'toolarguments',
  'toolresult',
])
const SAFE_DIAGNOSTIC_TEXT_KEYS = new Set([
  'actortype',
  'boundary',
  'category',
  'code',
  'component',
  'connectorid',
  'kind',
  'mediatype',
  'operation',
  'occurredat',
  'outcome',
  'reason',
  'referencekind',
  'referencekinds',
  'retrydisposition',
  'service',
  'attemptedat',
  'committedthrough',
  'createdat',
  'decidedat',
  'expiresat',
  'receivedat',
  'requestedat',
  'state',
  'status',
  'store',
  'timestamp',
  'toolname',
  'type',
  'updatedat',
])

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, '').toLowerCase()
}

function isCredentialKey(normalized: string): boolean {
  if (
    /^(?:authorization|proxyauthorization|auth)(?:header)?$/u.test(normalized) ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized === 'env' ||
    /^(?:process)?environment(?:variables)?$/u.test(normalized) ||
    normalized === 'processenv' ||
    normalized === 'oauth'
  ) {
    return true
  }
  return (
    /(?:password|passphrase|secret|apikey|accesstoken|refreshtoken|idtoken|sessiontoken|privatekey|credential|credentials)$/u.test(
      normalized,
    ) ||
    /(?:token|secrets?(?:ref|reference|id)|credentials?(?:ref|reference|id)|keychain(?:ref|reference|id))$/u.test(
      normalized,
    )
  )
}

function dataObject(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RedactionConfigurationError()
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RedactionConfigurationError()
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new RedactionConfigurationError()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof RedactionConfigurationError) throw error
    throw new RedactionConfigurationError()
  }
}

function stringList(value: unknown, maximum: number): readonly string[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new RedactionConfigurationError()
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = (descriptors as Record<string, PropertyDescriptor>).length?.value
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > maximum ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    ) {
      throw new RedactionConfigurationError()
    }
    const result: string[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)]
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0 ||
        descriptor.value.length > 4096
      ) {
        throw new RedactionConfigurationError()
      }
      result.push(descriptor.value)
    }
    if (new Set(result).size !== result.length) throw new RedactionConfigurationError()
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof RedactionConfigurationError) throw error
    throw new RedactionConfigurationError()
  }
}

function parseOptions(value: RedactionOptions): {
  readonly boundary: RedactionBoundary
  readonly knownSecrets: readonly string[]
  readonly sensitiveKeys: ReadonlySet<string>
} {
  const options = dataObject(value)
  const keys = Object.keys(options)
  if (
    !Object.hasOwn(options, 'boundary') ||
    keys.some((key) => !['boundary', 'knownSecrets', 'sensitiveKeys'].includes(key)) ||
    typeof options.boundary !== 'string' ||
    !BOUNDARIES.includes(options.boundary as RedactionBoundary)
  ) {
    throw new RedactionConfigurationError()
  }
  const knownSecrets = Object.hasOwn(options, 'knownSecrets')
    ? stringList(options.knownSecrets, 128)
    : Object.freeze([])
  const sensitiveKeys = Object.hasOwn(options, 'sensitiveKeys')
    ? stringList(options.sensitiveKeys, 128)
    : Object.freeze([])
  return Object.freeze({
    boundary: options.boundary as RedactionBoundary,
    knownSecrets,
    sensitiveKeys: new Set(sensitiveKeys.map(normalizeKey)),
  })
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

/**
 * Redact one value for an explicit outbound boundary.
 *
 * Diagnostic boundaries preserve only allowlisted structured metadata text.
 * Model context and exports may retain authorized business text, but credentials,
 * secret locators, known secret values, and hidden reasoning are always removed.
 */
export function redactForBoundary(value: unknown, rawOptions: RedactionOptions): RedactionResult {
  const options = parseOptions(rawOptions)
  const counts: Record<RedactionReason, number> = {
    credential_field: 0,
    secret_reference: 0,
    known_secret: 0,
    inline_credential: 0,
    hidden_reasoning: 0,
    business_content: 0,
    unsafe_value: 0,
  }
  const diagnostic = DIAGNOSTIC_BOUNDARIES.has(options.boundary)
  const knownPattern =
    options.knownSecrets.length === 0
      ? undefined
      : new RegExp(
          options.knownSecrets
            .toSorted((left, right) => right.length - left.length)
            .map(regexEscape)
            .join('|'),
          'gu',
        )
  const seen = new WeakSet<object>()
  let nodes = 0

  const replacePattern = (
    input: string,
    pattern: RegExp,
    replacement: string | ((...matches: string[]) => string),
    reason: RedactionReason,
  ): string =>
    input.replace(pattern, (...matches: string[]) => {
      counts[reason] += 1
      return typeof replacement === 'string' ? replacement : replacement(...matches)
    })

  const redactText = (input: string): string => {
    let output = input
    if (knownPattern !== undefined) {
      output = replacePattern(output, knownPattern, REDACTED_VALUE, 'known_secret')
    }
    output = replacePattern(
      output,
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu,
      REDACTED_VALUE,
      'inline_credential',
    )
    output = replacePattern(
      output,
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
      `Bearer ${REDACTED_VALUE}`,
      'inline_credential',
    )
    output = replacePattern(
      output,
      /\b(authorization(?:[_-]?header)?|proxy[_-]?authorization(?:[_-]?header)?|auth[_-]?header|cookie(?:[_-]?header)?|set[_-]?cookie)\s*([:=])\s*[^\r\n]+/giu,
      (_match, name, separator) => `${name}${separator}${REDACTED_VALUE}`,
      'inline_credential',
    )
    output = replacePattern(
      output,
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      (_match, name, separator) => `${name}${separator}${REDACTED_VALUE}`,
      'inline_credential',
    )
    return output
  }

  const replace = (reason: RedactionReason): typeof REDACTED_VALUE => {
    counts[reason] += 1
    return REDACTED_VALUE
  }

  const visit = (entry: unknown, depth: number, diagnosticTextAllowed: boolean): JsonValue => {
    nodes += 1
    if (nodes > 10_000 || depth > 16) return replace('unsafe_value')
    if (entry === null || typeof entry === 'boolean') return entry
    if (typeof entry === 'number') {
      return Number.isFinite(entry) ? entry : replace('unsafe_value')
    }
    if (typeof entry === 'string') {
      if (entry.length > 1_000_000) return replace('unsafe_value')
      if (diagnostic && !diagnosticTextAllowed) return replace('business_content')
      return redactText(entry)
    }
    if (typeof entry !== 'object') return replace('unsafe_value')

    if (seen.has(entry)) return replace('unsafe_value')
    seen.add(entry)

    let errorValue = false
    try {
      errorValue = entry instanceof Error
    } catch {
      return replace('unsafe_value')
    }
    if (errorValue) {
      if (options.boundary !== 'errors') return replace('unsafe_value')
      try {
        const descriptors = Object.getOwnPropertyDescriptors(entry)
        const ownName = descriptors.name?.value
        const ownCode = descriptors.code?.value
        const safeName =
          typeof ownName === 'string' && /^[A-Za-z][A-Za-z0-9]*Error$/u.test(ownName)
            ? ownName
            : 'Error'
        const safeCode =
          typeof ownCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(ownCode)
            ? ownCode
            : undefined
        counts.business_content += 1
        return Object.freeze({
          name: safeName,
          message: REDACTED_VALUE,
          ...(safeCode === undefined ? {} : { code: safeCode }),
        })
      } catch {
        return replace('unsafe_value')
      }
    }

    if (Array.isArray(entry)) {
      try {
        const descriptors = Object.getOwnPropertyDescriptors(entry)
        const length = (descriptors as Record<string, PropertyDescriptor>).length?.value
        if (
          !Number.isSafeInteger(length) ||
          (length as number) < 0 ||
          (length as number) > 10_000
        ) {
          return replace('unsafe_value')
        }
        if (
          Object.entries(descriptors).some(
            ([key, descriptor]) => key !== 'length' && !Object.hasOwn(descriptor, 'value'),
          )
        ) {
          return replace('unsafe_value')
        }
        const result: JsonValue[] = []
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = descriptors[String(index)]
          result.push(
            descriptor !== undefined && Object.hasOwn(descriptor, 'value')
              ? visit(descriptor.value, depth + 1, diagnosticTextAllowed)
              : replace('unsafe_value'),
          )
        }
        return Object.freeze(result)
      } catch {
        return replace('unsafe_value')
      }
    }

    let descriptors: PropertyDescriptorMap
    try {
      const prototype = Object.getPrototypeOf(entry) as unknown
      if (prototype !== Object.prototype && prototype !== null) return replace('unsafe_value')
      descriptors = Object.getOwnPropertyDescriptors(entry)
    } catch {
      return replace('unsafe_value')
    }
    if (
      Object.keys(descriptors).length > 10_000 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      return replace('unsafe_value')
    }
    if (descriptors.kind?.value === 'secret_reference') {
      return replace('secret_reference')
    }

    const result: Record<string, JsonValue> = {}
    const usedKeys = new Set<string>()
    for (const [rawKey, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable !== true) continue
      let key = rawKey.length > 1024 ? replace('unsafe_value') : redactText(rawKey)
      while (usedKeys.has(key)) key = `${key}_`
      usedKeys.add(key)
      const normalized = normalizeKey(rawKey)
      let redacted: JsonValue
      if (options.sensitiveKeys.has(normalized)) {
        redacted = replace('credential_field')
      } else if (isCredentialKey(normalized)) {
        redacted = replace('credential_field')
      } else if (HIDDEN_REASONING_KEYS.has(normalized)) {
        redacted = replace('hidden_reasoning')
      } else if (diagnostic && BUSINESS_CONTENT_KEYS.has(normalized)) {
        redacted = replace('business_content')
      } else {
        redacted = visit(
          descriptor.value,
          depth + 1,
          diagnostic && SAFE_DIAGNOSTIC_TEXT_KEYS.has(normalized),
        )
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: redacted,
        writable: false,
      })
    }
    try {
      if (Object.getOwnPropertySymbols(entry).length > 0) counts.unsafe_value += 1
    } catch {
      counts.unsafe_value += 1
    }
    return Object.freeze(result)
  }

  const redacted = visit(value, 0, false)
  const frozenCounts = Object.freeze(
    Object.fromEntries(REASONS.map((reason) => [reason, counts[reason]])) as Record<
      RedactionReason,
      number
    >,
  )
  const total = Object.values(frozenCounts).reduce((sum, count) => sum + count, 0)
  return deepFreeze({
    value: redacted,
    summary: {
      boundary: options.boundary,
      total,
      counts: frozenCounts,
    },
  })
}
