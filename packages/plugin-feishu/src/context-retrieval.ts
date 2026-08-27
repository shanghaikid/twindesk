import {
  parseIsoTimestamp,
  type ConnectorContextBundle,
  type ConnectorContextItem,
  type ConnectorContextRequest,
  type ConnectorIssue,
  type ExternalReference,
  type IsoTimestamp,
  type JsonObject,
} from '@twindesk/domain'

import {
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from './identity-configuration.ts'

export const FEISHU_CONTEXT_RETRIEVAL_VERSION = 1 as const

const MAX_CONTEXT_ITEMS = 50
const DEFAULT_MAX_DOCUMENT_CHARACTERS = 20_000
const DEFAULT_MAX_ATTACHMENT_BYTES = 256 * 1024
const DEFAULT_MAX_ATTACHMENT_TEXT_CHARACTERS = 8_000

type UnknownRecord = Readonly<Record<string, unknown>>

export type FeishuContextErrorCode =
  | 'invalid_request'
  | 'identity_mismatch'
  | 'invalid_response'
  | 'not_authorized'
  | 'scope_missing'
  | 'rate_limited'
  | 'network'
  | 'client_failure'

export class FeishuContextError extends Error {
  readonly code: FeishuContextErrorCode
  readonly retryable: boolean

  constructor(code: FeishuContextErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'FeishuContextError'
    this.code = code
    this.retryable = retryable
  }
}

export type FeishuContextClientErrorCode =
  'not_authorized' | 'scope_missing' | 'rate_limited' | 'network' | 'invalid_response' | 'unknown'

/** Payload-free failure contract for a concrete Feishu context adapter. */
export class FeishuContextClientError extends Error {
  readonly code: FeishuContextClientErrorCode
  readonly retryable: boolean

  constructor(code: FeishuContextClientErrorCode) {
    const supported = [
      'not_authorized',
      'scope_missing',
      'rate_limited',
      'network',
      'invalid_response',
      'unknown',
    ] as const
    const normalized =
      typeof code === 'string' && supported.includes(code as (typeof supported)[number])
        ? (code as FeishuContextClientErrorCode)
        : 'unknown'
    super('The Feishu context adapter failed.')
    this.name = 'FeishuContextClientError'
    this.code = normalized
    this.retryable = ['rate_limited', 'network', 'unknown'].includes(normalized)
  }
}

export interface FeishuContextReadRequest {
  readonly identityType: 'user'
  readonly accountId: string
  readonly appId: string
  readonly tenantKey: string
  readonly userPrincipalId: string
  readonly reference: ExternalReference
  readonly purpose: string
  readonly maxItems: number
  readonly before?: IsoTimestamp
  readonly conversation: Readonly<{
    order: 'desc'
    includeReactions: false
    pageSize: number
  }>
  readonly documents: Readonly<{
    detail: 'simple'
    scope: 'referenced_excerpt'
    maxCharacters: number
  }>
  readonly attachments: Readonly<{
    mode: 'text_excerpt_or_metadata'
    downloadBinary: false
    maxBytes: number
    maxTextCharacters: number
  }>
}

export interface FeishuContextClient {
  read(request: FeishuContextReadRequest, signal: AbortSignal): Promise<unknown>
}

type FeishuContextProblemCode =
  | 'conversation_not_authorized'
  | 'conversation_scope_missing'
  | 'conversation_rate_limited'
  | 'conversation_network'
  | 'document_not_authorized'
  | 'document_scope_missing'
  | 'document_deleted'
  | 'document_rate_limited'
  | 'document_network'
  | 'attachment_not_authorized'
  | 'attachment_scope_missing'
  | 'attachment_deleted'
  | 'attachment_rate_limited'
  | 'attachment_network'

interface FeishuContextProblem {
  readonly code: FeishuContextProblemCode
  readonly affectedCount: number
}

interface ParsedContextResponse {
  readonly status: 'complete' | 'partial' | 'unavailable'
  readonly items: readonly ConnectorContextItem[]
  readonly hasMoreConversation: boolean
  readonly documentTruncations: number
  readonly attachmentBodiesUnavailable: number
  readonly problems: readonly FeishuContextProblem[]
  readonly observedAt: IsoTimestamp
}

function fail(
  code: FeishuContextErrorCode,
  message: string,
  retryable = false,
): FeishuContextError {
  return new FeishuContextError(code, message, retryable)
}

function clientFailure(error: unknown): FeishuContextError {
  if (!(error instanceof FeishuContextClientError)) {
    return fail('client_failure', 'The Feishu context request failed.', true)
  }
  switch (error.code) {
    case 'not_authorized':
      return fail('not_authorized', 'The Feishu User identity is not authorized for context.')
    case 'scope_missing':
      return fail('scope_missing', 'The Feishu User identity is missing a context-read scope.')
    case 'rate_limited':
      return fail('rate_limited', 'The Feishu context request is rate limited.', true)
    case 'network':
      return fail('network', 'The Feishu context network request failed.', true)
    case 'invalid_response':
      return fail('invalid_response', 'The Feishu context response is invalid.')
    case 'unknown':
    default:
      return fail('client_failure', 'The Feishu context request failed.', true)
  }
}

function dataRecord(
  value: unknown,
  code: FeishuContextErrorCode,
  message = 'The Feishu context data is invalid.',
): UnknownRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw fail(code, message)
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) throw fail(code, message)
    if (Object.getOwnPropertySymbols(value).length !== 0) throw fail(code, message)
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
      throw fail(code, message)
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch (error) {
    if (error instanceof FeishuContextError) throw error
    throw fail(code, message)
  }
}

