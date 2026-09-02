import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  parseAuditRecord,
  type ActionProposal,
  type ActionProposalId,
  type Draft,
  type ExternalReference,
  type WorkItemId,
} from '@twindesk/domain'
import {
  FEISHU_REPLY_ACTION_TYPE,
  FeishuIdentityConfigurationStore,
  FeishuReplyProposer,
  toFeishuActionIdentity,
  type FeishuIdentityConfiguration,
} from '@twindesk/plugin-feishu'
import type { TwinDeskDatabase } from '@twindesk/storage-sqlite'

export type WorkbenchFeishuReplyProposalErrorCode =
  | 'invalid_options'
  | 'invalid_request'
  | 'connector_unavailable'
  | 'target_unavailable'
  | 'runtime_unavailable'

export class WorkbenchFeishuReplyProposalError extends Error {
  readonly code: WorkbenchFeishuReplyProposalErrorCode

  constructor(code: WorkbenchFeishuReplyProposalErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchFeishuReplyProposalError'
    this.code = code
  }
}

export interface WorkbenchFeishuReplyProposalRequest {
  readonly version: 1
  readonly workItemId: string
  readonly draftRevision: number
}

export interface WorkbenchFeishuReplyProposalControllerOptions {
  readonly database: TwinDeskDatabase
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly now?: () => number
}

export interface WorkbenchFeishuReplyProposalController {
  read(): Promise<unknown>
  create(request: WorkbenchFeishuReplyProposalRequest, signal: AbortSignal): Promise<unknown>
}

type ParsedOptions = Readonly<Required<WorkbenchFeishuReplyProposalControllerOptions>>
const REQUIRED_DATABASE_METHODS = Object.freeze([
  'appendAuditRecords',
  'createActionProposal',
  'getActionProposal',
  'getDraftByWorkItemRevision',
  'getThread',
  'getWorkItem',
])

function hasDataMethod(value: object, name: string): boolean {
  try {
    let owner: object | null = value
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      }
      owner = Object.getPrototypeOf(owner) as object | null
    }
    return false
  } catch {
    return false
  }
}

function fail(
  code: WorkbenchFeishuReplyProposalErrorCode,
  message: string,
): WorkbenchFeishuReplyProposalError {
  return new WorkbenchFeishuReplyProposalError(code, message)
}

function optionsAt(value: unknown): ParsedOptions {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const required = ['database', 'identityStore']
    const allowed = [...required, 'now']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
    ) {
      throw new TypeError()
    }
    const database = descriptors.database?.value
    if (
      typeof database !== 'object' ||
      database === null ||
      REQUIRED_DATABASE_METHODS.some((method) => !hasDataMethod(database, method)) ||
      !(descriptors.identityStore?.value instanceof FeishuIdentityConfigurationStore) ||
      (descriptors.now?.value !== undefined && typeof descriptors.now.value !== 'function')
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      database: database as TwinDeskDatabase,
      identityStore: descriptors.identityStore.value,
      now: (descriptors.now?.value as (() => number) | undefined) ?? Date.now,
    })
  } catch {
    throw fail('invalid_options', 'The Workbench Feishu reply proposal options are invalid.')
  }
}

function requestAt(value: unknown): WorkbenchFeishuReplyProposalRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError()
    const prototype = Object.getPrototypeOf(value) as unknown
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['version', 'workItemId', 'draftRevision']
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')) ||
      descriptors.version?.value !== 1 ||
      typeof descriptors.workItemId?.value !== 'string' ||
      descriptors.workItemId.value.length === 0 ||
      descriptors.workItemId.value.length > 200 ||
      descriptors.workItemId.value.includes('\u0000') ||
      Buffer.byteLength(descriptors.workItemId.value, 'utf8') > 512 ||
      !Number.isSafeInteger(descriptors.draftRevision?.value) ||
      (descriptors.draftRevision?.value as number) < 1 ||
      (descriptors.draftRevision?.value as number) > 100
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      version: 1,
      workItemId: descriptors.workItemId.value,
      draftRevision: descriptors.draftRevision?.value as number,
    })
  } catch {
    throw fail('invalid_request', 'The Workbench Feishu reply proposal request is invalid.')
  }
}

function signalAt(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Workbench Feishu reply proposal request is invalid.')
  }
  return value
}

function throwIfCancelled(signal: AbortSignal): void {
  try {
    signal.throwIfAborted()
  } catch {
    throw fail('runtime_unavailable', 'The Workbench Feishu reply proposal was cancelled.')
  }
}

function configuredUser(
  configuration: FeishuIdentityConfiguration,
): NonNullable<typeof configuration.user> {
  if (configuration.user === undefined) {
    throw fail('connector_unavailable', 'A Feishu User identity is required for reply preview.')
  }
  return configuration.user
}

