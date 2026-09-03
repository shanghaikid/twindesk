import {
  DEFAULT_TWIN_DESK_ROUTE,
  resolveTwinDeskRoute,
  TWIN_DESK_ROUTES,
  type TwinDeskRoute,
} from './routes.ts'
import {
  parseInboxSnapshot,
  type InboxItem,
  type InboxSnapshot,
  type InboxState,
} from './inbox-contract.ts'
import { parseAuditSnapshot, type AuditSnapshot } from './audit-contract.ts'
import {
  parseFeishuOAuthSettingsUpdate,
  parseFeishuSettingsSnapshot,
  parseFeishuUserIdentityCreate,
  type FeishuOAuthSettingsUpdate,
  type FeishuSettingsSnapshot,
  type FeishuUserIdentityCreate,
} from './feishu-settings-contract.ts'
import {
  parseFeishuDiagnosticsSnapshot,
  type FeishuDiagnosticRecovery,
  type FeishuDiagnosticsSnapshot,
} from './feishu-diagnostics-contract.ts'
import {
  parseFeishuAuthorizationSnapshot,
  type FeishuAuthorizationRecovery,
  type FeishuAuthorizationSnapshot,
} from './feishu-authorization-contract.ts'
import {
  parseFeishuOAuthRecoverySnapshot,
  type FeishuOAuthRecoverySnapshot,
  type FeishuOAuthRecoveryState,
} from './feishu-oauth-recovery-contract.ts'
import { parseFeishuOAuthReconciliationSnapshot } from './feishu-oauth-reconciliation-contract.ts'
import {
  parseFeishuReauthorizationSnapshot,
  type FeishuReauthorizationRecovery,
  type FeishuReauthorizationSnapshot,
} from './feishu-reauthorization-contract.ts'
import {
  parseFeishuReplyApprovalDecisionRequest,
  parseFeishuReplyApprovalRequest,
  parseFeishuReplyApprovalSnapshot,
  parseFeishuReplyApprovalStatusSnapshot,
  type FeishuReplyApprovalDecisionRequest,
  type FeishuReplyApprovalSnapshot,
  type FeishuReplyApprovalStatusSnapshot,
} from './feishu-reply-approval-contract.ts'
import {
  parseFeishuReplyExecutionRequest,
  parseFeishuReplyExecutionSnapshot,
  parseFeishuReplyExecutionStatusSnapshot,
  type FeishuReplyExecutionSnapshot,
  type FeishuReplyExecutionStatusSnapshot,
} from './feishu-reply-execution-contract.ts'
import { parseFeishuReplyFlowSnapshot } from './feishu-reply-flow-contract.ts'
import {
  parseFeishuReplyProposalCreateRequest,
  parseFeishuReplyProposalSnapshot,
  parseFeishuReplyProposalStatusSnapshot,
  type FeishuReplyProposalSnapshot,
  type FeishuReplyProposalStatusSnapshot,
} from './feishu-reply-proposal-contract.ts'
import {
  parseModelDraftCreateSnapshot,
  parseModelDraftEditRequest,
  parseModelDraftEditSnapshot,
  parseModelDraftStatusSnapshot,
  type ModelDraftCreateSnapshot,
  type ModelDraftEditSnapshot,
  type ModelDraftStatusSnapshot,
} from './model-draft-contract.ts'

const INBOX_STATES: readonly { readonly id: InboxState; readonly label: string }[] = [
  { id: 'needs_reply', label: 'Needs reply' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
]
const EMPTY_COUNTS: Readonly<Record<InboxState, number>> = {
  needs_reply: 0,
  needs_review: 0,
  waiting: 0,
  done: 0,
}

const root = document.querySelector<HTMLElement>('#root')
if (root === null) throw new Error('TwinDesk Web root is missing')
const appRoot = root
let activeInboxState: InboxState = 'needs_reply'
let inboxSnapshot: InboxSnapshot | undefined
let selectedWorkItemId: string | undefined
let inboxLoading = false
let inboxError: string | undefined
let inboxRequest = 0
let modelDraftStatus: ModelDraftStatusSnapshot | undefined
let modelDraftCsrfToken: string | undefined
let modelDraftStatusLoading = false
let modelDraftStatusError: string | undefined
let modelDraftStatusRequest = 0
let modelDraftCreating = false
let modelDraftCreateError: string | undefined
let modelDraftResult: ModelDraftCreateSnapshot | ModelDraftEditSnapshot | undefined
let modelDraftEditing = false
let modelDraftEditError: string | undefined
let modelDraftEditorText: string | undefined
let feishuReplyProposalStatus: FeishuReplyProposalStatusSnapshot | undefined
let feishuReplyProposalCsrfToken: string | undefined
let feishuReplyProposalStatusLoading = false
let feishuReplyProposalStatusError: string | undefined
let feishuReplyProposalStatusRequest = 0
let feishuReplyProposalCreating = false
let feishuReplyProposalError: string | undefined
let feishuReplyProposalResult: FeishuReplyProposalSnapshot | undefined
let feishuReplyApprovalStatus: FeishuReplyApprovalStatusSnapshot | undefined
let feishuReplyApprovalCsrfToken: string | undefined
let feishuReplyApprovalStatusLoading = false
let feishuReplyApprovalStatusError: string | undefined
let feishuReplyApprovalStatusRequest = 0
let feishuReplyApprovalBusy = false
let feishuReplyApprovalError: string | undefined
let feishuReplyApprovalResult: FeishuReplyApprovalSnapshot | undefined
let feishuReplyExecutionStatus: FeishuReplyExecutionStatusSnapshot | undefined
let feishuReplyExecutionCsrfToken: string | undefined
let feishuReplyExecutionStatusLoading = false
let feishuReplyExecutionStatusError: string | undefined
let feishuReplyExecutionStatusRequest = 0
let feishuReplyExecuting = false
let feishuReplyExecutionError: string | undefined
let feishuReplyExecutionResult: FeishuReplyExecutionSnapshot | undefined
let feishuReplyFlowLoading = false
let feishuReplyFlowError: string | undefined
let feishuReplyFlowRequest = 0
let auditSnapshot: AuditSnapshot | undefined
let auditLoading = false
let auditError: string | undefined
let auditRequest = 0
let feishuSettings: FeishuSettingsSnapshot | undefined
let feishuSettingsLoading = false
let feishuSettingsError: string | undefined
let feishuSettingsRequest = 0
let feishuSettingsCsrfToken: string | undefined
let feishuSettingsWritable = false
let feishuSettingsEditorOpen = false
let feishuSettingsSaving = false
let feishuSettingsSaveError: string | undefined
let feishuSettingsSaveSuccess: string | undefined
interface FeishuOAuthSettingsDraft {
  readonly redirectHost: string
  readonly redirectPort: string
  readonly scopes: string
}
let feishuSettingsDraft: FeishuOAuthSettingsDraft | undefined
let feishuDiagnostics: FeishuDiagnosticsSnapshot | undefined
let feishuDiagnosticsLoading = false
let feishuDiagnosticsError: string | undefined
let feishuDiagnosticsRequest = 0
type FeishuUserIdentityCreationMode = 'new' | 'existing'
interface FeishuUserIdentityDraft {
  readonly appId: string
  readonly displayName: string
  readonly principalId: string
}
let feishuUserIdentityCreationMode: FeishuUserIdentityCreationMode | undefined
let feishuUserIdentityEditorOpen = false
let feishuUserIdentitySaving = false
let feishuUserIdentitySaveError: string | undefined
let feishuUserIdentityDraft: FeishuUserIdentityDraft | undefined
let feishuAuthorization: FeishuAuthorizationSnapshot | undefined
let feishuAuthorizationLoading = false
let feishuAuthorizationError: string | undefined
let feishuAuthorizationRequest = 0
let feishuAuthorizationCsrfToken: string | undefined
let feishuAuthorizationMutating = false
let feishuAuthorizationPoll: number | undefined
let feishuOAuthRecovery: FeishuOAuthRecoverySnapshot | undefined
let feishuOAuthRecoveryLoading = false
let feishuOAuthRecoveryError: string | undefined
let feishuOAuthRecoveryRequest = 0
let feishuOAuthReconciliationCsrfToken: string | undefined
let feishuOAuthReconciliationMutating = false
let feishuOAuthReconciliationMessage: string | undefined
let feishuReauthorization: FeishuReauthorizationSnapshot | undefined
let feishuReauthorizationLoading = false
let feishuReauthorizationError: string | undefined
let feishuReauthorizationRequest = 0
let feishuReauthorizationCsrfToken: string | undefined
let feishuReauthorizationMutating = false
let feishuReauthorizationPoll: number | undefined

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case "'":
        return '&#39;'
      default:
        return '&quot;'
    }
  })
}

function navigation(route: TwinDeskRoute): string {
  return TWIN_DESK_ROUTES.map(
    (entry) => `
      <a class="nav-item${entry.id === route.id ? ' is-active' : ''}" href="${entry.path}" data-route>
        <span class="nav-dot" aria-hidden="true"></span>
        <span>${escapeHtml(entry.label)}</span>
      </a>`,
  ).join('')
}

function stateLabel(state: InboxState): string {
  return INBOX_STATES.find(({ id }) => id === state)?.label ?? state
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.valueOf())) return timestamp
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

