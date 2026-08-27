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
let auditSnapshot: AuditSnapshot | undefined
let auditLoading = false
let auditError: string | undefined
let auditRequest = 0

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
  return `<article class="detail-card">
    <div class="detail-title"><span class="badge">${escapeHtml(stateLabel(item.inboxState))}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p></div>
    <dl class="detail-list">
      <div><dt>Attention</dt><dd>${escapeHtml(item.attentionReason)}</dd></div>
      <div><dt>Persona</dt><dd>${escapeHtml(item.personaLabel ?? 'Not selected')}</dd></div>
      <div><dt>Source</dt><dd>${escapeHtml(item.source.label)} · ${escapeHtml(item.source.objectType)} · ${item.sourceCount} ${item.sourceCount === 1 ? 'event' : 'events'}</dd></div>
      <div><dt>Context</dt><dd>${escapeHtml(contextText)}</dd></div>
      <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(item.updatedAt))}</dd></div>
    </dl>
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

function connectorsContent(): string {
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Connectors</h2><p>External identities and synchronization status.</p></div>
      </div>
      <div class="resource-list">
        <article class="resource-row">
          <span class="resource-icon">飞</span>
          <div class="resource-main"><h3>Feishu</h3><p>Bot and User identities, message ingestion, context retrieval, and approved replies.</p></div>
          <span class="badge neutral">Not configured</span>
        </article>
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

function renderRouteAndLoad(): void {
  render()
  const route = currentRoute()
  if (route.id === 'inbox') void loadInbox(activeInboxState)
  if (route.id === 'audit') void loadAudit()
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
    render()
    return
  }
  if (target.closest('[data-inbox-retry]') !== null) void loadInbox(activeInboxState)
  if (target.closest('[data-audit-retry]') !== null) void loadAudit()
})
window.addEventListener('popstate', renderRouteAndLoad)
renderRouteAndLoad()