function latestMessageTarget(
  references: readonly ExternalReference[],
  configuration: FeishuIdentityConfiguration,
): ExternalReference {
  const candidates = references
    .filter(
      (reference) =>
        reference.connectorId === 'feishu' &&
        reference.accountId === configuration.accountId &&
        reference.objectType === 'message' &&
        reference.sourceTimestamp !== undefined,
    )
    .toSorted((left, right) => {
      const chronology =
        Date.parse(right.sourceTimestamp as string) - Date.parse(left.sourceTimestamp as string)
      return chronology === 0 ? left.externalId.localeCompare(right.externalId) : chronology
    })
  const latest = candidates[0]
  if (latest === undefined) {
    throw fail('target_unavailable', 'The Feishu reply target is unavailable.')
  }
  const ambiguous = candidates.some(
    (candidate, index) =>
      index > 0 &&
      candidate.sourceTimestamp === latest.sourceTimestamp &&
      candidate.externalId !== latest.externalId,
  )
  if (ambiguous) {
    throw fail('target_unavailable', 'The Feishu reply target is ambiguous.')
  }
  return latest
}

function stableNonce(
  configuration: FeishuIdentityConfiguration,
  draft: Draft,
  target: ExternalReference,
): string {
  const user = configuredUser(configuration)
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        workItemId: draft.workItemId,
        draftId: draft.id,
        revision: draft.revision,
        target,
        appId: configuration.appId,
        principalId: user.principalId,
        credentialReference: user.credentialReference,
      }),
      'utf8',
    )
    .digest('hex')
  return `workbench-${digest}`
}

function proposalId(configuration: FeishuIdentityConfiguration, nonce: string): ActionProposalId {
  const digest = createHash('sha256')
    .update(configuration.accountId)
    .update('\u0000')
    .update(nonce)
    .digest('hex')
    .slice(0, 32)
  return `proposal-feishu-reply-${digest}` as ActionProposalId
}

function proposalRequest(
  configuration: FeishuIdentityConfiguration,
  draft: Draft,
  target: ExternalReference,
): Parameters<FeishuReplyProposer['propose']>[0] {
  return Object.freeze({
    workItemId: draft.workItemId,
    draftId: draft.id,
    actionType: FEISHU_REPLY_ACTION_TYPE,
    identity: toFeishuActionIdentity(configuration, 'user'),
    target,
    content: draft.content,
  })
}

async function exactExistingProposal(
  configuration: FeishuIdentityConfiguration,
  draft: Draft,
  target: ExternalReference,
  nonce: string,
  existing: ActionProposal,
  signal: AbortSignal,
): Promise<ActionProposal> {
  if (existing.state !== 'proposed') {
    throw fail('target_unavailable', 'The Feishu reply preview is no longer proposed.')
  }
  const expected = await new FeishuReplyProposer(configuration, {
    now: () => Date.parse(existing.createdAt),
    createNonce: () => nonce,
  }).propose(proposalRequest(configuration, draft, target), signal)
  if (!isDeepStrictEqual(existing, expected)) {
    throw fail('target_unavailable', 'The Feishu reply preview does not match current data.')
  }
  return existing
}

function recordProposalAudit(
  database: TwinDeskDatabase,
  proposal: ActionProposal,
  draft: Draft,
): 'inserted' | 'duplicate' {
  try {
    const audit = parseAuditRecord({
      kind: 'audit_record',
      schemaVersion: 1,
      id: `${proposal.id}:user-proposed`,
      category: 'approval',
      outcome: 'success',
      actor: { type: 'user', id: 'local-user' },
      summary: 'The user created an exact Feishu reply preview.',
      references: [
        { kind: 'work_item', id: proposal.workItemId },
        { kind: 'draft', id: draft.id },
        { kind: 'action_proposal', id: proposal.id },
      ],
      details: {
        action: 'feishu_reply_proposed',
        identityType: 'user',
        risk: 'write',
        externalWrite: false,
        approval: false,
      },
      occurredAt: proposal.createdAt,
    })
    const result = database.appendAuditRecords([audit])
    const item = result.items[0]
    if (
      result.items.length !== 1 ||
      item?.inputIndex !== 0 ||
      (item.disposition !== 'inserted' && item.disposition !== 'duplicate') ||
      result.insertedCount + result.duplicateCount !== 1
    ) {
      throw new TypeError()
    }
    return item.disposition
  } catch {
    throw fail('runtime_unavailable', 'The Feishu reply preview Audit could not be stored.')
  }
}

function snapshot(
  proposal: ActionProposal,
  draftRevision: number,
  disposition: 'created' | 'recovered' | 'repaired',
): unknown {
  return Object.freeze({
    version: 1,
    disposition,
    approvalAvailable: false,
    executionAvailable: false,
    proposal: Object.freeze({
      workItemId: proposal.workItemId,
      draftRevision,
      actionType: proposal.actionType,
      risk: proposal.risk,
      state: proposal.state,
      identity: Object.freeze({ ...proposal.identity }),
      target: Object.freeze({ ...proposal.target }),
      content: Object.freeze({ ...proposal.content }),
      createdAt: proposal.createdAt,
    }),
  })
}