function dataArray(
  value: unknown,
  maximum: number,
  code: FeishuContextErrorCode,
  message: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw fail(code, message)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >
    const lengthDescriptor = descriptors.length
    const length = lengthDescriptor?.value
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > maximum ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    ) {
      throw fail(code, message)
    }
    const result: unknown[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw fail(code, message)
      }
      result.push(descriptor.value)
    }
    if (Object.keys(descriptors).length !== result.length + 1) throw fail(code, message)
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof FeishuContextError) throw error
    throw fail(code, message)
  }
}

function exactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  code: FeishuContextErrorCode,
): void {
  const keys = Object.keys(record)
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw fail(code, 'The Feishu context data has unsupported or missing fields.')
  }
}

function boundedString(
  value: unknown,
  code: FeishuContextErrorCode,
  message: string,
  maximum = 512,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail(code, message)
  }
  return value
}

function optionalString(
  value: unknown,
  code: FeishuContextErrorCode,
  message: string,
  maximum = 512,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, code, message, maximum)
}

function boundedText(
  value: unknown,
  maximum: number,
  code: FeishuContextErrorCode,
  message: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw fail(code, message)
  }
  return value
}

function instant(value: unknown, code: FeishuContextErrorCode): IsoTimestamp {
  try {
    return parseIsoTimestamp(value)
  } catch {
    throw fail(code, 'A Feishu context timestamp is invalid.')
  }
}

function positiveInteger(
  value: unknown,
  maximum: number,
  code: FeishuContextErrorCode,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw fail(code, message)
  }
  return value as number
}

function nonNegativeInteger(
  value: unknown,
  maximum: number,
  code: FeishuContextErrorCode,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw fail(code, message)
  }
  return value as number
}

const supportedObjectTypes = ['message', 'thread', 'document', 'attachment'] as const

function externalReference(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  code: FeishuContextErrorCode,
): ExternalReference {
  const record = dataRecord(value, code)
  exactKeys(
    record,
    ['connectorId', 'accountId', 'objectType', 'externalId'],
    ['sourceTimestamp'],
    code,
  )
  if (
    record.connectorId !== 'feishu' ||
    record.accountId !== configuration.accountId ||
    !supportedObjectTypes.includes(record.objectType as (typeof supportedObjectTypes)[number])
  ) {
    throw fail('identity_mismatch', 'The Feishu context reference identity does not match.')
  }
  return Object.freeze({
    connectorId: 'feishu',
    accountId: configuration.accountId,
    objectType: record.objectType as (typeof supportedObjectTypes)[number],
    externalId: boundedString(
      record.externalId,
      code,
      'The Feishu context external identity is invalid.',
    ),
    ...(record.sourceTimestamp === undefined
      ? {}
      : { sourceTimestamp: instant(record.sourceTimestamp, code) }),
  })
}