function workItemList(items: readonly InboxItem[]): string {
  if (inboxLoading) {
    return `<div class="empty-state"><h2>Loading Inbox…</h2><p>Reading local Inbox projections.</p></div>`
  }
  if (inboxError !== undefined) {
    return `<div class="empty-state"><h2>Inbox unavailable</h2><p>${escapeHtml(inboxError)}</p><button class="secondary-button" type="button" data-inbox-retry>Retry</button></div>`
  }
  if (items.length === 0) {
    return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><h2>No work items</h2><p>There are no work items in this state.</p></div>`
  }
  return `<div class="work-items">${items
    .map(
      (
        item,
      ) => `<button class="work-item-row${item.id === selectedWorkItemId ? ' is-selected' : ''}" type="button" data-work-item-id="${escapeHtml(item.id)}">
        <span class="work-item-heading"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(formatTimestamp(item.updatedAt))}</span></span>
        <span class="work-item-summary">${escapeHtml(item.summary)}</span>
        <span class="work-item-meta"><span class="badge neutral">${escapeHtml(item.source.label)}</span>${
          item.personaLabel === undefined ? '' : `<span>${escapeHtml(item.personaLabel)}</span>`
        }</span>
      </button>`,
    )
    .join('')}</div>`
}

function workItemDetails(item: InboxItem | undefined): string {
  if (item === undefined) {
    return `<div class="detail-empty"><h2>Work item details</h2><p>Select an item to view its local projection and context.</p></div>`
  }
  const contextText =
    item.context.status === 'complete'
      ? 'Complete source context'
      : `Partial — missing ${item.context.missing.join(', ')}`
  const generated = modelDraftResult?.draft.workItemId === item.id ? modelDraftResult : undefined
  const replyPreview =
    feishuReplyProposalResult?.proposal.workItemId === item.id
      ? feishuReplyProposalResult
      : undefined
  const replyApproval =
    feishuReplyApprovalResult?.proposal.workItemId === item.id
      ? feishuReplyApprovalResult
      : undefined
  const replyApprovalLocksDraft =
    replyApproval?.approval.decision === 'pending' ||
    replyApproval?.approval.decision === 'approved'
  const replyExecution =
    feishuReplyExecutionResult?.proposal.workItemId === item.id
      ? feishuReplyExecutionResult
      : undefined
  const canExecuteReply =
    replyApproval?.approval.decision === 'approved' &&
    feishuReplyExecutionStatus?.capability === 'ready' &&
    feishuReplyExecutionCsrfToken !== undefined &&
    !feishuReplyExecuting &&
    !feishuReplyFlowLoading &&
    (replyExecution === undefined ||
      (replyExecution.execution.outcome === 'failed' &&
        replyExecution.execution.retryDisposition === 'retry_same_key'))
  const canCreate =
    generated === undefined &&
    item.personaId !== undefined &&
    modelDraftStatus?.capability === 'ready' &&
    modelDraftCsrfToken !== undefined &&
    !modelDraftCreating &&
    !modelDraftEditing &&
    !feishuReplyProposalCreating &&
    !feishuReplyApprovalBusy &&
    !feishuReplyFlowLoading &&
    !replyApprovalLocksDraft
  const modelDraftMessage =
    item.personaId === undefined
      ? 'Select a Persona before generating a Draft.'
      : modelDraftStatusLoading
        ? 'Checking the local Agent Runtime…'
        : modelDraftStatusError !== undefined
          ? modelDraftStatusError
          : modelDraftStatus?.capability !== 'ready'
            ? 'The product Agent Runtime is not connected.'
            : 'The selected Persona will create one local editing Draft. Provider, model, prompt, and authority stay Host-controlled.'
  const canCreateReplyPreview =
    generated?.draft.state === 'ready_for_review' &&
    generated.draft.content.mediaType === 'text/plain' &&
    (modelDraftEditorText ?? generated.draft.content.text) === generated.draft.content.text &&
    feishuReplyProposalStatus?.capability === 'ready' &&
    feishuReplyProposalCsrfToken !== undefined &&
    replyPreview === undefined &&
    replyApproval === undefined &&
    !modelDraftCreating &&
    !modelDraftEditing &&
    !feishuReplyProposalCreating &&
    !feishuReplyApprovalBusy &&
    !feishuReplyFlowLoading
  const replyPreviewMessage =
    generated?.draft.state !== 'ready_for_review'
      ? 'Mark the local Draft ready for review before creating an exact reply preview.'
      : generated.draft.content.mediaType !== 'text/plain'
        ? 'Feishu reply preview currently requires a plain-text Draft.'
        : (modelDraftEditorText ?? generated.draft.content.text) !== generated.draft.content.text
          ? 'Save the local edit and mark that exact revision ready for review first.'
          : feishuReplyProposalStatusLoading
            ? 'Checking the Feishu reply preview boundary…'
            : feishuReplyProposalStatusError !== undefined
              ? feishuReplyProposalStatusError
              : feishuReplyProposalStatus?.capability !== 'ready'
                ? 'A configured Feishu User identity is required for reply preview.'
                : 'TwinDesk will bind the current Draft to the Host-selected Feishu User identity and latest unique message target.'
  const canRequestReplyApproval =
    replyPreview !== undefined &&
    replyApproval === undefined &&
    feishuReplyApprovalStatus?.capability === 'ready' &&
    feishuReplyApprovalCsrfToken !== undefined &&
    !modelDraftCreating &&
    !modelDraftEditing &&
    !feishuReplyProposalCreating &&
    !feishuReplyApprovalBusy &&
    !feishuReplyFlowLoading
  const canDecideReplyApproval =
    replyApproval?.approval.decision === 'pending' &&
    feishuReplyApprovalCsrfToken !== undefined &&
    !feishuReplyApprovalBusy &&
    !feishuReplyFlowLoading
  const replyApprovalMessage =
    replyPreview === undefined && replyApproval === undefined
      ? 'Create the exact reply preview before requesting approval.'
      : feishuReplyApprovalStatusLoading
        ? 'Checking the one-time approval boundary…'
        : feishuReplyApprovalStatusError !== undefined
          ? feishuReplyApprovalStatusError
          : feishuReplyApprovalStatus?.capability !== 'ready'
            ? 'The local one-time approval boundary is unavailable.'
            : replyApproval === undefined
              ? 'Request a 15-minute approval window for this exact account, identity, target, and content.'
              : replyApproval.approval.decision === 'pending'
                ? `Awaiting your decision until ${formatTimestamp(replyApproval.approval.expiresAt)}.`
                : replyApproval.approval.decision === 'approved'
                  ? replyExecution === undefined
                    ? replyApproval.proposal.state === 'executing'
                      ? 'Approval was consumed by an incomplete execution; explicit recovery is required.'
                      : 'Approved once. The authorization is stored but has not been consumed or sent.'
                    : `Approval consumed by the ${replyExecution.execution.outcome} execution attempt.`
                  : `Approval ${replyApproval.approval.decision}. No message was sent.`
  const replyExecutionMessage =
    replyApproval?.approval.decision !== 'approved'
      ? 'Grant one-time approval before executing this external write.'
      : feishuReplyExecutionStatusLoading
        ? 'Checking the Feishu execution boundary…'
        : feishuReplyExecutionStatusError !== undefined
          ? feishuReplyExecutionStatusError
          : feishuReplyExecutionStatus?.capability !== 'ready'
            ? 'The Host-controlled Feishu execution boundary is unavailable.'
            : replyExecution === undefined
              ? replyApproval.proposal.state === 'executing'
                ? 'This separate action asks the Host to recover or reconcile the existing attempt without a blind resend.'
                : 'This separate action will consume the approval once and send the exact content shown below.'
              : replyExecution.execution.outcome === 'succeeded'
                ? `Sent at ${formatTimestamp(replyExecution.execution.attemptedAt)}.`
                : replyExecution.execution.outcome === 'uncertain'
                  ? 'The external result is uncertain. TwinDesk will not send again automatically.'
                  : replyExecution.execution.retryDisposition === 'retry_same_key'
                    ? 'Feishu did not accept the prior attempt. You may retry with the same durable key.'
                    : 'The reply failed with a terminal result and will not be retried.'
  return `<article class="detail-card">
    <div class="detail-title"><span class="badge">${escapeHtml(stateLabel(item.inboxState))}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p></div>
    ${feishuReplyFlowLoading ? '<p class="form-message">Restoring the durable local action flow…</p>' : ''}
    ${feishuReplyFlowError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuReplyFlowError)}</p>`}
    <dl class="detail-list">
      <div><dt>Attention</dt><dd>${escapeHtml(item.attentionReason)}</dd></div>
      <div><dt>Persona</dt><dd>${escapeHtml(item.personaLabel ?? 'Not selected')}</dd></div>
      <div><dt>Source</dt><dd>${escapeHtml(item.source.label)} · ${escapeHtml(item.source.objectType)} · ${item.sourceCount} ${item.sourceCount === 1 ? 'event' : 'events'}</dd></div>
      <div><dt>Context</dt><dd>${escapeHtml(contextText)}</dd></div>
      <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(item.updatedAt))}</dd></div>
    </dl>
    <section class="draft-entry" aria-label="Model Draft">
      <div><h3>Local Draft</h3><p>${escapeHtml(modelDraftMessage)}</p></div>
      <button class="primary-button" type="button" data-model-draft-create${canCreate ? '' : ' disabled'}>${modelDraftCreating ? 'Generating…' : 'Generate Draft'}</button>
      ${modelDraftCreateError === undefined ? '' : `<p class="form-message error">${escapeHtml(modelDraftCreateError)}</p>`}
      ${
        generated === undefined
          ? ''
          : `<div class="draft-preview"><div><strong>${escapeHtml(generated.draft.personaLabel)}</strong><span>Revision ${generated.draft.revision} · ${escapeHtml(generated.draft.state.replaceAll('_', ' '))}</span></div><label class="draft-editor"><span>Draft content</span><textarea data-model-draft-text maxlength="65536" spellcheck="true"${modelDraftEditing || feishuReplyProposalCreating || feishuReplyApprovalBusy || replyApprovalLocksDraft ? ' disabled' : ''}>${escapeHtml(modelDraftEditorText ?? generated.draft.content.text)}</textarea></label><div class="settings-form-actions"><button class="secondary-button" type="button" data-model-draft-save${modelDraftEditing || feishuReplyProposalCreating || feishuReplyApprovalBusy || replyApprovalLocksDraft ? ' disabled' : ''}>${modelDraftEditing ? 'Saving…' : 'Save editing revision'}</button><button class="primary-button" type="button" data-model-draft-review${modelDraftEditing || feishuReplyProposalCreating || feishuReplyApprovalBusy || replyApprovalLocksDraft ? ' disabled' : ''}>${modelDraftEditing ? 'Saving…' : 'Ready for review'}</button></div>${modelDraftEditError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(modelDraftEditError)}</p>`}<p>Local Draft only. Ready for review is not approval and cannot deliver content.</p></div>`
      }
    </section>
    <section class="draft-entry" aria-label="Feishu reply preview">
      <div><h3>Feishu reply preview</h3><p>${escapeHtml(replyPreviewMessage)}</p></div>
      <button class="primary-button" type="button" data-feishu-reply-proposal-create${canCreateReplyPreview ? '' : ' disabled'}>${feishuReplyProposalCreating ? 'Creating…' : 'Create exact preview'}</button>
      ${feishuReplyProposalError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuReplyProposalError)}</p>`}
      ${
        replyPreview === undefined
          ? ''
          : `<div class="draft-preview"><div><strong>${escapeHtml(replyPreview.proposal.identity.displayName)}</strong><span>Feishu ${escapeHtml(replyPreview.proposal.identity.identityType)} · ${escapeHtml(replyPreview.proposal.state)}</span></div><dl class="detail-list"><div><dt>Account</dt><dd>${escapeHtml(replyPreview.proposal.identity.accountId)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(replyPreview.proposal.target.externalId)} · ${escapeHtml(formatTimestamp(replyPreview.proposal.target.sourceTimestamp))}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(replyPreview.proposal.risk)}</dd></div><div><dt>Draft</dt><dd>Revision ${replyPreview.proposal.draftRevision}</dd></div></dl><section class="proposal-content"><strong>Exact content</strong><p>${escapeHtml(replyPreview.proposal.content.text)}</p></section><p>Preview only. Nothing has been approved or sent.</p></div>`
      }
    </section>
    <section class="draft-entry" aria-label="Feishu reply approval">
      <div><h3>One-time approval</h3><p>${escapeHtml(replyApprovalMessage)}</p></div>
      ${
        replyApproval === undefined
          ? `<button class="primary-button" type="button" data-feishu-reply-approval-request${canRequestReplyApproval ? '' : ' disabled'}>${feishuReplyApprovalBusy ? 'Requesting…' : 'Request approval'}</button>`
          : replyApproval.approval.decision === 'pending'
            ? `<div class="settings-form-actions"><button class="primary-button" type="button" data-feishu-reply-approval-decision="approved"${canDecideReplyApproval ? '' : ' disabled'}>${feishuReplyApprovalBusy ? 'Saving…' : 'Approve once'}</button><button class="secondary-button" type="button" data-feishu-reply-approval-decision="rejected"${canDecideReplyApproval ? '' : ' disabled'}>Reject</button><button class="secondary-button" type="button" data-feishu-reply-approval-decision="cancelled"${canDecideReplyApproval ? '' : ' disabled'}>Cancel</button></div>`
            : ''
      }
      ${feishuReplyApprovalError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuReplyApprovalError)}</p>`}
      ${
        replyApproval === undefined
          ? ''
          : `<div class="draft-preview"><div><strong>${escapeHtml(replyApproval.proposal.identity.displayName)}</strong><span>${escapeHtml(replyApproval.approval.decision)} · expires ${escapeHtml(formatTimestamp(replyApproval.approval.expiresAt))}</span></div><dl class="detail-list"><div><dt>Account</dt><dd>${escapeHtml(replyApproval.proposal.identity.accountId)}</dd></div><div><dt>Identity</dt><dd>Feishu ${escapeHtml(replyApproval.proposal.identity.identityType)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(replyApproval.proposal.target.externalId)} · ${escapeHtml(formatTimestamp(replyApproval.proposal.target.sourceTimestamp))}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(replyApproval.proposal.risk)}</dd></div></dl><section class="proposal-content"><strong>Exact final content</strong><p>${escapeHtml(replyApproval.proposal.content.text)}</p></section><p>This decision does not execute or send the reply.</p></div>`
      }
    </section>
    <section class="draft-entry" aria-label="Feishu reply execution">
      <div><h3>Execute approved reply</h3><p>${escapeHtml(replyExecutionMessage)}</p></div>
      <button class="primary-button" type="button" data-feishu-reply-execute${canExecuteReply ? '' : ' disabled'}>${feishuReplyExecuting ? 'Sending…' : replyExecution?.execution.outcome === 'failed' ? 'Retry exact reply' : replyApproval?.proposal.state === 'executing' ? 'Recover approved reply' : 'Send approved reply'}</button>
      ${feishuReplyExecutionError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuReplyExecutionError)}</p>`}
      ${
        replyApproval?.approval.decision !== 'approved'
          ? ''
          : `<div class="draft-preview"><div><strong>${escapeHtml(replyApproval.proposal.identity.displayName)}</strong><span>Feishu User · one-time approved</span></div><dl class="detail-list"><div><dt>Account</dt><dd>${escapeHtml(replyApproval.proposal.identity.accountId)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(replyApproval.proposal.target.externalId)} · ${escapeHtml(formatTimestamp(replyApproval.proposal.target.sourceTimestamp))}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(replyApproval.proposal.risk)}</dd></div></dl><section class="proposal-content"><strong>Exact final content</strong><p>${escapeHtml(replyApproval.proposal.content.text)}</p></section>${replyExecution === undefined ? '<p>This click performs the external write.</p>' : `<p>Outcome: ${escapeHtml(replyExecution.execution.outcome)}${replyExecution.execution.outcome === 'succeeded' ? ` · remote message ${escapeHtml(replyExecution.execution.externalReference.externalId)}` : ` · ${escapeHtml(replyExecution.execution.issue.message)}`}</p>`}</div>`
      }
    </section>
    <div class="notice"><strong>Local-first.</strong> Drafting and approval remain separate; only the explicit execution action above may perform the exact external write.</div>
  </article>`
}