/** Compose the side-effect-free Feishu proposer into a restart-safe product preview. */
export function createWorkbenchFeishuReplyProposalController(
  optionsValue: WorkbenchFeishuReplyProposalControllerOptions,
): WorkbenchFeishuReplyProposalController {
  const options = optionsAt(optionsValue)
  return Object.freeze({
    async read() {
      let configuration: FeishuIdentityConfiguration | undefined
      try {
        configuration = await options.identityStore.read()
      } catch {
        return Object.freeze({
          version: 1,
          capability: 'unavailable',
          actionType: FEISHU_REPLY_ACTION_TYPE,
        })
      }
      return Object.freeze({
        version: 1,
        capability: configuration?.user === undefined ? 'unavailable' : 'ready',
        actionType: FEISHU_REPLY_ACTION_TYPE,
      })
    },
    async create(requestValue: WorkbenchFeishuReplyProposalRequest, signalValue: AbortSignal) {
      const request = requestAt(requestValue)
      const signal = signalAt(signalValue)
      throwIfCancelled(signal)
      let configuration: FeishuIdentityConfiguration | undefined
      try {
        configuration = await options.identityStore.read()
      } catch {
        throw fail('connector_unavailable', 'The Feishu identity configuration is unavailable.')
      }
      if (configuration === undefined) {
        throw fail('connector_unavailable', 'The Feishu identity configuration is unavailable.')
      }
      configuredUser(configuration)
      throwIfCancelled(signal)
      let workItem: ReturnType<TwinDeskDatabase['getWorkItem']>
      let draft: Draft | undefined
      let thread: ReturnType<TwinDeskDatabase['getThread']>
      try {
        workItem = options.database.getWorkItem(request.workItemId as WorkItemId)
        draft = options.database.getDraftByWorkItemRevision(
          request.workItemId as WorkItemId,
          request.draftRevision,
        )
        thread = workItem === undefined ? undefined : options.database.getThread(workItem.threadId)
      } catch {
        throw fail('target_unavailable', 'The Feishu reply preview target is unavailable.')
      }
      if (
        workItem === undefined ||
        draft === undefined ||
        thread === undefined ||
        draft.workItemId !== workItem.id ||
        draft.revision !== request.draftRevision ||
        draft.state !== 'ready_for_review' ||
        draft.content.mediaType !== 'text/plain'
      ) {
        throw fail('target_unavailable', 'The Feishu reply preview target is unavailable.')
      }
      const target = latestMessageTarget(thread.externalReferences, configuration)
      const nonce = stableNonce(configuration, draft, target)
      const id = proposalId(configuration, nonce)
      let existing: ActionProposal | undefined
      try {
        existing = options.database.getActionProposal(id)
      } catch {
        throw fail('target_unavailable', 'The Feishu reply preview target is unavailable.')
      }
      if (existing !== undefined) {
        let proposal: ActionProposal
        try {
          proposal = await exactExistingProposal(
            configuration,
            draft,
            target,
            nonce,
            existing,
            signal,
          )
        } catch (error) {
          if (error instanceof WorkbenchFeishuReplyProposalError) throw error
          if (signal.aborted) throwIfCancelled(signal)
          throw fail('target_unavailable', 'The Feishu reply preview target is unavailable.')
        }
        const auditDisposition = recordProposalAudit(options.database, proposal, draft)
        return snapshot(
          proposal,
          draft.revision,
          auditDisposition === 'inserted' ? 'repaired' : 'recovered',
        )
      }
      let proposal: ActionProposal
      try {
        proposal = await new FeishuReplyProposer(configuration, {
          now: options.now,
          createNonce: () => nonce,
        }).propose(proposalRequest(configuration, draft, target), signal)
      } catch {
        throw fail('runtime_unavailable', 'The Feishu reply preview could not be created.')
      }
      throwIfCancelled(signal)
      let write: ReturnType<TwinDeskDatabase['createActionProposal']>
      try {
        write = options.database.createActionProposal(proposal)
      } catch {
        throw fail('runtime_unavailable', 'The Feishu reply preview could not be stored.')
      }
      let storedProposal: ActionProposal
      try {
        storedProposal =
          write.disposition === 'duplicate'
            ? await exactExistingProposal(
                configuration,
                draft,
                target,
                nonce,
                write.proposal,
                signal,
              )
            : write.proposal
      } catch (error) {
        if (error instanceof WorkbenchFeishuReplyProposalError) throw error
        if (signal.aborted) throwIfCancelled(signal)
        throw fail('target_unavailable', 'The Feishu reply preview target is unavailable.')
      }
      const auditDisposition = recordProposalAudit(options.database, storedProposal, draft)
      return snapshot(
        storedProposal,
        draft.revision,
        write.disposition === 'inserted'
          ? 'created'
          : auditDisposition === 'inserted'
            ? 'repaired'
            : 'recovered',
      )
    },
  })
}
