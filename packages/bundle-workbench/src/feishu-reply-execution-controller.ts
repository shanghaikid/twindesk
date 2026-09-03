import {
  FeishuIdentityConfigurationStore,
  FeishuOAuthRotationCoordinator,
  FeishuOAuthRotationJournal,
  FeishuOAuthV3HttpTransport,
  FeishuOAuthV3TokenRefresher,
  FeishuReplyHttpClient,
  FeishuRuntimeLeaseManager,
  FeishuSystemKeychainSecretReplacer,
  FeishuSystemKeychainSecretResolver,
  FeishuUserCredentialScopeProbe,
  parseFeishuIdentityConfiguration,
  type FeishuIdentityConfiguration,
} from '@twindesk/plugin-feishu'
import { parseIsoTimestamp, type ActionReceipt } from '@twindesk/domain'
import type { WorkHubActionExecutionResult } from '@twindesk/plugin-work-hub'
import { computeApprovalExecutionAttemptId, type TwinDeskDatabase } from '@twindesk/storage-sqlite'

import { workbenchFeishuReplyApprovalId } from './feishu-reply-approval-controller.ts'
import type {
  WorkbenchFeishuReplyProposalController,
  WorkbenchFeishuReplyProposalRequest,
  WorkbenchFeishuReplyProposalResolution,
} from './feishu-reply-proposal-controller.ts'
import { createWorkbenchFeishuReplyExecutionHost } from './feishu-reply-runtime.ts'

export type WorkbenchFeishuReplyExecutionErrorCode =
  | 'invalid_options'
  | 'invalid_request'
  | 'proposal_unavailable'
  | 'approval_unavailable'
  | 'execution_unavailable'

export class WorkbenchFeishuReplyExecutionError extends Error {
  readonly code: WorkbenchFeishuReplyExecutionErrorCode

  constructor(code: WorkbenchFeishuReplyExecutionErrorCode, message: string) {
    super(message)
    this.name = 'WorkbenchFeishuReplyExecutionError'
    this.code = code
  }
}

export interface WorkbenchFeishuReplyExecutionHost {
  execute(request: unknown, signal: AbortSignal): Promise<WorkHubActionExecutionResult>
}

export interface WorkbenchFeishuReplyExecutionControllerOptions {
  readonly database: TwinDeskDatabase
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly proposalController: WorkbenchFeishuReplyProposalController
  readonly createHost: (
    configuration: FeishuIdentityConfiguration,
  ) => WorkbenchFeishuReplyExecutionHost
}

export interface DefaultWorkbenchFeishuReplyExecutionControllerOptions {
  readonly database: TwinDeskDatabase
  readonly identityStore: FeishuIdentityConfigurationStore
  readonly proposalController: WorkbenchFeishuReplyProposalController
  readonly rotationJournal: FeishuOAuthRotationJournal
  readonly leaseManager?: FeishuRuntimeLeaseManager
  readonly now?: () => number
}

export interface WorkbenchFeishuReplyExecutionController {
  read(): Promise<unknown>
  execute(request: WorkbenchFeishuReplyProposalRequest, signal: AbortSignal): Promise<unknown>
}

type UnknownRecord = Readonly<Record<string, unknown>>
type ParsedOptions = Readonly<WorkbenchFeishuReplyExecutionControllerOptions>
const REQUIRED_DATABASE_METHODS = Object.freeze(['getActionApproval', 'getActionExecutionReceipt'])

function fail(
  code: WorkbenchFeishuReplyExecutionErrorCode,
  message: string,
): WorkbenchFeishuReplyExecutionError {
  return new WorkbenchFeishuReplyExecutionError(code, message)
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
    throw fail('invalid_options', 'The Workbench Feishu reply execution options are invalid.')
  }
}

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

function exactKeys(record: UnknownRecord, expected: readonly string[]): void {
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError()
  }
}