function inboxContent(): string {
  const counts = inboxSnapshot?.counts ?? EMPTY_COUNTS
  const items = inboxSnapshot?.items ?? []
  const selected = inboxLoading
    ? undefined
    : (items.find(({ id }) => id === selectedWorkItemId) ?? items[0])
  return `
    <div class="inbox-page">
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Inbox states">
          ${INBOX_STATES.map(
            ({ id, label }) =>
              `<button class="tab${id === activeInboxState ? ' is-active' : ''}" type="button" role="tab" aria-selected="${id === activeInboxState}" data-inbox-state="${id}">${label} <span>${counts[id]}</span></button>`,
          ).join('')}
        </div>
        <span class="fixture-label">Local projections · includes fixtures</span>
      </div>
      <div class="inbox-split">
        <section class="work-list" aria-label="Work item list">${workItemList(items)}</section>
        <aside class="detail-pane">${workItemDetails(selected)}</aside>
      </div>
    </div>`
}

function personasContent(): string {
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Configured Personas</h2><p>Persona changes behavior, not authority.</p></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Persona</th><th>Purpose</th><th>Capabilities</th><th>Authority</th></tr></thead>
          <tbody>
            <tr>
              <td><div class="name-cell"><span class="avatar">TL</span><strong>Technical Lead</strong></div></td>
              <td>Evidence-oriented technical assessment</td>
              <td>Risk review, read-only tools, bounded Codex</td>
              <td><span class="badge">Draft only</span></td>
            </tr>
            <tr>
              <td><div class="name-cell"><span class="avatar">CO</span><strong>Communication</strong></div></td>
              <td>Calm stakeholder communication</td>
              <td>Update drafting skill, no Codex</td>
              <td><span class="badge">Draft only</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="notice"><strong>Identity is not authority.</strong> A Persona cannot grant itself credentials, tools, data scopes, or write permission.</div>
    </section>`
}

function feishuAuthorizationRecovery(recovery: FeishuAuthorizationRecovery): string {
  const messages: Readonly<Record<FeishuAuthorizationRecovery, string>> = {
    configure_settings: 'Complete the local User identity and OAuth settings first.',
    correct_configuration: 'Correct the local identity or OAuth settings before retrying.',
    use_reauthorization: 'A credential already exists. Use the separate reauthorization flow.',
    reauthorize: 'The authorization must be run again before Feishu can be used.',
    reconcile_keychain: 'Keychain state is uncertain. Reconcile it before trying again.',
    retry_later: 'Feishu or the local callback was temporarily unavailable. Retry later.',
    do_not_retry: 'Authorization stopped safely. Review local diagnostics before retrying.',
  }
  return messages[recovery]
}

function feishuOAuthRecoveryMessage(state: FeishuOAuthRecoveryState): string {
  const messages: Readonly<Record<FeishuOAuthRecoveryState, string>> = {
    not_started:
      'No durable OAuth rotation history exists. This does not mean a credential is absent.',
    ready:
      'No unresolved OAuth rotation is recorded. This does not prove credential health or connectivity.',
    rotation_active: 'An OAuth rotation is active in this TwinDesk process.',
    reauthorization_required:
      'Durable OAuth state requires reauthorization before User access can resume.',
    reconciliation_required:
      'OAuth rotation state is uncertain. Reconcile the Keychain and journal before authorizing again.',
  }
  return messages[state]
}

function feishuOAuthRecoveryContent(): string {
  if (feishuOAuthRecoveryLoading) {
    return '<div class="settings-editor" data-feishu-oauth-recovery><div class="settings-editor-heading"><div><h3>OAuth recovery</h3><p>Reading minimized durable recovery state…</p></div><span class="badge neutral">Loading…</span></div></div>'
  }
  if (feishuOAuthRecoveryError !== undefined) {
    return `<div class="settings-editor" data-feishu-oauth-recovery><div class="settings-editor-heading"><div><h3>OAuth recovery</h3><p class="form-message error" role="alert">${escapeHtml(feishuOAuthRecoveryError)}</p></div><button class="secondary-button" type="button" data-feishu-oauth-recovery-retry>Retry status</button></div></div>`
  }
  const state = feishuOAuthRecovery?.state
  if (state === undefined) {
    return '<div class="settings-editor" data-feishu-oauth-recovery><div class="settings-editor-heading"><div><h3>OAuth recovery</h3><p>Recovery state is unavailable. Authorization remains blocked.</p></div><span class="badge neutral">Unavailable</span></div></div>'
  }
  const unresolved =
    state === 'rotation_active' ||
    state === 'reauthorization_required' ||
    state === 'reconciliation_required'
  const label =
    state === 'ready'
      ? 'Settled'
      : state === 'not_started'
        ? 'No history'
        : state === 'rotation_active'
          ? 'Active'
          : state === 'reauthorization_required'
            ? 'Reauthorize'
            : 'Reconcile'
  const reconciliationAction =
    state === 'reconciliation_required'
      ? `<div class="settings-form-actions"><button class="secondary-button" type="button" data-feishu-oauth-reconcile${feishuOAuthReconciliationMutating || feishuOAuthReconciliationCsrfToken === undefined ? ' disabled' : ''}>${feishuOAuthReconciliationMutating ? 'Checking…' : 'Check local credential'}</button></div><p class="muted">This only compares the configured Keychain bundle with the durable journal. It does not contact Feishu, refresh OAuth, or write Keychain.</p>${feishuOAuthReconciliationMessage === undefined ? '' : `<p class="form-message" role="status">${escapeHtml(feishuOAuthReconciliationMessage)}</p>`}`
      : ''
  return `<div class="settings-editor" data-feishu-oauth-recovery><div class="settings-editor-heading"><div><h3>OAuth recovery</h3><p${unresolved ? ' class="form-message error" role="alert"' : ''}>${escapeHtml(feishuOAuthRecoveryMessage(state))}</p></div><span class="badge${state === 'ready' ? ' success' : ' neutral'}">${label}</span></div>${reconciliationAction}</div>`
}

function feishuReauthorizationRecoveryMessage(recovery: FeishuReauthorizationRecovery): string {
  const messages: Readonly<Record<FeishuReauthorizationRecovery, string>> = {
    configure_settings: 'Complete the local User identity and OAuth settings first.',
    correct_configuration: 'Correct the local identity or OAuth settings before retrying.',
    reauthorize: 'The authorization was not accepted. Start a new explicit attempt.',
    reconcile_keychain: 'The Keychain write outcome is uncertain. Do not authorize again.',
    reconcile_rotation: 'The credential or journal outcome is uncertain. Reconcile it first.',
    retry_after_owner_exit: 'Another Feishu runtime owns the lease. Retry after it exits.',
    do_not_retry: 'Reauthorization stopped safely. Review local diagnostics before retrying.',
  }
  return messages[recovery]
}

function feishuReauthorizationContent(): string {
  const snapshot = feishuReauthorization
  const visible =
    feishuOAuthRecovery?.state === 'reauthorization_required' ||
    (snapshot !== undefined && snapshot.state !== 'idle')
  if (!visible) return ''
  if (feishuReauthorizationLoading) {
    return '<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Reauthorize Feishu User</h3><p>Reading the current in-process reauthorization state…</p></div></div></div>'
  }
  if (feishuReauthorizationError !== undefined) {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Reauthorize Feishu User</h3><p class="form-message error" role="alert">${escapeHtml(feishuReauthorizationError)}</p></div><button class="secondary-button" type="button" data-feishu-reauthorization-retry>Retry status</button></div></div>`
  }
  if (snapshot?.state === 'starting') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Starting reauthorization…</h3><p>Preparing the registered callback and one replacement authorization.</p></div><button class="secondary-button" type="button" data-feishu-reauthorization-cancel${feishuReauthorizationMutating ? ' disabled' : ''}>Cancel</button></div></div>`
  }
  if (snapshot?.state === 'waiting') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Reauthorization waiting</h3><p>Open Feishu, approve the requested scopes, then return here. Callback: ${escapeHtml(snapshot.redirectUri)}</p></div></div><div class="settings-form-actions"><button class="secondary-button" type="button" data-feishu-reauthorization-cancel${feishuReauthorizationMutating ? ' disabled' : ''}>Cancel</button><a class="primary-button" href="${escapeHtml(snapshot.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Open Feishu reauthorization</a></div></div>`
  }
  if (snapshot?.state === 'succeeded') {
    return '<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Reauthorization saved</h3><p>The replacement User credential was principal-verified, persisted in Keychain, and settled in the recovery journal. This does not claim connectivity or scope health.</p></div><span class="badge success">Saved</span></div></div>'
  }
  const outcome =
    snapshot?.state === 'failed'
      ? `<p class="form-message error" role="alert">${escapeHtml(feishuReauthorizationRecoveryMessage(snapshot.recovery))}</p>`
      : snapshot?.state === 'cancelled'
        ? '<p class="muted">The in-process reauthorization was cancelled.</p>'
        : '<p class="muted">The durable recovery journal requires an explicit replacement authorization.</p>'
  const retryBlocked =
    feishuOAuthRecovery?.state !== 'reauthorization_required' ||
    (snapshot?.state === 'failed' &&
      (snapshot.recovery === 'reconcile_keychain' ||
        snapshot.recovery === 'reconcile_rotation' ||
        snapshot.recovery === 'do_not_retry' ||
        snapshot.recovery === 'configure_settings' ||
        snapshot.recovery === 'correct_configuration'))
  return `<form class="settings-editor" data-feishu-reauthorization-form>
    <div class="settings-editor-heading"><div><h3>Reauthorize Feishu User</h3><p>Enter the Feishu app secret to replace only the durably blocked User credential.</p></div></div>
    ${outcome}
    <div class="settings-fields"><label><span>Feishu App Secret</span><input name="clientSecret" type="password" maxlength="512" autocomplete="off" spellcheck="false" required${retryBlocked ? ' disabled' : ''}></label></div>
    <p class="muted">The secret remains transient. Reauthorization restores a credential but grants no message approval or external-write authority.</p>
    <div class="settings-form-actions"><button class="primary-button" type="submit"${feishuReauthorizationMutating || retryBlocked ? ' disabled' : ''}>${feishuReauthorizationMutating ? 'Starting…' : 'Start reauthorization'}</button></div>
  </form>`
}

function feishuAuthorizationContent(): string {
  if (feishuSettings?.state !== 'ready') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Authorize Feishu User</h3><p>Complete User identity and OAuth settings before starting authorization.</p></div></div></div>`
  }
  if (feishuAuthorizationLoading) {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Authorize Feishu User</h3><p>Reading the current in-process authorization state…</p></div></div></div>`
  }
  if (feishuAuthorizationError !== undefined) {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Authorize Feishu User</h3><p class="form-message error" role="alert">${escapeHtml(feishuAuthorizationError)}</p></div><button class="secondary-button" type="button" data-feishu-authorization-retry>Retry status</button></div></div>`
  }
  const snapshot = feishuAuthorization
  if (snapshot?.state === 'starting') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Starting authorization…</h3><p>Preparing a loopback callback and Feishu authorization request.</p></div><button class="secondary-button" type="button" data-feishu-authorization-cancel${feishuAuthorizationMutating ? ' disabled' : ''}>Cancel</button></div></div>`
  }
  if (snapshot?.state === 'waiting') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Authorization waiting</h3><p>Open Feishu, approve the requested scopes, then return here. Callback: ${escapeHtml(snapshot.redirectUri)}</p></div></div><div class="settings-form-actions"><button class="secondary-button" type="button" data-feishu-authorization-cancel${feishuAuthorizationMutating ? ' disabled' : ''}>Cancel</button><a class="primary-button" href="${escapeHtml(snapshot.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Open Feishu authorization</a></div></div>`
  }
  if (snapshot?.state === 'succeeded') {
    return `<div class="settings-editor"><div class="settings-editor-heading"><div><h3>Authorization saved</h3><p>The initial User credential was principal-verified and persisted in the system Keychain. This does not claim current connectivity or token validity.</p></div><span class="badge success">Saved</span></div></div>`
  }
  const outcome =
    snapshot?.state === 'failed'
      ? `<p class="form-message error" role="alert">${escapeHtml(feishuAuthorizationRecovery(snapshot.recovery))}</p>`
      : snapshot?.state === 'cancelled'
        ? '<p class="muted">The in-process authorization was cancelled.</p>'
        : '<p class="muted">No authorization attempt is active in this TwinDesk process. This is not a persisted credential check.</p>'
  const retryBlocked =
    feishuOAuthRecoveryLoading ||
    feishuOAuthRecoveryError !== undefined ||
    feishuOAuthRecovery === undefined ||
    feishuOAuthRecovery.state === 'rotation_active' ||
    feishuOAuthRecovery.state === 'reauthorization_required' ||
    feishuOAuthRecovery.state === 'reconciliation_required' ||
    (snapshot?.state === 'failed' &&
      (snapshot.recovery === 'use_reauthorization' ||
        snapshot.recovery === 'reconcile_keychain' ||
        snapshot.recovery === 'do_not_retry'))
  return `<form class="settings-editor" data-feishu-authorization-form>
    <div class="settings-editor-heading"><div><h3>Authorize Feishu User</h3><p>Enter the Feishu app secret to begin one principal-bound OAuth authorization.</p></div></div>
    ${outcome}
    <div class="settings-fields"><label><span>Feishu App Secret</span><input name="clientSecret" type="password" maxlength="512" autocomplete="off" spellcheck="false" required${retryBlocked ? ' disabled' : ''}></label></div>
    <p class="muted">The secret is sent only to this loopback server for this attempt. It is not written to TwinDesk Settings, logs, audit records, or model context.</p>
    <div class="settings-form-actions"><button class="primary-button" type="submit"${feishuAuthorizationMutating || retryBlocked ? ' disabled' : ''}>${feishuAuthorizationMutating ? 'Starting…' : 'Start authorization'}</button></div>
  </form>`
}