function sameReference(left: ExternalReference, right: ExternalReference): boolean {
  return (
    left.connectorId === right.connectorId &&
    left.accountId === right.accountId &&
    left.objectType === right.objectType &&
    left.externalId === right.externalId &&
    left.sourceTimestamp === right.sourceTimestamp
  )
}

function parseRequest(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
): ConnectorContextRequest {
  const record = dataRecord(value, 'invalid_request')
  exactKeys(record, ['reference', 'purpose', 'maxItems'], ['before'], 'invalid_request')
  return Object.freeze({
    reference: externalReference(record.reference, configuration, 'invalid_request'),
    purpose: boundedString(
      record.purpose,
      'invalid_request',
      'The Feishu context purpose is invalid.',
      512,
    ),
    maxItems: positiveInteger(
      record.maxItems,
      MAX_CONTEXT_ITEMS,
      'invalid_request',
      'The Feishu context item limit is invalid.',
    ),
    ...(record.before === undefined ? {} : { before: instant(record.before, 'invalid_request') }),
  })
}

function parseConversationContent(value: unknown): JsonObject {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(
    record,
    ['kind', 'messageType', 'text', 'deleted', 'edited', 'relation'],
    ['threadId'],
    'invalid_response',
  )
  if (
    record.kind !== 'feishu_conversation_message_context' ||
    typeof record.deleted !== 'boolean' ||
    typeof record.edited !== 'boolean' ||
    !['anchor', 'preceding', 'reply'].includes(record.relation as string)
  ) {
    throw fail('invalid_response', 'A Feishu conversation context item is invalid.')
  }
  if (record.relation === 'reply' && record.threadId === undefined) {
    throw fail('invalid_response', 'A Feishu reply context item requires a thread identity.')
  }
  return Object.freeze({
    kind: 'feishu_conversation_message_context',
    messageType: boundedString(
      record.messageType,
      'invalid_response',
      'A Feishu context message type is invalid.',
      128,
    ),
    text: boundedText(
      record.text,
      32_000,
      'invalid_response',
      'A Feishu context message text is invalid.',
    ),
    deleted: record.deleted,
    edited: record.edited,
    relation: record.relation as 'anchor' | 'preceding' | 'reply',
    ...(record.threadId === undefined
      ? {}
      : {
          threadId: boundedString(
            record.threadId,
            'invalid_response',
            'A Feishu context thread identity is invalid.',
          ),
        }),
  })
}

function parseDocumentContent(
  value: unknown,
  maximumCharacters: number,
): Readonly<{ content: JsonObject; truncated: boolean }> {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(
    record,
    ['kind', 'format', 'scope', 'revisionId', 'text', 'truncated'],
    [],
    'invalid_response',
  )
  if (
    record.kind !== 'feishu_document_excerpt_context' ||
    record.format !== 'plain_text' ||
    record.scope !== 'referenced_excerpt' ||
    typeof record.truncated !== 'boolean'
  ) {
    throw fail('invalid_response', 'A Feishu document context item is invalid.')
  }
  return Object.freeze({
    content: Object.freeze({
      kind: 'feishu_document_excerpt_context',
      format: 'plain_text',
      scope: 'referenced_excerpt',
      revisionId: boundedString(
        record.revisionId,
        'invalid_response',
        'A Feishu document revision identity is invalid.',
        128,
      ),
      text: boundedText(
        record.text,
        maximumCharacters,
        'invalid_response',
        'A Feishu document excerpt is invalid.',
      ),
      truncated: record.truncated,
    }),
    truncated: record.truncated,
  })
}