function optionsAt(value: unknown): ParsedOptions {
  const record = dataRecord(value)
  const keys = ['database', 'identityStore', 'proposalController', 'createHost']
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    typeof record.database !== 'object' ||
    record.database === null ||
    REQUIRED_DATABASE_METHODS.some((method) => !hasDataMethod(record.database as object, method)) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    typeof record.proposalController !== 'object' ||
    record.proposalController === null ||
    !hasDataMethod(record.proposalController, 'read') ||
    !hasDataMethod(record.proposalController, 'resolve') ||
    typeof record.createHost !== 'function'
  ) {
    throw fail('invalid_options', 'The Workbench Feishu reply execution options are invalid.')
  }
  return Object.freeze({
    database: record.database as TwinDeskDatabase,
    identityStore: record.identityStore,
    proposalController: record.proposalController as WorkbenchFeishuReplyProposalController,
    createHost: record.createHost as ParsedOptions['createHost'],
  })
}

function requestAt(value: unknown): WorkbenchFeishuReplyProposalRequest {
  try {
    const record = dataRecord(value)
    const keys = ['version', 'workItemId', 'draftRevision']
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(record, key)) ||
      record.version !== 1 ||
      typeof record.workItemId !== 'string' ||
      record.workItemId.length === 0 ||
      record.workItemId.length > 200 ||
      record.workItemId.trim() !== record.workItemId ||
      /[\u0000-\u001f\u007f]/u.test(record.workItemId) ||
      !Number.isSafeInteger(record.draftRevision) ||
      (record.draftRevision as number) < 1 ||
      (record.draftRevision as number) > 100
    ) {
      throw new TypeError()
    }
    return Object.freeze({
      version: 1,
      workItemId: record.workItemId,
      draftRevision: record.draftRevision as number,
    })
  } catch (error) {
    if (error instanceof WorkbenchFeishuReplyExecutionError && error.code !== 'invalid_options') {
      throw error
    }
    throw fail('invalid_request', 'The Workbench Feishu reply execution request is invalid.')
  }
}

function signalAt(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_request', 'The Workbench Feishu reply execution request is invalid.')
  }
  return value
}

function throwIfCancelled(signal: AbortSignal): void {
  try {
    signal.throwIfAborted()
  } catch {
    throw fail('execution_unavailable', 'The Workbench Feishu reply execution was cancelled.')
  }
}

async function resolve(
  options: ParsedOptions,
  request: WorkbenchFeishuReplyProposalRequest,
  signal: AbortSignal,
): Promise<WorkbenchFeishuReplyProposalResolution> {
  try {
    return await options.proposalController.resolve(request, signal)
  } catch {
    if (signal.aborted) throwIfCancelled(signal)
    throw fail('proposal_unavailable', 'The exact Feishu reply is unavailable.')
  }
}

function userOnly(configuration: FeishuIdentityConfiguration): FeishuIdentityConfiguration {
  if (configuration.user === undefined) {
    throw fail('execution_unavailable', 'The Feishu User execution identity is unavailable.')
  }
  return parseFeishuIdentityConfiguration({
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: configuration.accountId,
    appId: configuration.appId,
    user: configuration.user,
  })
}

function executionSnapshot(
  resolution: WorkbenchFeishuReplyProposalResolution,
  result: WorkHubActionExecutionResult,
): unknown {
  const receipt = result.receipt
  return Object.freeze({
    version: 1,
    disposition: result.source,
    proposal: Object.freeze({
      workItemId: resolution.proposal.workItemId,
      draftRevision: resolution.draft.revision,
      actionType: resolution.proposal.actionType,
      risk: resolution.proposal.risk,
      state:
        receipt.outcome === 'succeeded'
          ? 'succeeded'
          : receipt.outcome === 'failed'
            ? 'failed'
            : 'uncertain',
      identity: Object.freeze({ ...resolution.proposal.identity }),
      target: Object.freeze({ ...resolution.proposal.target }),
      content: Object.freeze({ ...resolution.proposal.content }),
      createdAt: resolution.proposal.createdAt,
    }),
    execution: Object.freeze({
      outcome: receipt.outcome,
      attemptedAt: receipt.attemptedAt,
      ...(receipt.outcome === 'succeeded'
        ? { externalReference: Object.freeze({ ...receipt.externalReference }) }
        : {
            retryDisposition: receipt.retryDisposition,
            issue: Object.freeze({ ...receipt.error }),
          }),
    }),
  })
}

