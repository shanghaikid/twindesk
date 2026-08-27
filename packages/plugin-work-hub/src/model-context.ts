import { redactForBoundary } from '@twindesk/domain'

/** Serialize an authorized Tool value only after the shared model-context redaction policy. */
export function renderRedactedModelContext(
  value: unknown,
  knownSecrets: readonly string[] = [],
): string {
  return JSON.stringify(redactForBoundary(value, { boundary: 'model_context', knownSecrets }).value)
}