function parseAttachmentContent(
  value: unknown,
  maximumTextCharacters: number,
  maximumBytes: number,
): Readonly<{ content: JsonObject; bodyUnavailable: boolean }> {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(record, ['kind', 'name', 'mediaType', 'sizeBytes', 'body'], [], 'invalid_response')
  if (record.kind !== 'feishu_attachment_context') {
    throw fail('invalid_response', 'A Feishu attachment context item is invalid.')
  }
  const body = dataRecord(record.body, 'invalid_response')
  const status = body.status
  const mediaType = boundedString(
    record.mediaType,
    'invalid_response',
    'A Feishu attachment media type is invalid.',
    128,
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mediaType)) {
    throw fail('invalid_response', 'A Feishu attachment media type is invalid.')
  }
  const sizeBytes = nonNegativeInteger(
    record.sizeBytes,
    Number.MAX_SAFE_INTEGER,
    'invalid_response',
    'A Feishu attachment size is invalid.',
  )
  let parsedBody: JsonObject
  if (status === 'excerpt') {
    exactKeys(body, ['status', 'text', 'bytesRead', 'truncated'], [], 'invalid_response')
    if (typeof body.truncated !== 'boolean') {
      throw fail('invalid_response', 'A Feishu attachment excerpt is invalid.')
    }
    const normalizedMediaType = mediaType.toLowerCase()
    if (!(
      normalizedMediaType.startsWith('text/') ||
      ['application/json', 'application/xml', 'application/yaml'].includes(normalizedMediaType)
    )) {
      throw fail('invalid_response', 'A binary Feishu attachment cannot contain a text excerpt.')
    }
    const bytesRead = nonNegativeInteger(
      body.bytesRead,
      maximumBytes,
      'invalid_response',
      'A Feishu attachment byte count is invalid.',
    )
    if (bytesRead > sizeBytes || (body.truncated === false && bytesRead !== sizeBytes)) {
      throw fail('invalid_response', 'A Feishu attachment excerpt size is inconsistent.')
    }
    parsedBody = Object.freeze({
      status: 'excerpt',
      text: boundedText(
        body.text,
        maximumTextCharacters,
        'invalid_response',
        'A Feishu attachment text excerpt is invalid.',
      ),
      bytesRead,
      truncated: body.truncated,
    })
  } else if (status === 'metadata_only') {
    exactKeys(body, ['status', 'reason'], [], 'invalid_response')
    if (
      !['binary', 'too_large', 'unsupported', 'deleted', 'not_authorized'].includes(
        body.reason as string,
      )
    ) {
      throw fail('invalid_response', 'A Feishu attachment metadata state is invalid.')
    }
    parsedBody = Object.freeze({
      status: 'metadata_only',
      reason: body.reason as 'binary' | 'too_large' | 'unsupported' | 'deleted' | 'not_authorized',
    })
  } else {
    throw fail('invalid_response', 'A Feishu attachment body state is invalid.')
  }
  return Object.freeze({
    content: Object.freeze({
      kind: 'feishu_attachment_context',
      name: boundedString(record.name, 'invalid_response', 'A Feishu attachment name is invalid.'),
      mediaType,
      sizeBytes,
      body: parsedBody,
    }),
    bodyUnavailable: status === 'metadata_only' || body.truncated === true,
  })
}

function anchorsRequest(item: ConnectorContextItem, reference: ExternalReference): boolean {
  if (reference.objectType === 'thread') {
    return (
      item.source.objectType === 'message' &&
      item.content.kind === 'feishu_conversation_message_context' &&
      item.content.threadId === reference.externalId
    )
  }
  return (
    sameReference(item.source, reference) &&
    (reference.objectType !== 'message' ||
      (item.content.kind === 'feishu_conversation_message_context' &&
        item.content.relation === 'anchor'))
  )
}