function diagnosticRecoveryLabel(recovery: FeishuDiagnosticRecovery): string {
  return {
    reauthorize: 'Reauthorize the User identity',
    grant_scope: 'Grant the missing Feishu scope',
    retry: 'Retry diagnostics after the service recovers',
    repair_configuration: 'Review Connector configuration',
    restart_host: 'Restart the TwinDesk Host',
  }[recovery]
}

function diagnosticIssueLabel(code: string): string {
  if (code.endsWith('_not_authorized')) return 'A configured identity is not authorized.'
  if (code.endsWith('_scope_missing')) return 'A configured identity is missing a required scope.'
  if (code.endsWith('_rate_limited')) return 'A Feishu diagnostic probe is rate limited.'
  if (code.endsWith('_network')) return 'A Feishu diagnostic probe cannot reach its service.'
  if (code.endsWith('_storage_unavailable')) return 'Local diagnostic storage is unavailable.'
  if (code.endsWith('_invalid_response')) return 'A diagnostic response is invalid.'
  if (code === 'cursor_stale') return 'The synchronization cursor has not advanced recently.'
  if (code === 'cursor_in_future')
    return 'The synchronization cursor is newer than the local clock.'
  if (code === 'polling_disabled') return 'User message polling is disabled.'
  if (code === 'polling_stopped') return 'User message polling stopped safely.'
  return 'A Connector diagnostic probe failed.'
}

function feishuDiagnosticsContent(): string {
  if (feishuDiagnosticsLoading) {
    return `<article class="settings-editor"><div class="settings-editor-heading"><div><h3>Connector diagnostics</h3><p>Checking credentials, operation scopes, polling, and durable synchronization state…</p></div></div></article>`
  }
  if (feishuDiagnosticsError !== undefined) {
    return `<article class="settings-editor"><div class="settings-editor-heading"><div><h3>Connector diagnostics unavailable</h3><p class="form-message error" role="alert">${escapeHtml(feishuDiagnosticsError)}</p></div><button class="secondary-button" type="button" data-feishu-diagnostics-retry>Retry</button></div></article>`
  }
  const snapshot = feishuDiagnostics
  if (snapshot === undefined || snapshot.status === 'not_configured') return ''
  const statusLabel =
    snapshot.status === 'healthy'
      ? 'Healthy'
      : snapshot.status === 'degraded'
        ? 'Attention required'
        : 'Unavailable'
  const statusClass = snapshot.status === 'healthy' ? ' success' : ' neutral'
  const runtimeLabel =
    snapshot.runtime.state === 'disabled'
      ? snapshot.runtime.reason === 'host_configuration_missing'
        ? 'Polling disabled by Host configuration'
        : 'Polling not configured'
      : snapshot.runtime.state === 'starting'
        ? 'Polling starting'
        : snapshot.runtime.state === 'running'
          ? 'Polling running'
          : snapshot.runtime.state === 'stopped'
            ? 'Polling stopped during shutdown'
            : snapshot.runtime.state === 'attention_required'
              ? `Polling stopped — ${diagnosticRecoveryLabel(snapshot.runtime.recovery)}`
              : 'Polling state unavailable'
  const identityRows = snapshot.identities
    .map((identity) => {
      const missing =
        identity.status === 'unavailable'
          ? 'Credential or scope probe unavailable'
          : identity.status === 'attention_required' && identity.missingScopes.length === 0
            ? 'Authorization or rate-limit attention required'
            : identity.missingScopes.length === 0
              ? 'Required operation scopes present'
              : `Missing: ${escapeHtml(identity.missingScopes.join(', '))}`
      const label = identity.identityType === 'bot' ? 'Bot identity' : 'User identity'
      const badge =
        identity.status === 'ready'
          ? '<span class="badge success">Ready</span>'
          : identity.status === 'attention_required'
            ? '<span class="badge neutral">Attention</span>'
            : '<span class="badge neutral">Unavailable</span>'
      return `<div class="setting-row"><div><h3>${label}</h3><p>${missing}</p></div>${badge}</div>`
    })
    .join('')
  const cursorRows = snapshot.cursors
    .map(
      (cursor) =>
        `<div class="setting-row"><div><h3>Synchronization</h3><p>${escapeHtml(cursor.stream)}${cursor.updatedAt === undefined ? '' : ` · checked ${escapeHtml(formatTimestamp(cursor.updatedAt))}`}</p></div><span class="badge${cursor.status === 'current' || cursor.status === 'not_started' ? ' success' : ' neutral'}">${escapeHtml(cursor.status.replace('_', ' '))}</span></div>`,
    )
    .join('')
  const issues =
    snapshot.issues.length === 0
      ? ''
      : `<div class="notice"><strong>Recovery.</strong> ${snapshot.issues
          .map(
            (issue) =>
              `${escapeHtml(diagnosticIssueLabel(issue.code))} ${escapeHtml(diagnosticRecoveryLabel(issue.recovery))}.`,
          )
          .join(' ')}</div>`
  return `<article class="settings-editor">
    <div class="settings-editor-heading"><div><h3>Connector diagnostics</h3><p>${escapeHtml(runtimeLabel)}. User credential checks use the current local OAuth bundle; Bot checks also verify Feishu remotely.</p></div><div class="resource-actions"><span class="badge${statusClass}">${statusLabel}</span><button class="secondary-button" type="button" data-feishu-diagnostics-retry>Refresh</button></div></div>
    <div class="settings-list">${identityRows}${cursorRows}</div>
    ${issues}
  </article>`
}

function connectorsContent(): string {
  let feishuStatus: string
  let feishuDetails: string
  if (feishuSettingsLoading) {
    feishuStatus = '<span class="badge neutral">Loading…</span>'
    feishuDetails = 'Reading local non-secret Settings.'
  } else if (feishuSettingsError !== undefined) {
    feishuStatus = '<span class="badge neutral">Unavailable</span>'
    feishuDetails = `${escapeHtml(feishuSettingsError)} <button class="inline-button" type="button" data-feishu-settings-retry>Retry</button>`
  } else if (feishuSettings?.state === 'ready') {
    feishuStatus = '<span class="badge success">Settings ready</span>'
    feishuDetails = `Configured identities: ${escapeHtml(feishuSettings.identities.join(', '))}. OAuth callback: ${escapeHtml(feishuSettings.oauth?.redirectHost ?? '')}:${feishuSettings.oauth?.redirectPort ?? ''}. Requested scopes: ${escapeHtml(feishuSettings.oauth?.scopes.join(', ') ?? '')}.`
  } else if (feishuSettings?.state === 'incomplete') {
    feishuStatus = '<span class="badge neutral">Incomplete</span>'
    const identities =
      feishuSettings.identities.length === 0
        ? 'none'
        : escapeHtml(feishuSettings.identities.join(', '))
    const oauth =
      feishuSettings.oauth === null
        ? 'OAuth settings missing'
        : feishuSettings.oauth.appMatchesIdentity
          ? 'OAuth settings present'
          : 'OAuth app mismatch'
    feishuDetails = `Configured identities: ${identities}. ${oauth}.`
  } else {
    feishuStatus = '<span class="badge neutral">Not configured</span>'
    feishuDetails = 'No local Feishu identity or OAuth authorization Settings are configured.'
  }
  const settingsSnapshot = feishuSettings
  const canEdit =
    !feishuSettingsLoading &&
    feishuSettingsError === undefined &&
    settingsSnapshot?.identities.includes('user') === true &&
    feishuSettingsWritable &&
    feishuSettingsCsrfToken !== undefined
  const canCreateUserIdentity =
    !feishuSettingsLoading &&
    feishuSettingsError === undefined &&
    feishuUserIdentityCreationMode !== undefined &&
    feishuSettingsCsrfToken !== undefined
  let editor = ''
  if (feishuSettingsEditorOpen && canEdit && settingsSnapshot !== undefined) {
    const host = feishuSettingsDraft?.redirectHost ?? '127.0.0.1'
    const port = feishuSettingsDraft?.redirectPort ?? '43121'
    const scopes = feishuSettingsDraft?.scopes ?? 'offline_access'
    editor = `<form class="settings-editor" data-feishu-oauth-form>
      <div class="settings-editor-heading"><div><h3>Edit User OAuth settings</h3><p>The Feishu app is bound from local identity Settings and is never sent to this form.</p></div></div>
      <div class="settings-fields">
        <label><span>Callback host</span><select name="redirectHost">
          <option value="127.0.0.1"${host === '127.0.0.1' ? ' selected' : ''}>127.0.0.1</option>
          <option value="::1"${host === '::1' ? ' selected' : ''}>::1</option>
        </select></label>
        <label><span>Callback port</span><input name="redirectPort" type="number" min="1" max="65535" required value="${escapeHtml(port)}"></label>
        <label class="settings-scopes"><span>Requested scopes, one per line</span><textarea name="scopes" rows="5" required>${escapeHtml(scopes)}</textarea></label>
      </div>
      ${feishuSettingsSaveError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuSettingsSaveError)}</p>`}
      <div class="settings-form-actions">
        <button class="secondary-button" type="button" data-feishu-settings-cancel${feishuSettingsSaving ? ' disabled' : ''}>Cancel</button>
        <button class="primary-button" type="submit"${feishuSettingsSaving ? ' disabled' : ''}>${feishuSettingsSaving ? 'Saving…' : 'Save OAuth settings'}</button>
      </div>
    </form>`
  }
  let userIdentityEditor = ''
  if (feishuUserIdentityEditorOpen && canCreateUserIdentity) {
    const mode = feishuUserIdentityCreationMode as FeishuUserIdentityCreationMode
    const appId = feishuUserIdentityDraft?.appId ?? ''
    const displayName = feishuUserIdentityDraft?.displayName ?? ''
    const principalId = feishuUserIdentityDraft?.principalId ?? ''
    userIdentityEditor = `<form class="settings-editor" data-feishu-user-identity-form>
      <div class="settings-editor-heading"><div><h3>Configure User identity</h3><p>${mode === 'new' ? 'Create one local Feishu connection and a generated Keychain reference.' : 'Add a User identity to the configured Feishu application.'}</p></div></div>
      <div class="settings-fields">
        ${mode === 'new' ? `<label><span>Feishu App ID</span><input name="appId" type="text" maxlength="128" autocomplete="off" required value="${escapeHtml(appId)}"></label>` : ''}
        <label><span>Display name</span><input name="displayName" type="text" maxlength="128" autocomplete="off" required value="${escapeHtml(displayName)}"></label>
        <label><span>User open_id</span><input name="principalId" type="text" maxlength="128" autocomplete="off" required value="${escapeHtml(principalId)}"></label>
      </div>
      <p class="muted">This stores identity metadata and a generated Keychain locator only. It does not collect or create a credential.</p>
      ${feishuUserIdentitySaveError === undefined ? '' : `<p class="form-message error" role="alert">${escapeHtml(feishuUserIdentitySaveError)}</p>`}
      <div class="settings-form-actions">
        <button class="secondary-button" type="button" data-feishu-user-identity-cancel${feishuUserIdentitySaving ? ' disabled' : ''}>Cancel</button>
        <button class="primary-button" type="submit"${feishuUserIdentitySaving ? ' disabled' : ''}>${feishuUserIdentitySaving ? 'Saving…' : 'Create User identity'}</button>
      </div>
    </form>`
  }
  const editAction = canEdit
    ? `<button class="secondary-button" type="button" data-feishu-settings-edit${feishuSettingsSaving ? ' disabled' : ''}>Edit OAuth</button>`
    : ''
  const createUserIdentityAction = canCreateUserIdentity
    ? `<button class="secondary-button" type="button" data-feishu-user-identity-create${feishuUserIdentitySaving ? ' disabled' : ''}>Configure User</button>`
    : ''
  const editLimit =
    settingsSnapshot !== undefined && !settingsSnapshot.identities.includes('user')
      ? '<p class="muted">Configure a User identity locally before OAuth settings can be edited.</p>'
      : ''
  const authorization = feishuAuthorizationContent()
  const recovery = feishuOAuthRecoveryContent()
  const reauthorization = feishuReauthorizationContent()
  const diagnostics = feishuDiagnosticsContent()
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Connectors</h2><p>External identities and synchronization status.</p></div>
      </div>
      <div class="resource-list">
        <article class="resource-row">
          <span class="resource-icon">飞</span>
          <div class="resource-main"><h3>Feishu</h3><p>${feishuDetails}</p><p class="muted">Settings status only — credentials, authorization validity, and live connectivity are not shown or implied.</p>${editLimit}${feishuSettingsSaveSuccess === undefined ? '' : `<p class="form-message success" role="status">${escapeHtml(feishuSettingsSaveSuccess)}</p>`}</div>
          <div class="resource-actions">${feishuStatus}${createUserIdentityAction}${editAction}</div>
        </article>
        ${userIdentityEditor}
        ${editor}
        ${diagnostics}
        ${recovery}
        ${reauthorization}
        ${authorization}
        <article class="resource-row">
          <span class="resource-icon">J</span>
          <div class="resource-main"><h3>Jira</h3><p>Read-only Issue and Comment context with explicit partial-result handling.</p></div>
          <span class="badge neutral">Not configured</span>
        </article>
      </div>
      <div class="notice"><strong>Credential boundary.</strong> OAuth tokens and API keys will stay in the system Keychain or an encrypted secret store.</div>
    </section>`
}