function resultAt(
  value: unknown,
  resolution: WorkbenchFeishuReplyProposalResolution,
  approvalId: ReturnType<typeof workbenchFeishuReplyApprovalId>,
): WorkHubActionExecutionResult {
  try {
    const record = dataRecord(value)
    const receipt = dataRecord(record.receipt)
    exactKeys(record, [
      'kind',
      'schemaVersion',
      'executionAttemptId',
      'source',
      'receipt',
      'receiptDisposition',
      'auditInsertedCount',
      'auditDuplicateCount',
    ])
    if (
      record.kind !== 'work_hub_action_execution_result' ||
      record.schemaVersion !== 1 ||
      record.executionAttemptId !== computeApprovalExecutionAttemptId(approvalId) ||
      (record.source !== 'executed' && record.source !== 'recovered') ||
      (record.receiptDisposition !== 'inserted' &&
        record.receiptDisposition !== 'updated' &&
        record.receiptDisposition !== 'duplicate' &&
        record.receiptDisposition !== 'existing') ||
      !Number.isSafeInteger(record.auditInsertedCount) ||
      (record.auditInsertedCount as number) < 0 ||
      !Number.isSafeInteger(record.auditDuplicateCount) ||
      (record.auditDuplicateCount as number) < 0 ||
      receipt.proposalId !== resolution.proposal.id ||
      receipt.connectorId !== 'feishu' ||
      receipt.accountId !== resolution.proposal.identity.accountId ||
      receipt.idempotencyKey !== resolution.proposal.idempotencyKey ||
      (receipt.outcome !== 'succeeded' &&
        receipt.outcome !== 'failed' &&
        receipt.outcome !== 'uncertain')
    ) {
      throw new TypeError()
    }
    parseIsoTimestamp(receipt.attemptedAt)
    if (receipt.outcome === 'succeeded') {
      exactKeys(receipt, [
        'proposalId',
        'connectorId',
        'accountId',
        'idempotencyKey',
        'outcome',
        'attemptedAt',
        'externalReference',
      ])
      const reference = dataRecord(receipt.externalReference)
      exactKeys(reference, [
        'connectorId',
        'accountId',
        'objectType',
        'externalId',
        'sourceTimestamp',
      ])
      if (
        reference.connectorId !== 'feishu' ||
        reference.accountId !== resolution.proposal.identity.accountId ||
        reference.objectType !== 'message' ||
        typeof reference.externalId !== 'string' ||
        reference.externalId.length === 0
      ) {
        throw new TypeError()
      }
      parseIsoTimestamp(reference.sourceTimestamp)
    } else {
      exactKeys(receipt, [
        'proposalId',
        'connectorId',
        'accountId',
        'idempotencyKey',
        'outcome',
        'attemptedAt',
        'error',
        'retryDisposition',
      ])
      const issue = dataRecord(receipt.error)
      exactKeys(issue, ['code', 'message', 'retryable'])
      if (
        typeof issue.code !== 'string' ||
        issue.code.length === 0 ||
        typeof issue.message !== 'string' ||
        issue.message.length === 0 ||
        typeof issue.retryable !== 'boolean' ||
        (receipt.outcome === 'failed' &&
          receipt.retryDisposition !== 'do_not_retry' &&
          receipt.retryDisposition !== 'retry_same_key') ||
        (receipt.outcome === 'uncertain' && receipt.retryDisposition !== 'reconcile_first')
      ) {
        throw new TypeError()
      }
    }
    return record as unknown as WorkHubActionExecutionResult & { readonly receipt: ActionReceipt }
  } catch {
    throw fail('execution_unavailable', 'The Feishu reply execution result is invalid.')
  }
}