function parseItem(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  maximumDocumentCharacters: number,
  maximumAttachmentTextCharacters: number,
  maximumAttachmentBytes: number,
): Readonly<{
  item: ConnectorContextItem
  documentTruncated: boolean
  attachmentBodyUnavailable: boolean
}> {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(record, ['source', 'content', 'observedAt'], ['title'], 'invalid_response')
  const source = externalReference(record.source, configuration, 'invalid_response')
  const observedAt = instant(record.observedAt, 'invalid_response')
  if (
    source.sourceTimestamp !== undefined &&
    Date.parse(source.sourceTimestamp) > Date.parse(observedAt)
  ) {
    throw fail('invalid_response', 'A Feishu context item chronology is invalid.')
  }
  const contentRecord = dataRecord(record.content, 'invalid_response')
  let content: JsonObject
  let documentTruncated = false
  let attachmentBodyUnavailable = false
  if (source.objectType === 'message') {
    content = parseConversationContent(contentRecord)
  } else if (source.objectType === 'document') {
    const parsed = parseDocumentContent(contentRecord, maximumDocumentCharacters)
    content = parsed.content
    documentTruncated = parsed.truncated
  } else if (source.objectType === 'attachment') {
    const parsed = parseAttachmentContent(
      contentRecord,
      maximumAttachmentTextCharacters,
      maximumAttachmentBytes,
    )
    content = parsed.content
    attachmentBodyUnavailable = parsed.bodyUnavailable
  } else {
    throw fail('invalid_response', 'A Feishu context item type is invalid.')
  }
  const title = optionalString(
    record.title,
    'invalid_response',
    'A Feishu context item title is invalid.',
  )
  return Object.freeze({
    item: Object.freeze({
      source,
      ...(title === undefined ? {} : { title }),
      content,
      observedAt,
    }),
    documentTruncated,
    attachmentBodyUnavailable,
  })
}

const problemCodes = [
  'conversation_not_authorized',
  'conversation_scope_missing',
  'conversation_rate_limited',
  'conversation_network',
  'document_not_authorized',
  'document_scope_missing',
  'document_deleted',
  'document_rate_limited',
  'document_network',
  'attachment_not_authorized',
  'attachment_scope_missing',
  'attachment_deleted',
  'attachment_rate_limited',
  'attachment_network',
] as const

function parseProblems(value: unknown, maximum: number): readonly FeishuContextProblem[] {
  const problems = dataArray(
    value,
    maximum,
    'invalid_response',
    'The Feishu context problem list is invalid.',
  ).map((entry) => {
    const record = dataRecord(entry, 'invalid_response')
    exactKeys(record, ['code', 'affectedCount'], [], 'invalid_response')
    if (!problemCodes.includes(record.code as FeishuContextProblemCode)) {
      throw fail('invalid_response', 'A Feishu context problem code is invalid.')
    }
    return Object.freeze({
      code: record.code as FeishuContextProblemCode,
      affectedCount: positiveInteger(
        record.affectedCount,
        maximum,
        'invalid_response',
        'A Feishu context problem count is invalid.',
      ),
    })
  })
  if (new Set(problems.map((problem) => problem.code)).size !== problems.length) {
    throw fail('invalid_response', 'The Feishu context problem list has duplicates.')
  }
  return Object.freeze(problems)
}