function auditContent(): string {
  let body: string
  if (auditLoading) {
    body = `<tr class="empty-row"><td colspan="5"><div class="empty-state compact"><h2>Loading audit records…</h2><p>Reading the local TwinDesk timeline.</p></div></td></tr>`
  } else if (auditError !== undefined) {
    body = `<tr class="empty-row"><td colspan="5"><div class="empty-state compact"><h2>Audit timeline unavailable</h2><p>${escapeHtml(auditError)}</p><button class="secondary-button" type="button" data-audit-retry>Retry</button></div></td></tr>`
  } else if (auditSnapshot === undefined || auditSnapshot.items.length === 0) {
    body = `<tr class="empty-row"><td colspan="5"><div class="empty-state compact"><h2>No audit records</h2><p>Source events, drafts, approvals, receipts, errors, and retries will appear here.</p></div></td></tr>`
  } else {
    body = auditSnapshot.items
      .map(
        (item) => `<tr>
          <td>${escapeHtml(formatTimestamp(item.occurredAt))}</td>
          <td><span class="badge neutral">${escapeHtml(item.category)}</span></td>
          <td><strong>${escapeHtml(item.summary)}</strong><br><span class="muted">Links: ${escapeHtml(item.referenceKinds.join(', '))}</span></td>
          <td>${escapeHtml(item.actorLabel)}</td>
          <td><span class="badge${item.outcome === 'success' ? ' success' : ' neutral'}">${escapeHtml(item.outcome)}</span></td>
        </tr>`,
      )
      .join('')
  }
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Audit timeline</h2><p>User-visible decisions and local action history.</p></div>
        <span class="fixture-label">Synthetic fixtures</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Category</th><th>Summary and links</th><th>Actor</th><th>Outcome</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="notice"><strong>Separate stores.</strong> Session, run, and tool-call links remain opaque references; Harness Session events are not copied into TwinDesk SQLite.</div>
    </section>`
}

function settingsContent(): string {
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Runtime settings</h2><p>Current local configuration and implementation status.</p></div>
      </div>
      <div class="settings-list">
        <div class="setting-row"><div><h3>Product UI</h3><p>TwinDesk-owned local Web shell</p></div><span class="badge success">Active</span></div>
        <div class="setting-row"><div><h3>Agent Runtime</h3><p>DeepSeek Harness 0.1.1-rc.2, behind the adapter</p></div><span class="badge neutral">Diagnostic UI only</span></div>
        <div class="setting-row"><div><h3>Autonomy</h3><p>Reads, drafts, approvals, and execution remain separate</p></div><span class="badge success">draft_only</span></div>
        <div class="setting-row"><div><h3>Business storage</h3><p>Inbox projections use TwinDesk SQLite, separate from Harness Sessions</p></div><span class="badge success">Active</span></div>
      </div>
    </section>`
}

function contentFor(route: TwinDeskRoute): string {
  switch (route.id) {
    case 'inbox':
      return inboxContent()
    case 'personas':
      return personasContent()
    case 'connectors':
      return connectorsContent()
    case 'audit':
      return auditContent()
    case 'settings':
      return settingsContent()
  }
}

function currentRoute(): TwinDeskRoute {
  return resolveTwinDeskRoute(window.location.pathname) ?? DEFAULT_TWIN_DESK_ROUTE
}

function render(): void {
  const route = currentRoute()
  document.title = `${route.label} · TwinDesk`
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/inbox" data-route aria-label="TwinDesk Inbox">
          <span class="brand-mark">T</span><strong>TwinDesk</strong>
        </a>
        <nav class="primary-nav" aria-label="Primary navigation">${navigation(route)}</nav>
        <div class="sidebar-status"><span class="status-dot"></span><div><strong>Local only</strong><span>Approval-gated writes</span></div></div>
      </aside>
      <main class="main-shell">
        <header class="page-header">
          <div><h1>${escapeHtml(route.label)}</h1><p>${escapeHtml(route.description)}</p></div>
          <span class="badge success">draft_only</span>
        </header>
        <div class="page-content">${contentFor(route)}</div>
      </main>
    </div>`
}

function clearFeishuReplyFlowPresentation(): void {
  modelDraftResult = undefined
  modelDraftEditorText = undefined
  feishuReplyProposalResult = undefined
  feishuReplyApprovalResult = undefined
  feishuReplyExecutionResult = undefined
  feishuReplyFlowError = undefined
}

async function restoreFeishuReplyFlow(workItemId: string): Promise<void> {
  const request = ++feishuReplyFlowRequest
  feishuReplyFlowLoading = true
  feishuReplyFlowError = undefined
  render()
  try {
    const response = await fetch(
      `/api/action-flow/feishu-reply?workItemId=${encodeURIComponent(workItemId)}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyFlowSnapshot(await response.json())
    if (request !== feishuReplyFlowRequest || selectedWorkItemId !== workItemId) return
    clearFeishuReplyFlowPresentation()
    if (snapshot.stage !== 'empty') {
      modelDraftResult = snapshot.draft
      modelDraftEditorText = snapshot.draft.draft.content.text
    }
    if (snapshot.stage === 'proposal') feishuReplyProposalResult = snapshot.proposal
    if (snapshot.stage === 'approval' || snapshot.stage === 'execution') {
      feishuReplyApprovalResult = snapshot.approval
    }
    if (snapshot.stage === 'execution') feishuReplyExecutionResult = snapshot.execution
  } catch (error) {
    if (request !== feishuReplyFlowRequest || selectedWorkItemId !== workItemId) return
    clearFeishuReplyFlowPresentation()
    feishuReplyFlowError =
      error instanceof Error ? error.message : 'The durable local action flow is unavailable.'
  } finally {
    if (request === feishuReplyFlowRequest) {
      feishuReplyFlowLoading = false
      render()
    }
  }
}

async function loadInbox(state: InboxState): Promise<void> {
  const request = ++inboxRequest
  feishuReplyFlowRequest += 1
  activeInboxState = state
  inboxLoading = true
  inboxError = undefined
  selectedWorkItemId = undefined
  feishuReplyFlowLoading = false
  clearFeishuReplyFlowPresentation()
  render()
  try {
    const response = await fetch(`/api/inbox?state=${encodeURIComponent(state)}`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseInboxSnapshot(await response.json(), state)
    if (request !== inboxRequest) return
    inboxSnapshot = snapshot
    selectedWorkItemId = snapshot.items[0]?.id
    if (selectedWorkItemId !== undefined) void restoreFeishuReplyFlow(selectedWorkItemId)
  } catch (error) {
    if (request !== inboxRequest) return
    inboxSnapshot = undefined
    inboxError = error instanceof Error ? error.message : 'The local Inbox request failed.'
  } finally {
    if (request === inboxRequest) {
      inboxLoading = false
      render()
    }
  }
}

async function loadModelDraftStatus(): Promise<void> {
  const request = ++modelDraftStatusRequest
  modelDraftStatusLoading = true
  modelDraftStatusError = undefined
  render()
  try {
    const response = await fetch('/api/model-drafts', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseModelDraftStatusSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-model-draft-csrf-token')
    if (
      (snapshot.capability === 'ready' &&
        (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken))) ||
      (snapshot.capability === 'unavailable' && csrfToken !== null)
    ) {
      throw new Error('Local API returned an invalid model Draft capability.')
    }
    if (request !== modelDraftStatusRequest) return
    modelDraftStatus = snapshot
    modelDraftCsrfToken = csrfToken ?? undefined
  } catch (error) {
    if (request !== modelDraftStatusRequest) return
    modelDraftStatus = undefined
    modelDraftCsrfToken = undefined
    modelDraftStatusError =
      error instanceof Error ? error.message : 'The local Agent Runtime check failed.'
  } finally {
    if (request === modelDraftStatusRequest) {
      modelDraftStatusLoading = false
      render()
    }
  }
}

async function loadFeishuReplyProposalStatus(): Promise<void> {
  const request = ++feishuReplyProposalStatusRequest
  feishuReplyProposalStatusLoading = true
  feishuReplyProposalStatusError = undefined
  render()
  try {
    const response = await fetch('/api/action-proposals/feishu-reply', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyProposalStatusSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-action-proposal-csrf-token')
    if (
      (snapshot.capability === 'ready' &&
        (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken))) ||
      (snapshot.capability === 'unavailable' && csrfToken !== null)
    ) {
      throw new Error('Local API returned an invalid reply preview capability.')
    }
    if (request !== feishuReplyProposalStatusRequest) return
    feishuReplyProposalStatus = snapshot
    feishuReplyProposalCsrfToken = csrfToken ?? undefined
  } catch (error) {
    if (request !== feishuReplyProposalStatusRequest) return
    feishuReplyProposalStatus = undefined
    feishuReplyProposalCsrfToken = undefined
    feishuReplyProposalStatusError =
      error instanceof Error ? error.message : 'The local reply preview check failed.'
  } finally {
    if (request === feishuReplyProposalStatusRequest) {
      feishuReplyProposalStatusLoading = false
      render()
    }
  }
}

async function loadFeishuReplyApprovalStatus(): Promise<void> {
  const request = ++feishuReplyApprovalStatusRequest
  feishuReplyApprovalStatusLoading = true
  feishuReplyApprovalStatusError = undefined
  render()
  try {
    const response = await fetch('/api/action-approvals/feishu-reply', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyApprovalStatusSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-action-approval-csrf-token')
    if (
      (snapshot.capability === 'ready' &&
        (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken))) ||
      (snapshot.capability === 'unavailable' && csrfToken !== null)
    ) {
      throw new Error('Local API returned an invalid reply approval capability.')
    }
    if (request !== feishuReplyApprovalStatusRequest) return
    feishuReplyApprovalStatus = snapshot
    feishuReplyApprovalCsrfToken = csrfToken ?? undefined
  } catch (error) {
    if (request !== feishuReplyApprovalStatusRequest) return
    feishuReplyApprovalStatus = undefined
    feishuReplyApprovalCsrfToken = undefined
    feishuReplyApprovalStatusError =
      error instanceof Error ? error.message : 'The local reply approval check failed.'
  } finally {
    if (request === feishuReplyApprovalStatusRequest) {
      feishuReplyApprovalStatusLoading = false
      render()
    }
  }
}

async function loadFeishuReplyExecutionStatus(): Promise<void> {
  const request = ++feishuReplyExecutionStatusRequest
  feishuReplyExecutionStatusLoading = true
  feishuReplyExecutionStatusError = undefined
  render()
  try {
    const response = await fetch('/api/action-executions/feishu-reply', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyExecutionStatusSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-action-execution-csrf-token')
    if (
      (snapshot.capability === 'ready' &&
        (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken))) ||
      (snapshot.capability === 'unavailable' && csrfToken !== null)
    ) {
      throw new Error('Local API returned an invalid reply execution capability.')
    }
    if (request !== feishuReplyExecutionStatusRequest) return
    feishuReplyExecutionStatus = snapshot
    feishuReplyExecutionCsrfToken = csrfToken ?? undefined
  } catch (error) {
    if (request !== feishuReplyExecutionStatusRequest) return
    feishuReplyExecutionStatus = undefined
    feishuReplyExecutionCsrfToken = undefined
    feishuReplyExecutionStatusError =
      error instanceof Error ? error.message : 'The local reply execution check failed.'
  } finally {
    if (request === feishuReplyExecutionStatusRequest) {
      feishuReplyExecutionStatusLoading = false
      render()
    }
  }
}

async function createModelDraft(): Promise<void> {
  const workItemId = selectedWorkItemId
  const csrfToken = modelDraftCsrfToken
  if (
    workItemId === undefined ||
    csrfToken === undefined ||
    modelDraftCreating ||
    modelDraftEditing ||
    feishuReplyProposalCreating ||
    feishuReplyApprovalBusy ||
    feishuReplyApprovalResult?.approval.decision === 'pending' ||
    feishuReplyApprovalResult?.approval.decision === 'approved'
  )
    return
  modelDraftCreating = true
  modelDraftCreateError = undefined
  render()
  try {
    const response = await fetch('/api/model-drafts/create', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-model-draft-csrf-token': csrfToken,
      },
      body: JSON.stringify({ version: 1, workItemId }),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const result = parseModelDraftCreateSnapshot(await response.json())
    if (result.draft.workItemId !== workItemId) {
      throw new Error('Local API returned a Draft for another Work Item.')
    }
    const nextToken = response.headers.get('x-twindesk-model-draft-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid model Draft capability.')
    }
    modelDraftResult = result
    modelDraftEditError = undefined
    modelDraftEditorText = result.draft.content.text
    modelDraftCsrfToken = nextToken
    feishuReplyProposalResult = undefined
    feishuReplyProposalError = undefined
    feishuReplyApprovalResult = undefined
    feishuReplyApprovalError = undefined
    feishuReplyExecutionResult = undefined
    feishuReplyExecutionError = undefined
  } catch (error) {
    modelDraftCreateError =
      error instanceof Error ? error.message : 'The local model Draft request failed.'
  } finally {
    modelDraftCreating = false
    render()
  }
}