/** Resolve browser intent to one durable approval and invoke the Host-only execution boundary. */
export function createWorkbenchFeishuReplyExecutionController(
  optionsValue: WorkbenchFeishuReplyExecutionControllerOptions,
): WorkbenchFeishuReplyExecutionController {
  const options = optionsAt(optionsValue)
  return Object.freeze({
    async read() {
      try {
        const status = dataRecord(await options.proposalController.read())
        exactKeys(status, ['version', 'capability', 'actionType'])
        if (
          status.version !== 1 ||
          (status.capability !== 'ready' && status.capability !== 'unavailable') ||
          status.actionType !== 'feishu.reply'
        ) {
          throw new TypeError()
        }
        return Object.freeze({
          version: 1,
          capability: status.capability === 'ready' ? 'ready' : 'unavailable',
          actionType: 'feishu.reply',
        })
      } catch {
        return Object.freeze({ version: 1, capability: 'unavailable', actionType: 'feishu.reply' })
      }
    },
    async execute(requestValue: WorkbenchFeishuReplyProposalRequest, signalValue: AbortSignal) {
      const request = requestAt(requestValue)
      const signal = signalAt(signalValue)
      throwIfCancelled(signal)
      const resolution = await resolve(options, request, signal)
      const approvalId = workbenchFeishuReplyApprovalId(resolution.proposal)
      try {
        const approval = options.database.getActionApproval(approvalId)
        if (approval?.proposalId !== resolution.proposal.id || approval.decision !== 'approved') {
          throw new TypeError()
        }
      } catch {
        throw fail('approval_unavailable', 'Approve the exact Feishu reply before execution.')
      }
      let configuration: FeishuIdentityConfiguration | undefined
      try {
        configuration = await options.identityStore.read()
      } catch {
        throw fail('execution_unavailable', 'The Feishu execution configuration is unavailable.')
      }
      if (configuration === undefined) {
        throw fail('execution_unavailable', 'The Feishu execution configuration is unavailable.')
      }
      throwIfCancelled(signal)
      let host: WorkbenchFeishuReplyExecutionHost
      try {
        host = options.createHost(userOnly(configuration))
        if (typeof host !== 'object' || host === null || !hasDataMethod(host, 'execute')) {
          throw new TypeError()
        }
      } catch {
        throw fail('execution_unavailable', 'The Feishu reply execution Host is unavailable.')
      }
      try {
        const result = resultAt(
          await host.execute(
            {
              kind: 'work_hub_action_execution_request',
              schemaVersion: 1,
              approvalId,
              proposalId: resolution.proposal.id,
            },
            signal,
          ),
          resolution,
          approvalId,
        )
        return executionSnapshot(resolution, result)
      } catch {
        if (signal.aborted) throwIfCancelled(signal)
        throw fail('execution_unavailable', 'The approved Feishu reply could not be executed.')
      }
    },
  })
}

/** Production-shaped macOS/Fetch composition. Construction performs no secret or network access. */
export function createDefaultWorkbenchFeishuReplyExecutionController(
  optionsValue: DefaultWorkbenchFeishuReplyExecutionControllerOptions,
): WorkbenchFeishuReplyExecutionController {
  const record = dataRecord(optionsValue)
  const required = ['database', 'identityStore', 'proposalController', 'rotationJournal']
  const allowed = [...required, 'leaseManager', 'now']
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !(record.identityStore instanceof FeishuIdentityConfigurationStore) ||
    !(record.rotationJournal instanceof FeishuOAuthRotationJournal) ||
    (record.leaseManager !== undefined &&
      !(record.leaseManager instanceof FeishuRuntimeLeaseManager)) ||
    (record.now !== undefined && typeof record.now !== 'function')
  ) {
    throw fail('invalid_options', 'The Workbench Feishu reply execution options are invalid.')
  }
  const options = record as unknown as DefaultWorkbenchFeishuReplyExecutionControllerOptions
  const now = options.now ?? Date.now
  return createWorkbenchFeishuReplyExecutionController({
    database: options.database,
    identityStore: options.identityStore,
    proposalController: options.proposalController,
    createHost(configuration) {
      const resolver = new FeishuSystemKeychainSecretResolver()
      const replacer = new FeishuSystemKeychainSecretReplacer()
      const userScopeProbe = new FeishuUserCredentialScopeProbe({ configuration, resolver, now })
      const userRotationCoordinator = new FeishuOAuthRotationCoordinator({
        resolver,
        refresher: new FeishuOAuthV3TokenRefresher({
          transport: new FeishuOAuthV3HttpTransport(),
          now,
        }),
        replacer,
        journal: options.rotationJournal,
        now,
      })
      return createWorkbenchFeishuReplyExecutionHost({
        database: options.database,
        configuration,
        resolver,
        replyClient: new FeishuReplyHttpClient(),
        userScopeProbe,
        userRotationCoordinator,
        ...(options.leaseManager === undefined ? {} : { leaseManager: options.leaseManager }),
        now,
      })
    },
  })
}