function parseResponse(
  value: unknown,
  configuration: FeishuIdentityConfiguration,
  tenantKey: string,
  request: ConnectorContextRequest,
  maximumDocumentCharacters: number,
  maximumAttachmentTextCharacters: number,
  maximumAttachmentBytes: number,
): ParsedContextResponse {
  const record = dataRecord(value, 'invalid_response')
  exactKeys(
    record,
    [
      'kind',
      'schemaVersion',
      'identityType',
      'accountId',
      'appId',
      'tenantKey',
      'userPrincipalId',
      'reference',
      'status',
      'items',
      'hasMoreConversation',
      'problems',
      'observedAt',
    ],
    [],
    'invalid_response',
  )
  const user = configuration.user
  if (
    user === undefined ||
    record.kind !== 'feishu_context_read_result' ||
    record.schemaVersion !== FEISHU_CONTEXT_RETRIEVAL_VERSION ||
    record.identityType !== 'user' ||
    record.accountId !== configuration.accountId ||
    record.appId !== configuration.appId ||
    record.tenantKey !== tenantKey ||
    record.userPrincipalId !== user.principalId
  ) {
    throw fail('identity_mismatch', 'The Feishu context response identity does not match the User.')
  }
  const responseReference = externalReference(record.reference, configuration, 'invalid_response')
  if (!sameReference(responseReference, request.reference)) {
    throw fail('identity_mismatch', 'The Feishu context response reference does not match.')
  }
  if (!['complete', 'partial', 'unavailable'].includes(record.status as string)) {
    throw fail('invalid_response', 'The Feishu context availability state is invalid.')
  }
  if (typeof record.hasMoreConversation !== 'boolean') {
    throw fail('invalid_response', 'The Feishu conversation pagination state is invalid.')
  }
  const observedAt = instant(record.observedAt, 'invalid_response')
  const parsedItems = dataArray(
    record.items,
    request.maxItems,
    'invalid_response',
    'The Feishu context item list is invalid.',
  ).map((entry) =>
    parseItem(
      entry,
      configuration,
      maximumDocumentCharacters,
      maximumAttachmentTextCharacters,
      maximumAttachmentBytes,
    ),
  )
  const items = Object.freeze(parsedItems.map((parsed) => parsed.item))
  if (
    new Set(
      items.map(
        (item) =>
          `${item.source.objectType}\u0000${item.source.externalId}\u0000${item.source.sourceTimestamp ?? ''}`,
      ),
    ).size !== items.length ||
    items.some((item) => Date.parse(item.observedAt) > Date.parse(observedAt))
  ) {
    throw fail('invalid_response', 'The Feishu context item set is inconsistent.')
  }
  if (
    items.some(
      (item) =>
        item.source.objectType === 'message' &&
        (item.source.sourceTimestamp === undefined ||
          (request.before !== undefined &&
            Date.parse(item.source.sourceTimestamp) > Date.parse(request.before))),
    )
  ) {
    throw fail('invalid_response', 'The Feishu conversation context exceeds its time bound.')
  }
  const problems = parseProblems(record.problems, request.maxItems)
  const affectedCount = problems.reduce((sum, problem) => sum + problem.affectedCount, 0)
  if (items.length + affectedCount > request.maxItems) {
    throw fail('invalid_response', 'The Feishu context response exceeds its requested item bound.')
  }
  const documentTruncations = parsedItems.filter((item) => item.documentTruncated).length
  const attachmentBodiesUnavailable = parsedItems.filter(
    (item) => item.attachmentBodyUnavailable,
  ).length
  const incomplete =
    record.hasMoreConversation ||
    problems.length > 0 ||
    documentTruncations > 0 ||
    attachmentBodiesUnavailable > 0
  if (
    (record.status === 'complete' && (incomplete || items.length === 0)) ||
    (record.status === 'partial' && (!incomplete || items.length === 0)) ||
    (record.status === 'unavailable' &&
      (items.length !== 0 || problems.length === 0 || record.hasMoreConversation))
  ) {
    throw fail('invalid_response', 'The Feishu context availability state is inconsistent.')
  }
  if (
    record.status !== 'unavailable' &&
    !items.some((item) => anchorsRequest(item, request.reference))
  ) {
    throw fail('identity_mismatch', 'The Feishu context items do not contain the requested anchor.')
  }
  return Object.freeze({
    status: record.status as 'complete' | 'partial' | 'unavailable',
    items,
    hasMoreConversation: record.hasMoreConversation,
    documentTruncations,
    attachmentBodiesUnavailable,
    problems,
    observedAt,
  })
}

const problemMetadata: Readonly<
  Record<
    FeishuContextProblemCode,
    Readonly<{ message: string; missing: string; retryable: boolean }>
  >