async function editModelDraft(submitForReview: boolean): Promise<void> {
  const result = modelDraftResult
  const csrfToken = modelDraftCsrfToken
  const editor = document.querySelector<HTMLTextAreaElement>('[data-model-draft-text]')
  if (
    result === undefined ||
    csrfToken === undefined ||
    editor === null ||
    modelDraftEditing ||
    feishuReplyProposalCreating ||
    feishuReplyApprovalBusy ||
    feishuReplyApprovalResult?.approval.decision === 'pending' ||
    feishuReplyApprovalResult?.approval.decision === 'approved'
  )
    return
  let request: ReturnType<typeof parseModelDraftEditRequest>
  try {
    modelDraftEditorText = editor.value
    request = parseModelDraftEditRequest({
      version: 1,
      workItemId: result.draft.workItemId,
      sourceRevision: result.draft.revision,
      content: { mediaType: result.draft.content.mediaType, text: modelDraftEditorText },
      submitForReview,
    })
  } catch (error) {
    modelDraftEditError =
      error instanceof Error ? error.message : 'The local Draft edit is invalid.'
    render()
    return
  }
  modelDraftEditing = true
  modelDraftEditError = undefined
  render()
  try {
    const response = await fetch('/api/model-drafts/edit', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-model-draft-csrf-token': csrfToken,
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseModelDraftEditSnapshot(await response.json())
    if (
      snapshot.draft.workItemId !== request.workItemId ||
      snapshot.draft.revision < request.sourceRevision ||
      snapshot.draft.revision > request.sourceRevision + 1 ||
      (submitForReview && snapshot.draft.state !== 'ready_for_review')
    ) {
      throw new Error('Local API returned an invalid edited Draft.')
    }
    const nextToken = response.headers.get('x-twindesk-model-draft-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid model Draft capability.')
    }
    modelDraftResult = snapshot
    modelDraftEditorText = snapshot.draft.content.text
    modelDraftCsrfToken = nextToken
    feishuReplyProposalResult = undefined
    feishuReplyProposalError = undefined
    feishuReplyApprovalResult = undefined
    feishuReplyApprovalError = undefined
    feishuReplyExecutionResult = undefined
    feishuReplyExecutionError = undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The local Draft edit failed.'
    modelDraftEditError = `${message} Refresh or retry the same edit before making another revision.`
  } finally {
    modelDraftEditing = false
    render()
  }
}

async function createFeishuReplyProposal(): Promise<void> {
  const draft = modelDraftResult?.draft
  const csrfToken = feishuReplyProposalCsrfToken
  if (
    draft === undefined ||
    draft.state !== 'ready_for_review' ||
    draft.content.mediaType !== 'text/plain' ||
    feishuReplyProposalStatus?.capability !== 'ready' ||
    csrfToken === undefined ||
    modelDraftCreating ||
    modelDraftEditing ||
    feishuReplyProposalCreating ||
    feishuReplyApprovalBusy ||
    feishuReplyApprovalResult !== undefined
  ) {
    return
  }
  if ((modelDraftEditorText ?? draft.content.text) !== draft.content.text) {
    feishuReplyProposalError =
      'Save the local edit and mark that exact revision ready for review first.'
    render()
    return
  }
  let request: ReturnType<typeof parseFeishuReplyProposalCreateRequest>
  try {
    request = parseFeishuReplyProposalCreateRequest({
      version: 1,
      workItemId: draft.workItemId,
      draftRevision: draft.revision,
    })
  } catch (error) {
    feishuReplyProposalError =
      error instanceof Error ? error.message : 'The local reply preview request is invalid.'
    render()
    return
  }
  feishuReplyProposalCreating = true
  feishuReplyProposalError = undefined
  render()
  try {
    const response = await fetch('/api/action-proposals/feishu-reply/create', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-action-proposal-csrf-token': csrfToken,
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyProposalSnapshot(await response.json())
    if (
      snapshot.proposal.workItemId !== request.workItemId ||
      snapshot.proposal.draftRevision !== request.draftRevision ||
      snapshot.proposal.content.mediaType !== draft.content.mediaType ||
      snapshot.proposal.content.text !== draft.content.text
    ) {
      throw new Error('Local API returned a reply preview for another Draft.')
    }
    const nextToken = response.headers.get('x-twindesk-action-proposal-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid reply preview capability.')
    }
    feishuReplyProposalResult = snapshot
    feishuReplyProposalCsrfToken = nextToken
    feishuReplyApprovalResult = undefined
    feishuReplyApprovalError = undefined
    feishuReplyExecutionResult = undefined
    feishuReplyExecutionError = undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The local reply preview failed.'
    feishuReplyProposalError = `${message} Refresh or retry the exact Draft before editing it again.`
  } finally {
    feishuReplyProposalCreating = false
    render()
  }
}

async function mutateFeishuReplyApproval(
  decision?: FeishuReplyApprovalDecisionRequest['decision'],
): Promise<void> {
  const preview = feishuReplyProposalResult
  const csrfToken = feishuReplyApprovalCsrfToken
  if (
    preview === undefined ||
    csrfToken === undefined ||
    feishuReplyApprovalStatus?.capability !== 'ready' ||
    feishuReplyApprovalBusy ||
    (decision !== undefined && feishuReplyApprovalResult?.approval.decision !== 'pending')
  ) {
    return
  }
  let input:
    | ReturnType<typeof parseFeishuReplyApprovalRequest>
    | ReturnType<typeof parseFeishuReplyApprovalDecisionRequest>
  try {
    const base = {
      version: 1,
      workItemId: preview.proposal.workItemId,
      draftRevision: preview.proposal.draftRevision,
    }
    input =
      decision === undefined
        ? parseFeishuReplyApprovalRequest(base)
        : parseFeishuReplyApprovalDecisionRequest({ ...base, decision })
  } catch (error) {
    feishuReplyApprovalError =
      error instanceof Error ? error.message : 'The local reply approval request is invalid.'
    render()
    return
  }
  feishuReplyApprovalBusy = true
  feishuReplyApprovalError = undefined
  render()
  try {
    const response = await fetch(
      decision === undefined
        ? '/api/action-approvals/feishu-reply/request'
        : '/api/action-approvals/feishu-reply/decide',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-twindesk-action-approval-csrf-token': csrfToken,
        },
        body: JSON.stringify(input),
      },
    )
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyApprovalSnapshot(await response.json())
    if (
      snapshot.proposal.workItemId !== input.workItemId ||
      snapshot.proposal.draftRevision !== input.draftRevision ||
      snapshot.proposal.identity.accountId !== preview.proposal.identity.accountId ||
      snapshot.proposal.identity.displayName !== preview.proposal.identity.displayName ||
      snapshot.proposal.target.externalId !== preview.proposal.target.externalId ||
      snapshot.proposal.target.sourceTimestamp !== preview.proposal.target.sourceTimestamp ||
      snapshot.proposal.content.text !== preview.proposal.content.text ||
      snapshot.operation !== (decision === undefined ? 'request' : 'decision')
    ) {
      throw new Error('Local API returned approval for another reply preview.')
    }
    const nextToken = response.headers.get('x-twindesk-action-approval-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid reply approval capability.')
    }
    feishuReplyApprovalResult = snapshot
    feishuReplyApprovalCsrfToken = nextToken
    feishuReplyExecutionResult = undefined
    feishuReplyExecutionError = undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The local reply approval failed.'
    feishuReplyApprovalError = `${message} Retry the same operation to recover its durable result.`
  } finally {
    feishuReplyApprovalBusy = false
    render()
  }
}

async function executeFeishuReply(): Promise<void> {
  const approval = feishuReplyApprovalResult
  const csrfToken = feishuReplyExecutionCsrfToken
  if (
    approval?.approval.decision !== 'approved' ||
    csrfToken === undefined ||
    feishuReplyExecutionStatus?.capability !== 'ready' ||
    feishuReplyExecuting ||
    (feishuReplyExecutionResult !== undefined &&
      (feishuReplyExecutionResult.execution.outcome !== 'failed' ||
        feishuReplyExecutionResult.execution.retryDisposition !== 'retry_same_key'))
  ) {
    return
  }
  let input: ReturnType<typeof parseFeishuReplyExecutionRequest>
  try {
    input = parseFeishuReplyExecutionRequest({
      version: 1,
      workItemId: approval.proposal.workItemId,
      draftRevision: approval.proposal.draftRevision,
    })
  } catch (error) {
    feishuReplyExecutionError =
      error instanceof Error ? error.message : 'The local reply execution request is invalid.'
    render()
    return
  }
  feishuReplyExecuting = true
  feishuReplyExecutionError = undefined
  render()
  try {
    const response = await fetch('/api/action-executions/feishu-reply/execute', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-action-execution-csrf-token': csrfToken,
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReplyExecutionSnapshot(await response.json())
    if (
      snapshot.proposal.workItemId !== input.workItemId ||
      snapshot.proposal.draftRevision !== input.draftRevision ||
      snapshot.proposal.identity.accountId !== approval.proposal.identity.accountId ||
      snapshot.proposal.identity.displayName !== approval.proposal.identity.displayName ||
      snapshot.proposal.target.externalId !== approval.proposal.target.externalId ||
      snapshot.proposal.target.sourceTimestamp !== approval.proposal.target.sourceTimestamp ||
      snapshot.proposal.content.text !== approval.proposal.content.text
    ) {
      throw new Error('Local API returned execution for another approved reply.')
    }
    const nextToken = response.headers.get('x-twindesk-action-execution-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid reply execution capability.')
    }
    feishuReplyExecutionResult = snapshot
    feishuReplyExecutionCsrfToken = nextToken
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The approved reply execution failed.'
    feishuReplyExecutionError = `${message} Refresh local state before deciding whether recovery is needed.`
  } finally {
    feishuReplyExecuting = false
    render()
  }
}

