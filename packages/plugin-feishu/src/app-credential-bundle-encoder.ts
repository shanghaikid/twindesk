import {
  FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES,
  FEISHU_CREDENTIAL_BUNDLE_VERSION,
} from './credential-bundle.ts'
import { parseFeishuIdentityConfiguration } from './identity-configuration.ts'

const fillBytes = Uint8Array.prototype.fill

function zeroBytes(value: Uint8Array): void {
  fillBytes.call(value, 0)
}

export type FeishuAppCredentialBundleEncoderErrorCode =
  | 'invalid_configuration'
  | 'invalid_secret'
  | 'invalid_consumer'
  | 'invalid_signal'
  | 'bundle_too_large'

export class FeishuAppCredentialBundleEncoderError extends Error {
  readonly code: FeishuAppCredentialBundleEncoderErrorCode

  constructor(code: FeishuAppCredentialBundleEncoderErrorCode, message: string) {
    super(message)
    this.name = 'FeishuAppCredentialBundleEncoderError'
    this.code = code
  }
}

function fail(
  code: FeishuAppCredentialBundleEncoderErrorCode,
  message: string,
): FeishuAppCredentialBundleEncoderError {
  return new FeishuAppCredentialBundleEncoderError(code, message)
}

function secretText(value: Uint8Array): string {
  if (!(value.buffer instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > 512) {
    throw fail('invalid_secret', 'The Feishu application secret is invalid.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw fail('invalid_secret', 'The Feishu application secret is invalid.')
  }
  if (
    text.length === 0 ||
    text.length > 512 ||
    text.trim() !== text ||
    /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw fail('invalid_secret', 'The Feishu application secret is invalid.')
  }
  return text
}

/** Encode and consume one exact Bot application-credential bundle. */
export class FeishuAppCredentialBundleEncoder {
  async withEncodedBundle<TResult>(
    configurationValue: unknown,
    appSecret: Uint8Array,
    signal: AbortSignal,
    use: (bundle: Uint8Array) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    if (!(appSecret instanceof Uint8Array)) {
      throw fail('invalid_secret', 'The Feishu application secret is invalid.')
    }
    let bundle: Uint8Array | undefined
    try {
      if (!(signal instanceof AbortSignal)) {
        throw fail('invalid_signal', 'The Feishu application credential signal is invalid.')
      }
      signal.throwIfAborted()
      if (typeof use !== 'function') {
        throw fail('invalid_consumer', 'The Feishu application credential consumer is invalid.')
      }
      let configuration
      try {
        configuration = parseFeishuIdentityConfiguration(configurationValue)
      } catch {
        throw fail('invalid_configuration', 'The Feishu Bot identity configuration is invalid.')
      }
      if (configuration.bot === undefined) {
        throw fail('invalid_configuration', 'The Feishu Bot identity is not configured.')
      }
      bundle = new TextEncoder().encode(
        JSON.stringify({
          kind: 'feishu_app_credential_bundle',
          schemaVersion: FEISHU_CREDENTIAL_BUNDLE_VERSION,
          appId: configuration.appId,
          appSecret: secretText(appSecret),
        }),
      )
      if (bundle.byteLength === 0 || bundle.byteLength > FEISHU_CREDENTIAL_BUNDLE_MAX_BYTES) {
        throw fail('bundle_too_large', 'The Feishu application credential bundle is too large.')
      }
      signal.throwIfAborted()
      return await use(bundle)
    } finally {
      if (bundle !== undefined) zeroBytes(bundle)
      zeroBytes(appSecret)
    }
  }
}