> = Object.freeze({
  conversation_not_authorized: Object.freeze({
    message: 'Some Feishu conversation context is not authorized.',
    missing: 'conversation context not authorized',
    retryable: false,
  }),
  conversation_scope_missing: Object.freeze({
    message: 'Some Feishu conversation context requires an additional scope.',
    missing: 'conversation context scope missing',
    retryable: false,
  }),
  conversation_rate_limited: Object.freeze({
    message: 'Some Feishu conversation context is rate limited.',
    missing: 'conversation context rate limited',
    retryable: true,
  }),
  conversation_network: Object.freeze({
    message: 'Some Feishu conversation context failed over the network.',
    missing: 'conversation context network failure',
    retryable: true,
  }),
  document_not_authorized: Object.freeze({
    message: 'Some Feishu document context is not authorized.',
    missing: 'document context not authorized',
    retryable: false,
  }),
  document_scope_missing: Object.freeze({
    message: 'Some Feishu document context requires an additional scope.',
    missing: 'document context scope missing',
    retryable: false,
  }),
  document_deleted: Object.freeze({
    message: 'Some referenced Feishu document context was deleted.',
    missing: 'document context deleted',
    retryable: false,
  }),
  document_rate_limited: Object.freeze({
    message: 'Some Feishu document context is rate limited.',
    missing: 'document context rate limited',
    retryable: true,
  }),
  document_network: Object.freeze({
    message: 'Some Feishu document context failed over the network.',
    missing: 'document context network failure',
    retryable: true,
  }),
  attachment_not_authorized: Object.freeze({
    message: 'Some Feishu attachment context is not authorized.',
    missing: 'attachment context not authorized',
    retryable: false,
  }),
  attachment_scope_missing: Object.freeze({
    message: 'Some Feishu attachment context requires an additional scope.',
    missing: 'attachment context scope missing',
    retryable: false,
  }),
  attachment_deleted: Object.freeze({
    message: 'Some referenced Feishu attachment context was deleted.',
    missing: 'attachment context deleted',
    retryable: false,
  }),
  attachment_rate_limited: Object.freeze({
    message: 'Some Feishu attachment context is rate limited.',
    missing: 'attachment context rate limited',
    retryable: true,
  }),
  attachment_network: Object.freeze({
    message: 'Some Feishu attachment context failed over the network.',
    missing: 'attachment context network failure',
    retryable: true,
  }),
})

function issueForProblem(problem: FeishuContextProblem): ConnectorIssue {
  const metadata = problemMetadata[problem.code]
  return Object.freeze({
    code: problem.code,
    message: metadata.message,
    retryable: metadata.retryable,
  })
}

function missingContext(response: ParsedContextResponse): readonly string[] {
  return Object.freeze([
    ...(response.hasMoreConversation ? ['conversation history beyond the requested bound'] : []),
    ...(response.documentTruncations > 0 ? ['document content beyond the excerpt bound'] : []),
    ...(response.attachmentBodiesUnavailable > 0 ? ['attachment body unavailable'] : []),
    ...response.problems.map((problem) => problemMetadata[problem.code].missing),
  ])
}

function bundle(response: ParsedContextResponse): ConnectorContextBundle {
  const issues = Object.freeze(response.problems.map(issueForProblem))
  if (response.status === 'complete') {
    return Object.freeze({
      availability: Object.freeze({ status: 'complete' as const }),
      items: response.items,
      issues,
      observedAt: response.observedAt,
    })
  }
  if (response.status === 'partial') {
    return Object.freeze({
      availability: Object.freeze({
        status: 'partial' as const,
        missing: missingContext(response),
      }),
      items: response.items,
      issues,
      observedAt: response.observedAt,
    })
  }
  return Object.freeze({
    availability: Object.freeze({
      status: 'unavailable' as const,
      reason: 'Feishu context is unavailable for the authorized User identity.',
      retryable: response.problems.some((problem) => problemMetadata[problem.code].retryable),
    }),
    items: response.items,
    issues,
    observedAt: response.observedAt,
  })
}

export class FeishuContextRetriever {
  readonly #configuration: FeishuIdentityConfiguration
  readonly #client: FeishuContextClient
  readonly #tenantKey: string
  readonly #maximumDocumentCharacters: number
  readonly #maximumAttachmentBytes: number
  readonly #maximumAttachmentTextCharacters: number

