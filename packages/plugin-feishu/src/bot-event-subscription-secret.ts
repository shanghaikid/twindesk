import { TextDecoder } from 'node:util'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_VERSION = 1 as const
export const FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_MAX_BYTES = 16 * 1024

export type FeishuBotEventSubscriptionSecretErrorCode =
  'invalid_bundle' | 'identity_mismatch' | 'invalid_consumer'

export class FeishuBotEventSubscriptionSecretError extends Error {
  readonly code: FeishuBotEventSubscriptionSecretErrorCode

  constructor(code: FeishuBotEventSubscriptionSecretErrorCode, message: string) {
    super(message)
    this.name = 'FeishuBotEventSubscriptionSecretError'
    this.code = code
  }
}

export interface FeishuBotEventSubscriptionSecrets {
  readonly kind: 'feishu_bot_event_subscription_secrets'
  readonly schemaVersion: typeof FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_VERSION
  readonly appId: string
  readonly verificationToken: string
  readonly encryptionKey: string
}

type UnknownRecord = Readonly<Record<string, unknown>>

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function fail(
  code: FeishuBotEventSubscriptionSecretErrorCode,
  message: string,
): FeishuBotEventSubscriptionSecretError {
  return new FeishuBotEventSubscriptionSecretError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
}

function duplicateTopLevelKey(text: string): boolean {
  const keys = new Set<string>()
  let depth = 0
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const current = text[index]
        if (!escaped && current === '"') break
        if (!escaped && current === '\\') escaped = true
        else escaped = false
        index += 1
      }
      if (index >= text.length) return false
      let next = index + 1
      while (/\s/u.test(text[next] ?? '')) next += 1
      if (depth === 1 && text[next] === ':') {
        let key: unknown
        try {
          key = JSON.parse(text.slice(start, index + 1)) as unknown
        } catch {
          return false
        }
        if (typeof key !== 'string' || keys.has(key)) return true
        keys.add(key)
      }
    } else if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    index += 1
  }
  return false
}

function secretString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  return value
}

function parseBundle(
  configuration: FeishuIdentityConfiguration,
  bytes: Uint8Array,
): FeishuBotEventSubscriptionSecrets {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_MAX_BYTES
  ) {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  let end = bytes.byteLength
  if (bytes[end - 1] === 0x0a) {
    end -= 1
    if (bytes[end - 1] === 0x0d) end -= 1
  }
  let text: string
  try {
    text = UTF8_DECODER.decode(bytes.subarray(0, end))
  } catch {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  if (text.length === 0 || duplicateTopLevelKey(text)) {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  let record: UnknownRecord
  try {
    record = dataRecord(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof FeishuBotEventSubscriptionSecretError) throw error
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  const keys = ['kind', 'schemaVersion', 'appId', 'verificationToken', 'encryptionKey']
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    record.kind !== 'feishu_bot_event_subscription_secret_bundle' ||
    record.schemaVersion !== FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_VERSION
  ) {
    throw fail('invalid_bundle', 'The Feishu Bot event subscription secret bundle is invalid.')
  }
  const appId = secretString(record.appId, 128)
  if (configuration.bot === undefined || appId !== configuration.appId) {
    throw fail('identity_mismatch', 'The Feishu Bot event subscription identity does not match.')
  }
  return Object.freeze({
    kind: 'feishu_bot_event_subscription_secrets',
    schemaVersion: FEISHU_BOT_EVENT_SUBSCRIPTION_SECRET_VERSION,
    appId,
    verificationToken: secretString(record.verificationToken, 4_096),
    encryptionKey: secretString(record.encryptionKey, 4_096),
  })
}

/** Keep the decoded event-subscription secrets inside one caller-owned callback. */
export async function withFeishuBotEventSubscriptionSecrets<TResult>(
  configurationValue: unknown,
  bytes: Uint8Array,
  use: (secrets: FeishuBotEventSubscriptionSecrets) => Promise<TResult> | TResult,
): Promise<TResult> {
  const configuration = parseFeishuIdentityConfiguration(configurationValue)
  if (typeof use !== 'function') {
    throw fail('invalid_consumer', 'The Feishu Bot event subscription secret consumer is invalid.')
  }
  return use(parseBundle(configuration, bytes))
}