async function loadAudit(): Promise<void> {
  const request = ++auditRequest
  auditLoading = true
  auditError = undefined
  render()
  try {
    const response = await fetch('/api/audit', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseAuditSnapshot(await response.json())
    if (request !== auditRequest) return
    auditSnapshot = snapshot
  } catch (error) {
    if (request !== auditRequest) return
    auditSnapshot = undefined
    auditError = error instanceof Error ? error.message : 'The local Audit request failed.'
  } finally {
    if (request === auditRequest) {
      auditLoading = false
      render()
    }
  }
}

async function loadFeishuSettings(): Promise<void> {
  const request = ++feishuSettingsRequest
  feishuSettingsLoading = true
  feishuSettingsError = undefined
  render()
  try {
    const response = await fetch('/api/settings/feishu', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuSettingsSnapshot(await response.json())
    const writableHeader = response.headers.get('x-twindesk-settings-writable')
    if (writableHeader !== 'true' && writableHeader !== 'false') {
      throw new Error('Local API returned an invalid Feishu Settings write capability.')
    }
    const writable = writableHeader === 'true'
    const identityCreation = response.headers.get('x-twindesk-user-identity-creation')
    if (
      identityCreation !== null &&
      identityCreation !== 'new' &&
      identityCreation !== 'existing'
    ) {
      throw new Error('Local API returned an invalid Feishu identity write capability.')
    }
    if (
      (identityCreation === 'new' && snapshot.identities.length !== 0) ||
      (identityCreation === 'existing' &&
        (!snapshot.identities.includes('bot') || snapshot.identities.includes('user')))
    ) {
      throw new Error('Local API returned an inconsistent Feishu identity write capability.')
    }
    const csrfToken = response.headers.get('x-twindesk-csrf-token')
    if (
      (writable || identityCreation !== null) &&
      (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken))
    ) {
      throw new Error('Local API returned an invalid Feishu Settings write capability.')
    }
    if (!writable && identityCreation === null && csrfToken !== null) {
      throw new Error('Local API returned an unexpected Feishu Settings write capability.')
    }
    if (request !== feishuSettingsRequest) return
    feishuSettings = snapshot
    feishuSettingsWritable = writable
    feishuUserIdentityCreationMode = identityCreation ?? undefined
    feishuSettingsCsrfToken =
      writable || identityCreation !== null ? (csrfToken as string) : undefined
  } catch (error) {
    if (request !== feishuSettingsRequest) return
    feishuSettings = undefined
    feishuSettingsWritable = false
    feishuUserIdentityCreationMode = undefined
    feishuSettingsCsrfToken = undefined
    feishuSettingsError =
      error instanceof Error ? error.message : 'The local Feishu Settings request failed.'
  } finally {
    if (request === feishuSettingsRequest) {
      feishuSettingsLoading = false
      render()
    }
  }
}

async function loadFeishuDiagnostics(): Promise<void> {
  const request = ++feishuDiagnosticsRequest
  feishuDiagnosticsLoading = true
  feishuDiagnosticsError = undefined
  render()
  try {
    const response = await fetch('/api/diagnostics/feishu', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuDiagnosticsSnapshot(await response.json())
    if (request !== feishuDiagnosticsRequest) return
    feishuDiagnostics = snapshot
  } catch (error) {
    if (request !== feishuDiagnosticsRequest) return
    feishuDiagnostics = undefined
    feishuDiagnosticsError =
      error instanceof Error ? error.message : 'The local Feishu diagnostics request failed.'
  } finally {
    if (request === feishuDiagnosticsRequest) {
      feishuDiagnosticsLoading = false
      render()
    }
  }
}

async function loadFeishuOAuthRecovery(): Promise<void> {
  const request = ++feishuOAuthRecoveryRequest
  feishuOAuthRecoveryLoading = true
  feishuOAuthRecoveryError = undefined
  render()
  try {
    const response = await fetch('/api/recovery/feishu/oauth', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuOAuthRecoverySnapshot(await response.json())
    const capability = response.headers.get('x-twindesk-oauth-reconciliation')
    if (capability !== null && !/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
      throw new Error('Local API returned an invalid Feishu OAuth reconciliation capability.')
    }
    if (request !== feishuOAuthRecoveryRequest) return
    feishuOAuthRecovery = snapshot
    feishuOAuthReconciliationCsrfToken = capability ?? undefined
  } catch (error) {
    if (request !== feishuOAuthRecoveryRequest) return
    feishuOAuthRecovery = undefined
    feishuOAuthReconciliationCsrfToken = undefined
    feishuOAuthRecoveryError =
      error instanceof Error ? error.message : 'The local Feishu OAuth recovery request failed.'
  } finally {
    if (request === feishuOAuthRecoveryRequest) {
      feishuOAuthRecoveryLoading = false
      render()
    }
  }
}

async function reconcileFeishuOAuth(): Promise<void> {
  const csrfToken = feishuOAuthReconciliationCsrfToken
  if (csrfToken === undefined) {
    feishuOAuthReconciliationMessage = 'The local reconciliation capability is unavailable.'
    render()
    return
  }
  feishuOAuthReconciliationMutating = true
  feishuOAuthReconciliationMessage = undefined
  render()
  try {
    const response = await fetch('/api/recovery/feishu/oauth/reconcile', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-oauth-reconciliation': csrfToken,
      },
      body: JSON.stringify({ version: 1 }),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const result = parseFeishuOAuthReconciliationSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-oauth-reconciliation')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu OAuth reconciliation capability.')
    }
    feishuOAuthReconciliationCsrfToken = nextToken
    feishuOAuthReconciliationMessage =
      result.status === 'reconciled'
        ? 'The local credential matched a newer durable result; the journal is settled.'
        : 'No newer matching local credential was found. Reconciliation remains required.'
    await loadFeishuOAuthRecovery()
  } catch (error) {
    feishuOAuthReconciliationMessage =
      error instanceof Error ? error.message : 'The local OAuth reconciliation failed.'
    await loadFeishuOAuthRecovery()
  } finally {
    feishuOAuthReconciliationMutating = false
    render()
  }
}

function scheduleFeishuReauthorizationPoll(): void {
  if (feishuReauthorizationPoll !== undefined) window.clearTimeout(feishuReauthorizationPoll)
  feishuReauthorizationPoll = undefined
  if (
    currentRoute().id !== 'connectors' ||
    (feishuReauthorization?.state !== 'starting' && feishuReauthorization?.state !== 'waiting')
  ) {
    return
  }
  feishuReauthorizationPoll = window.setTimeout(() => {
    feishuReauthorizationPoll = undefined
    void loadFeishuReauthorization(false)
  }, 1_000)
}

async function loadFeishuReauthorization(showLoading = true): Promise<void> {
  const request = ++feishuReauthorizationRequest
  if (showLoading) feishuReauthorizationLoading = true
  feishuReauthorizationError = undefined
  render()
  try {
    const response = await fetch('/api/reauthorization/feishu', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReauthorizationSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-csrf-token')
    if (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)) {
      throw new Error('Local API returned an invalid Feishu reauthorization capability.')
    }
    if (request !== feishuReauthorizationRequest) return
    const settled = feishuReauthorization?.state !== 'succeeded' && snapshot.state === 'succeeded'
    feishuReauthorization = snapshot
    feishuReauthorizationCsrfToken = csrfToken
    if (settled) await loadFeishuOAuthRecovery()
  } catch (error) {
    if (request !== feishuReauthorizationRequest) return
    feishuReauthorization = undefined
    feishuReauthorizationCsrfToken = undefined
    feishuReauthorizationError =
      error instanceof Error ? error.message : 'The local Feishu reauthorization request failed.'
  } finally {
    if (request === feishuReauthorizationRequest) {
      feishuReauthorizationLoading = false
      render()
      scheduleFeishuReauthorizationPoll()
    }
  }
}

async function startFeishuReauthorization(input: HTMLInputElement): Promise<void> {
  const csrfToken = feishuReauthorizationCsrfToken
  if (csrfToken === undefined) {
    feishuReauthorizationError = 'The local reauthorization capability is unavailable.'
    render()
    return
  }
  const bytes = new TextEncoder().encode(input.value)
  input.value = ''
  if (bytes.byteLength === 0 || bytes.byteLength > 512) {
    bytes.fill(0)
    feishuReauthorizationError = 'The Feishu App Secret must be 1–512 UTF-8 bytes.'
    render()
    return
  }
  feishuReauthorizationMutating = true
  feishuReauthorizationError = undefined
  feishuReauthorization = Object.freeze({ version: 1, connectorId: 'feishu', state: 'starting' })
  render()
  try {
    const response = await fetch('/api/reauthorization/feishu/start', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: bytes,
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReauthorizationSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu reauthorization capability.')
    }
    feishuReauthorization = snapshot
    feishuReauthorizationCsrfToken = nextToken
    if (snapshot.state === 'succeeded') await loadFeishuOAuthRecovery()
  } catch (error) {
    feishuReauthorizationError = `${error instanceof Error ? error.message : 'The local reauthorization request failed.'} The attempt state may be uncertain; refresh status before starting again.`
  } finally {
    bytes.fill(0)
    feishuReauthorizationMutating = false
    render()
    scheduleFeishuReauthorizationPoll()
  }
}

async function cancelFeishuReauthorization(): Promise<void> {
  const csrfToken = feishuReauthorizationCsrfToken
  if (csrfToken === undefined || feishuReauthorizationMutating) return
  feishuReauthorizationMutating = true
  feishuReauthorizationError = undefined
  render()
  try {
    const response = await fetch('/api/reauthorization/feishu/cancel', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({ version: 1 }),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuReauthorizationSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu reauthorization capability.')
    }
    feishuReauthorization = snapshot
    feishuReauthorizationCsrfToken = nextToken
  } catch (error) {
    feishuReauthorizationError =
      error instanceof Error ? error.message : 'The local reauthorization cancellation failed.'
  } finally {
    feishuReauthorizationMutating = false
    render()
    scheduleFeishuReauthorizationPoll()
  }
}

function scheduleFeishuAuthorizationPoll(): void {
  if (feishuAuthorizationPoll !== undefined) window.clearTimeout(feishuAuthorizationPoll)
  feishuAuthorizationPoll = undefined
  if (
    currentRoute().id !== 'connectors' ||
    (feishuAuthorization?.state !== 'starting' && feishuAuthorization?.state !== 'waiting')
  ) {
    return
  }
  feishuAuthorizationPoll = window.setTimeout(() => {
    feishuAuthorizationPoll = undefined
    void loadFeishuAuthorization(false)
  }, 1_000)
}

async function loadFeishuAuthorization(showLoading = true): Promise<void> {
  const request = ++feishuAuthorizationRequest
  if (showLoading) feishuAuthorizationLoading = true
  feishuAuthorizationError = undefined
  render()
  try {
    const response = await fetch('/api/authorization/feishu', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuAuthorizationSnapshot(await response.json())
    const csrfToken = response.headers.get('x-twindesk-csrf-token')
    if (csrfToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)) {
      throw new Error('Local API returned an invalid Feishu authorization capability.')
    }
    if (request !== feishuAuthorizationRequest) return
    feishuAuthorization = snapshot
    feishuAuthorizationCsrfToken = csrfToken
  } catch (error) {
    if (request !== feishuAuthorizationRequest) return
    feishuAuthorization = undefined
    feishuAuthorizationCsrfToken = undefined
    feishuAuthorizationError =
      error instanceof Error ? error.message : 'The local Feishu authorization request failed.'
  } finally {
    if (request === feishuAuthorizationRequest) {
      feishuAuthorizationLoading = false
      render()
      scheduleFeishuAuthorizationPoll()
    }
  }
}

async function startFeishuAuthorization(input: HTMLInputElement): Promise<void> {
  const csrfToken = feishuAuthorizationCsrfToken
  if (csrfToken === undefined) {
    feishuAuthorizationError = 'The local authorization capability is unavailable.'
    render()
    return
  }
  const bytes = new TextEncoder().encode(input.value)
  input.value = ''
  if (bytes.byteLength === 0 || bytes.byteLength > 512) {
    bytes.fill(0)
    feishuAuthorizationError = 'The Feishu App Secret must be 1–512 UTF-8 bytes.'
    render()
    return
  }
  feishuAuthorizationMutating = true
  feishuAuthorizationError = undefined
  feishuAuthorization = Object.freeze({ version: 1, connectorId: 'feishu', state: 'starting' })
  render()
  try {
    const response = await fetch('/api/authorization/feishu/start', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: bytes,
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuAuthorizationSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu authorization capability.')
    }
    feishuAuthorization = snapshot
    feishuAuthorizationCsrfToken = nextToken
  } catch (error) {
    feishuAuthorizationError = `${error instanceof Error ? error.message : 'The local authorization request failed.'} The attempt state may be uncertain; refresh status before starting again.`
  } finally {
    bytes.fill(0)
    feishuAuthorizationMutating = false
    render()
    scheduleFeishuAuthorizationPoll()
  }
}

async function cancelFeishuAuthorization(): Promise<void> {
  const csrfToken = feishuAuthorizationCsrfToken
  if (csrfToken === undefined || feishuAuthorizationMutating) return
  feishuAuthorizationMutating = true
  feishuAuthorizationError = undefined
  render()
  try {
    const response = await fetch('/api/authorization/feishu/cancel', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({ version: 1 }),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuAuthorizationSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu authorization capability.')
    }
    feishuAuthorization = snapshot
    feishuAuthorizationCsrfToken = nextToken
  } catch (error) {
    feishuAuthorizationError =
      error instanceof Error ? error.message : 'The local authorization cancellation failed.'
  } finally {
    feishuAuthorizationMutating = false
    render()
    scheduleFeishuAuthorizationPoll()
  }
}

async function saveFeishuUserIdentity(create: FeishuUserIdentityCreate): Promise<void> {
  const csrfToken = feishuSettingsCsrfToken
  if (csrfToken === undefined) {
    feishuUserIdentitySaveError = 'The local identity write capability is unavailable.'
    render()
    return
  }
  feishuUserIdentitySaving = true
  feishuUserIdentitySaveError = undefined
  feishuSettingsSaveSuccess = undefined
  render()
  try {
    const response = await fetch('/api/settings/feishu/user-identity', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify(create),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuSettingsSnapshot(await response.json())
    const oauthWritableHeader = response.headers.get('x-twindesk-settings-writable')
    if (oauthWritableHeader !== 'true' && oauthWritableHeader !== 'false') {
      throw new Error('Local API returned an invalid Feishu Settings write capability.')
    }
    const oauthWritable = oauthWritableHeader === 'true'
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (oauthWritable && (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken))) {
      throw new Error('Local API returned an invalid Feishu Settings write capability.')
    }
    feishuSettings = snapshot
    feishuSettingsWritable = oauthWritable
    feishuSettingsCsrfToken = oauthWritable ? (nextToken as string) : undefined
    feishuUserIdentityCreationMode = undefined
    feishuUserIdentityEditorOpen = false
    feishuUserIdentityDraft = undefined
    feishuSettingsSaveSuccess = 'User identity metadata saved locally. No credential was created.'
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The local User identity creation failed.'
    feishuUserIdentitySaveError = `${message} The write result may be uncertain; refresh Settings before retrying.`
  } finally {
    feishuUserIdentitySaving = false
    render()
  }
}

async function saveFeishuOAuthSettings(update: FeishuOAuthSettingsUpdate): Promise<void> {
  const csrfToken = feishuSettingsCsrfToken
  if (csrfToken === undefined) {
    feishuSettingsSaveError = 'The local Settings write capability is unavailable.'
    render()
    return
  }
  feishuSettingsSaving = true
  feishuSettingsSaveError = undefined
  feishuSettingsSaveSuccess = undefined
  render()
  try {
    const response = await fetch('/api/settings/feishu', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify(update),
    })
    if (!response.ok) throw new Error(`Local API returned ${response.status}.`)
    const snapshot = parseFeishuSettingsSnapshot(await response.json())
    const nextToken = response.headers.get('x-twindesk-csrf-token')
    if (nextToken === null || !/^[A-Za-z0-9_-]{43}$/u.test(nextToken)) {
      throw new Error('Local API returned an invalid Feishu Settings write capability.')
    }
    feishuSettings = snapshot
    feishuSettingsCsrfToken = nextToken
    feishuSettingsEditorOpen = false
    feishuSettingsDraft = undefined
    feishuSettingsSaveSuccess = 'OAuth settings saved locally.'
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The local Feishu Settings update failed.'
    feishuSettingsSaveError = `${message} The write result may be uncertain; refresh Settings before retrying.`
  } finally {
    feishuSettingsSaving = false
    render()
  }
}

