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
  parseModelDraftCreateSnapshot,
  parseModelDraftStatusSnapshot,
  type ModelDraftCreateSnapshot,
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
let modelDraftResult: ModelDraftCreateSnapshot | undefined
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
    return `<div class="empty-state"><h2>Loading Inbox…</h2><p>Reading local fixture projections.</p></div>`
  }
  if (inboxError !== undefined) {
    return `<div class="empty-state"><h2>Inbox unavailable</h2><p>${escapeHtml(inboxError)}</p><button class="secondary-button" type="button" data-inbox-retry>Retry</button></div>`
  }
  if (items.length === 0) {
    return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><h2>No work items</h2><p>There are no fixture items in this state.</p></div>`
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
      ? 'Complete fixture context'
      : `Partial — missing ${item.context.missing.join(', ')}`
  const generated = modelDraftResult?.draft.workItemId === item.id ? modelDraftResult : undefined
  const canCreate =
    item.personaId !== undefined &&
    modelDraftStatus?.capability === 'ready' &&
    modelDraftCsrfToken !== undefined &&
    !modelDraftCreating
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
  return `<article class="detail-card">
    <div class="detail-title"><span class="badge">${escapeHtml(stateLabel(item.inboxState))}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p></div>
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
          : `<div class="draft-preview"><div><strong>${escapeHtml(generated.draft.personaLabel)}</strong><span>Revision ${generated.draft.revision} · ${escapeHtml(generated.draft.state.replaceAll('_', ' '))}</span></div><pre>${escapeHtml(generated.draft.content.text)}</pre><p>Local Draft only. This result does not prove approval or delivery.</p></div>`
      }
    </section>
    <div class="notice"><strong>Fixture only.</strong> This page reads local synthetic data and cannot perform an external write.</div>
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
        <span class="fixture-label">Synthetic fixtures</span>
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
        <div class="setting-row"><div><h3>Business storage</h3><p>Fixture projections use TwinDesk SQLite, separate from Harness Sessions</p></div><span class="badge success">Active</span></div>
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
        <div class="sidebar-status"><span class="status-dot"></span><div><strong>Local only</strong><span>External writes disabled</span></div></div>
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

async function loadInbox(state: InboxState): Promise<void> {
  const request = ++inboxRequest
  activeInboxState = state
  inboxLoading = true
  inboxError = undefined
  selectedWorkItemId = undefined
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

async function createModelDraft(): Promise<void> {
  const workItemId = selectedWorkItemId
  const csrfToken = modelDraftCsrfToken
  if (workItemId === undefined || csrfToken === undefined || modelDraftCreating) return
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
    modelDraftCsrfToken = nextToken
  } catch (error) {
    modelDraftCreateError =
      error instanceof Error ? error.message : 'The local model Draft request failed.'
  } finally {
    modelDraftCreating = false
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
  }
  if (route.id === 'audit') void loadAudit()
  if (route.id === 'connectors') {
    void loadFeishuSettings()
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
    render()
    return
  }
  if (target.closest('[data-model-draft-create]') !== null) {
    void createModelDraft()
    return
  }
  if (target.closest('[data-inbox-retry]') !== null) void loadInbox(activeInboxState)
  if (target.closest('[data-audit-retry]') !== null) void loadAudit()
  if (target.closest('[data-feishu-settings-retry]') !== null) void loadFeishuSettings()
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