  constructor(
    configuration: unknown,
    client: FeishuContextClient,
    options: Readonly<{
      tenantKey: string
      maximumDocumentCharacters?: number
      maximumAttachmentBytes?: number
      maximumAttachmentTextCharacters?: number
    }>,
  ) {
    this.#configuration = parseFeishuIdentityConfiguration(configuration)
    if (this.#configuration.user === undefined) {
      throw fail('identity_mismatch', 'A Feishu User identity is required for context retrieval.')
    }
    const clientRecord = dataRecord(client, 'invalid_request')
    exactKeys(clientRecord, ['read'], [], 'invalid_request')
    if (typeof clientRecord.read !== 'function') {
      throw fail('invalid_request', 'The Feishu context client is invalid.')
    }
    const optionRecord = dataRecord(options, 'invalid_request')
    exactKeys(
      optionRecord,
      ['tenantKey'],
      ['maximumDocumentCharacters', 'maximumAttachmentBytes', 'maximumAttachmentTextCharacters'],
      'invalid_request',
    )
    this.#tenantKey = boundedString(
      optionRecord.tenantKey,
      'invalid_request',
      'The Feishu context tenant identity is invalid.',
    )
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(this.#tenantKey)) {
      throw fail('invalid_request', 'The Feishu context tenant identity is invalid.')
    }
    this.#maximumDocumentCharacters =
      optionRecord.maximumDocumentCharacters === undefined
        ? DEFAULT_MAX_DOCUMENT_CHARACTERS
        : positiveInteger(
            optionRecord.maximumDocumentCharacters,
            100_000,
            'invalid_request',
            'The Feishu document context bound is invalid.',
          )
    this.#maximumAttachmentBytes =
      optionRecord.maximumAttachmentBytes === undefined
        ? DEFAULT_MAX_ATTACHMENT_BYTES
        : positiveInteger(
            optionRecord.maximumAttachmentBytes,
            10 * 1024 * 1024,
            'invalid_request',
            'The Feishu attachment byte bound is invalid.',
          )
    this.#maximumAttachmentTextCharacters =
      optionRecord.maximumAttachmentTextCharacters === undefined
        ? DEFAULT_MAX_ATTACHMENT_TEXT_CHARACTERS
        : positiveInteger(
            optionRecord.maximumAttachmentTextCharacters,
            100_000,
            'invalid_request',
            'The Feishu attachment text bound is invalid.',
          )
    if (this.#maximumAttachmentTextCharacters > this.#maximumAttachmentBytes) {
      throw fail('invalid_request', 'The Feishu attachment context bounds are inconsistent.')
    }
    this.#client = Object.freeze({
      read: clientRecord.read as FeishuContextClient['read'],
    })
  }

  async getContext(value: unknown, signal: AbortSignal): Promise<ConnectorContextBundle> {
    signal.throwIfAborted()
    const request = parseRequest(value, this.#configuration)
    const user = this.#configuration.user
    if (user === undefined) {
      throw fail('identity_mismatch', 'A Feishu User identity is required for context retrieval.')
    }
    const clientRequest: FeishuContextReadRequest = Object.freeze({
      identityType: 'user',
      accountId: this.#configuration.accountId,
      appId: this.#configuration.appId,
      tenantKey: this.#tenantKey,
      userPrincipalId: user.principalId,
      reference: request.reference,
      purpose: request.purpose,
      maxItems: request.maxItems,
      ...(request.before === undefined ? {} : { before: request.before }),
      conversation: Object.freeze({
        order: 'desc',
        includeReactions: false,
        pageSize: request.maxItems,
      }),
      documents: Object.freeze({
        detail: 'simple',
        scope: 'referenced_excerpt',
        maxCharacters: this.#maximumDocumentCharacters,
      }),
      attachments: Object.freeze({
        mode: 'text_excerpt_or_metadata',
        downloadBinary: false,
        maxBytes: this.#maximumAttachmentBytes,
        maxTextCharacters: this.#maximumAttachmentTextCharacters,
      }),
    })
    let rawResponse: unknown
    try {
      rawResponse = await this.#client.read(clientRequest, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw clientFailure(error)
    }
    signal.throwIfAborted()
    let response: ParsedContextResponse
    try {
      response = parseResponse(
        rawResponse,
        this.#configuration,
        this.#tenantKey,
        request,
        this.#maximumDocumentCharacters,
        this.#maximumAttachmentTextCharacters,
        this.#maximumAttachmentBytes,
      )
    } catch (error) {
      if (error instanceof FeishuContextError) throw error
      throw fail('invalid_response', 'The Feishu context response is invalid.')
    }
    return bundle(response)
  }
}