function renderRouteAndLoad(): void {
  render()
  const route = currentRoute()
  if (route.id === 'inbox') {
    void loadInbox(activeInboxState)
    void loadModelDraftStatus()
    void loadFeishuReplyProposalStatus()
    void loadFeishuReplyApprovalStatus()
    void loadFeishuReplyExecutionStatus()
  }
  if (route.id === 'audit') void loadAudit()
  if (route.id === 'connectors') {
    void loadFeishuSettings()
    void loadFeishuDiagnostics()
    void loadFeishuAuthorization()
    void loadFeishuOAuthRecovery()
    void loadFeishuReauthorization()
  } else {
    if (feishuAuthorizationPoll !== undefined) window.clearTimeout(feishuAuthorizationPoll)
    feishuAuthorizationPoll = undefined
    if (feishuReauthorizationPoll !== undefined) window.clearTimeout(feishuReauthorizationPoll)
    feishuReauthorizationPoll = undefined
  }
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a[data-route]')
  if (anchor !== null && anchor.origin === window.location.origin) {
    event.preventDefault()
    if (anchor.pathname !== window.location.pathname) history.pushState({}, '', anchor.pathname)
    renderRouteAndLoad()
    return
  }
  const stateButton = target.closest<HTMLButtonElement>('button[data-inbox-state]')
  const state = stateButton?.dataset.inboxState as InboxState | undefined
  if (state !== undefined && INBOX_STATES.some(({ id }) => id === state)) {
    void loadInbox(state)
    return
  }
  const itemButton = target.closest<HTMLButtonElement>('button[data-work-item-id]')
  if (itemButton?.dataset.workItemId !== undefined) {
    selectedWorkItemId = itemButton.dataset.workItemId
    modelDraftCreateError = undefined
    modelDraftEditError = undefined
    feishuReplyProposalError = undefined
    feishuReplyApprovalError = undefined
    feishuReplyExecutionError = undefined
    clearFeishuReplyFlowPresentation()
    render()
    void restoreFeishuReplyFlow(selectedWorkItemId)
    return
  }
  if (target.closest('[data-model-draft-create]') !== null) {
    void createModelDraft()
    return
  }
  if (target.closest('[data-model-draft-save]') !== null) {
    void editModelDraft(false)
    return
  }
  if (target.closest('[data-model-draft-review]') !== null) {
    void editModelDraft(true)
    return
  }
  if (target.closest('[data-feishu-reply-proposal-create]') !== null) {
    void createFeishuReplyProposal()
    return
  }
  if (target.closest('[data-feishu-reply-approval-request]') !== null) {
    void mutateFeishuReplyApproval()
    return
  }
  const approvalDecisionButton = target.closest<HTMLButtonElement>(
    '[data-feishu-reply-approval-decision]',
  )
  const approvalDecision = approvalDecisionButton?.dataset.feishuReplyApprovalDecision
  if (
    approvalDecision === 'approved' ||
    approvalDecision === 'rejected' ||
    approvalDecision === 'cancelled'
  ) {
    void mutateFeishuReplyApproval(approvalDecision)
    return
  }
  if (target.closest('[data-feishu-reply-execute]') !== null) {
    void executeFeishuReply()
    return
  }
  if (target.closest('[data-inbox-retry]') !== null) void loadInbox(activeInboxState)
  if (target.closest('[data-audit-retry]') !== null) void loadAudit()
  if (target.closest('[data-feishu-settings-retry]') !== null) void loadFeishuSettings()
  if (target.closest('[data-feishu-diagnostics-retry]') !== null) void loadFeishuDiagnostics()
  if (target.closest('[data-feishu-authorization-retry]') !== null) {
    void loadFeishuAuthorization()
  }
  if (target.closest('[data-feishu-oauth-recovery-retry]') !== null) {
    void loadFeishuOAuthRecovery()
  }
  if (target.closest('[data-feishu-oauth-reconcile]') !== null) {
    void reconcileFeishuOAuth()
  }
  if (target.closest('[data-feishu-reauthorization-retry]') !== null) {
    void loadFeishuReauthorization()
  }
  if (target.closest('[data-feishu-authorization-cancel]') !== null) {
    void cancelFeishuAuthorization()
  }
  if (target.closest('[data-feishu-reauthorization-cancel]') !== null) {
    void cancelFeishuReauthorization()
  }
  if (target.closest('[data-feishu-settings-edit]') !== null) {
    feishuSettingsDraft = {
      redirectHost: feishuSettings?.oauth?.redirectHost ?? '127.0.0.1',
      redirectPort: String(feishuSettings?.oauth?.redirectPort ?? 43121),
      scopes: feishuSettings?.oauth?.scopes.join('\n') ?? 'offline_access',
    }
    feishuSettingsEditorOpen = true
    feishuUserIdentityEditorOpen = false
    feishuSettingsSaveError = undefined
    feishuSettingsSaveSuccess = undefined
    render()
  }
  if (target.closest('[data-feishu-user-identity-create]') !== null) {
    feishuUserIdentityDraft = { appId: '', displayName: '', principalId: '' }
    feishuUserIdentityEditorOpen = true
    feishuSettingsEditorOpen = false
    feishuUserIdentitySaveError = undefined
    feishuSettingsSaveSuccess = undefined
    render()
  }
  if (target.closest('[data-feishu-user-identity-cancel]') !== null) {
    feishuUserIdentityEditorOpen = false
    feishuUserIdentityDraft = undefined
    feishuUserIdentitySaveError = undefined
    render()
  }
  if (target.closest('[data-feishu-settings-cancel]') !== null) {
    feishuSettingsEditorOpen = false
    feishuSettingsDraft = undefined
    feishuSettingsSaveError = undefined
    render()
  }
})

document.addEventListener('input', (event) => {
  const target = event.target
  if (target instanceof HTMLTextAreaElement && target.matches('[data-model-draft-text]')) {
    modelDraftEditorText = target.value
    const proposalButton = document.querySelector<HTMLButtonElement>(
      '[data-feishu-reply-proposal-create]',
    )
    if (proposalButton !== null) {
      const draft = modelDraftResult?.draft
      proposalButton.disabled =
        draft === undefined ||
        draft.state !== 'ready_for_review' ||
        draft.content.mediaType !== 'text/plain' ||
        target.value !== draft.content.text ||
        feishuReplyProposalStatus?.capability !== 'ready' ||
        feishuReplyProposalCsrfToken === undefined ||
        modelDraftCreating ||
        modelDraftEditing ||
        feishuReplyProposalCreating ||
        feishuReplyApprovalBusy ||
        feishuReplyApprovalResult?.approval.decision === 'pending' ||
        feishuReplyApprovalResult?.approval.decision === 'approved'
    }
  }
})
document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.matches('[data-feishu-authorization-form]')) {
    event.preventDefault()
    const input = form.elements.namedItem('clientSecret')
    if (!(input instanceof HTMLInputElement)) {
      feishuAuthorizationError = 'The Feishu authorization form is invalid.'
      render()
      return
    }
    void startFeishuAuthorization(input)
    return
  }
  if (form.matches('[data-feishu-reauthorization-form]')) {
    event.preventDefault()
    const input = form.elements.namedItem('clientSecret')
    if (!(input instanceof HTMLInputElement)) {
      feishuReauthorizationError = 'The Feishu reauthorization form is invalid.'
      render()
      return
    }
    void startFeishuReauthorization(input)
    return
  }
  if (form.matches('[data-feishu-user-identity-form]')) {
    event.preventDefault()
    const mode = feishuUserIdentityCreationMode
    try {
      if (mode === undefined) throw new TypeError()
      const values = new FormData(form)
      feishuUserIdentityDraft = {
        appId: String(values.get('appId') ?? ''),
        displayName: String(values.get('displayName') ?? ''),
        principalId: String(values.get('principalId') ?? ''),
      }
      const create = parseFeishuUserIdentityCreate({
        version: 1,
        connection: mode,
        appId: mode === 'new' ? feishuUserIdentityDraft.appId : null,
        displayName: feishuUserIdentityDraft.displayName,
        principalId: feishuUserIdentityDraft.principalId,
      })
      void saveFeishuUserIdentity(create)
    } catch {
      feishuUserIdentitySaveError = 'The Feishu User identity form is invalid.'
      render()
    }
    return
  }
  if (!form.matches('[data-feishu-oauth-form]')) return
  event.preventDefault()
  try {
    const values = new FormData(form)
    feishuSettingsDraft = {
      redirectHost: String(values.get('redirectHost') ?? ''),
      redirectPort: String(values.get('redirectPort') ?? ''),
      scopes: String(values.get('scopes') ?? ''),
    }
    const scopes = feishuSettingsDraft.scopes
      .split(/[\n,]/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
      .sort()
    const update = parseFeishuOAuthSettingsUpdate({
      version: 1,
      redirectHost: feishuSettingsDraft.redirectHost,
      redirectPort: Number(feishuSettingsDraft.redirectPort),
      scopes,
    })
    void saveFeishuOAuthSettings(update)
  } catch {
    feishuSettingsSaveError = 'The Feishu OAuth Settings form is invalid.'
    render()
  }
})
window.addEventListener('popstate', renderRouteAndLoad)
renderRouteAndLoad()
