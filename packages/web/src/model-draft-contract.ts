export type ModelDraftCapability = 'unavailable' | 'ready'

export interface ModelDraftStatusSnapshot {
  readonly version: 1
  readonly capability: ModelDraftCapability
  readonly autonomy: 'draft_only'
}

export interface ModelDraftCreateRequest {
  readonly version: 1
  readonly workItemId: string
}

export interface ModelDraftView {
  readonly workItemId: string
  readonly personaLabel: string
  readonly revision: number
  readonly state: 'editing' | 'ready_for_review' | 'superseded' | 'cancelled'
  readonly content: {
    readonly mediaType: 'text/plain' | 'text/markdown'
    readonly text: string
  }
  readonly updatedAt: string
}

export interface ModelDraftCreateSnapshot {
  readonly version: 1
  readonly disposition: 'created' | 'recovered' | 'repaired'
  readonly autonomy: 'draft_only'
  readonly externalWritesAvailable: false
  readonly draft: ModelDraftView
}

type UnknownRecord = Readonly<Record<string, unknown>>

function invalid(message: string): never {
  throw new Error(message)
}

function recordAt(value: unknown, message: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(message)
  const prototype = Object.getPrototypeOf(value) as unknown
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
  ) {
    return invalid(message)
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function exactKeys(record: UnknownRecord, expected: readonly string[], message: string): void {
  const keys = Object.keys(record)
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    invalid(message)
  }
}

function identifierAt(value: unknown, message: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\u0000') ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    return invalid(message)
  }
  return value
}

function timestampAt(value: unknown, message: string): string {
  if (typeof value !== 'string') return invalid(message)
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return invalid(message)
  const base = value.replace(/(?:\.\d{1,3})?Z$/u, '')
  const canonical = `${base}.${(match[1] ?? '').padEnd(3, '0')}Z`
  if (new Date(value).toISOString() !== canonical) return invalid(message)
  return value
}

/** Parse the minimized model-Draft capability returned by the loopback Host. */
export function parseModelDraftStatusSnapshot(value: unknown): ModelDraftStatusSnapshot {
  const message = 'Local API returned an invalid model Draft status.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'capability', 'autonomy'], message)
  if (
    record.version !== 1 ||
    (record.capability !== 'unavailable' && record.capability !== 'ready') ||
    record.autonomy !== 'draft_only'
  ) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    capability: record.capability,
    autonomy: 'draft_only',
  })
}

/** Parse the only browser-authorized model-Draft intent. */
export function parseModelDraftCreateRequest(value: unknown): ModelDraftCreateRequest {
  const message = 'The model Draft request is invalid.'
  const record = recordAt(value, message)
  exactKeys(record, ['version', 'workItemId'], message)
  if (record.version !== 1) return invalid(message)
  return Object.freeze({ version: 1, workItemId: identifierAt(record.workItemId, message) })
}

/** Parse a minimized local Draft result before it crosses the browser boundary. */
export function parseModelDraftCreateSnapshot(value: unknown): ModelDraftCreateSnapshot {
  const message = 'Local API returned an invalid model Draft result.'
  const record = recordAt(value, message)
  exactKeys(
    record,
    ['version', 'disposition', 'autonomy', 'externalWritesAvailable', 'draft'],
    message,
  )
  const draft = recordAt(record.draft, message)
  exactKeys(
    draft,
    ['workItemId', 'personaLabel', 'revision', 'state', 'content', 'updatedAt'],
    message,
  )
  const content = recordAt(draft.content, message)
  exactKeys(content, ['mediaType', 'text'], message)
  if (
    record.version !== 1 ||
    (record.disposition !== 'created' &&
      record.disposition !== 'recovered' &&
      record.disposition !== 'repaired') ||
    record.autonomy !== 'draft_only' ||
    record.externalWritesAvailable !== false ||
    typeof draft.personaLabel !== 'string' ||
    draft.personaLabel.length === 0 ||
    draft.personaLabel.length > 160 ||
    !Number.isSafeInteger(draft.revision) ||
    (draft.revision as number) < 1 ||
    (draft.state !== 'editing' &&
      draft.state !== 'ready_for_review' &&
      draft.state !== 'superseded' &&
      draft.state !== 'cancelled') ||
    (content.mediaType !== 'text/plain' && content.mediaType !== 'text/markdown') ||
    typeof content.text !== 'string' ||
    content.text.trim().length === 0 ||
    new TextEncoder().encode(content.text).byteLength > 64 * 1_024
  ) {
    return invalid(message)
  }
  return Object.freeze({
    version: 1,
    disposition: record.disposition,
    autonomy: 'draft_only',
    externalWritesAvailable: false,
    draft: Object.freeze({
      workItemId: identifierAt(draft.workItemId, message),
      personaLabel: draft.personaLabel,
      revision: draft.revision as number,
      state: draft.state,
      content: Object.freeze({ mediaType: content.mediaType, text: content.text }),
      updatedAt: timestampAt(draft.updatedAt, message),
    }),
  })
}
