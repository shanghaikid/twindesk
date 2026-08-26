import {
  DEFAULT_TWIN_DESK_ROUTE,
  resolveTwinDeskRoute,
  TWIN_DESK_ROUTES,
  type TwinDeskRoute,
} from './routes.ts'

const root = document.querySelector<HTMLElement>('#root')
if (root === null) throw new Error('TwinDesk Web root is missing')
const appRoot = root

function navigation(route: TwinDeskRoute): string {
  return TWIN_DESK_ROUTES.map(
    (entry) => `
      <a class="nav-item${entry.id === route.id ? ' is-active' : ''}" href="${entry.path}" data-route>
        <span class="nav-dot" aria-hidden="true"></span>
        <span>${entry.label}</span>
      </a>`,
  ).join('')
}

function inboxContent(): string {
  return `
    <div class="inbox-page">
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Inbox states">
          <button class="tab is-active" type="button" role="tab" aria-selected="true">Needs reply <span>0</span></button>
          <button class="tab" type="button" role="tab" aria-selected="false">Needs review <span>0</span></button>
          <button class="tab" type="button" role="tab" aria-selected="false">Waiting <span>0</span></button>
          <button class="tab" type="button" role="tab" aria-selected="false">Done <span>0</span></button>
        </div>
      </div>
      <div class="inbox-split">
        <section class="work-list" aria-label="Work item list">
          <div class="empty-state">
            <div class="empty-icon" aria-hidden="true">✓</div>
            <h2>No work items</h2>
            <p>Fixture ingestion and Connector-backed work items are not implemented yet.</p>
            <span class="badge neutral">No fixtures loaded</span>
          </div>
        </section>
        <aside class="detail-pane">
          <div class="detail-empty">
            <h2>Work item details</h2>
            <p>Select an item to view its sources, context, Persona, draft, approval, and audit history.</p>
          </div>
        </aside>
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
  return `
    <section class="panel">
      <div class="panel-header">
        <div><h2>Audit log</h2><p>User-visible decisions and external action history.</p></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Source</th><th>Action</th><th>Persona</th><th>Status</th></tr></thead>
          <tbody><tr class="empty-row"><td colspan="5"><div class="empty-state compact"><h2>No audit records</h2><p>Source events, drafts, approvals, receipts, errors, and retries will appear here.</p></div></td></tr></tbody>
        </table>
      </div>
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
        <div class="setting-row"><div><h3>Business storage</h3><p>Separate from Harness Session storage</p></div><span class="badge neutral">Not implemented</span></div>
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

function render(): void {
  const route = resolveTwinDeskRoute(window.location.pathname) ?? DEFAULT_TWIN_DESK_ROUTE
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
          <div><h1>${route.label}</h1><p>${route.description}</p></div>
          <span class="badge success">draft_only</span>
        </header>
        <div class="page-content">${contentFor(route)}</div>
      </main>
    </div>`
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a[data-route]')
  if (anchor === null || anchor.origin !== window.location.origin) return
  event.preventDefault()
  if (anchor.pathname !== window.location.pathname) history.pushState({}, '', anchor.pathname)
  render()
})
window.addEventListener('popstate', render)
render()
