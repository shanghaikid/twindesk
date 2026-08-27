import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_TWIN_DESK_ROUTE,
  resolveTwinDeskRoute,
  TWIN_DESK_ROUTES,
} from '../packages/web/dist/routes.js'
import { startTwinDeskWebServer } from '../packages/web/dist/server.js'

/**
 * @param {string | URL} url
 * @param {RequestInit} [init]
 */
function request(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...init.headers, connection: 'close' },
  })
}

/** @param {import('node:test').TestContext} context */
async function temporaryDatabase(context) {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-web-test-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  return join(root, 'twindesk.sqlite3')
}

test('the product Web shell owns deterministic top-level routes', () => {
  assert.deepEqual(
    TWIN_DESK_ROUTES.map(({ id, path }) => ({ id, path })),
    [
      { id: 'inbox', path: '/inbox' },
      { id: 'personas', path: '/personas' },
      { id: 'connectors', path: '/connectors' },
      { id: 'audit', path: '/audit' },
      { id: 'settings', path: '/settings' },
    ],
  )
  assert.equal(new Set(TWIN_DESK_ROUTES.map(({ path }) => path)).size, TWIN_DESK_ROUTES.length)
  assert.equal(resolveTwinDeskRoute('/'), DEFAULT_TWIN_DESK_ROUTE)
  assert.equal(resolveTwinDeskRoute('/personas/')?.id, 'personas')
  assert.equal(resolveTwinDeskRoute('/personas-similar'), undefined)
})

test('the local Web server serves product routes and restarts on the same port', async (context) => {
  const databasePath = await temporaryDatabase(context)
  const running = await startTwinDeskWebServer({ databasePath, port: 0 })
  context.after(() => running.close())

  const rootResponse = await request(`${running.url}/`)
  assert.equal(rootResponse.status, 200)
  assert.match(rootResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/u)
  assert.match(await rootResponse.text(), /<div id="root">/u)

  for (const route of TWIN_DESK_ROUTES) {
    const response = await request(`${running.url}${route.path}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/u)
  }

  const appResponse = await request(`${running.url}/app.js`)
  assert.equal(appResponse.status, 200)
  const appSource = await appResponse.text()
  assert.match(appSource, /history\.pushState/u)
  assert.match(appSource, /\/api\/inbox\?state=/u)
  assert.match(appSource, /\/api\/audit/u)
  assert.match(appSource, /function escapeHtml/u)

  const contractResponse = await request(`${running.url}/inbox-contract.js`)
  assert.equal(contractResponse.status, 200)
  assert.match(await contractResponse.text(), /function parseInboxSnapshot/u)

  const auditContractResponse = await request(`${running.url}/audit-contract.js`)
  assert.equal(auditContractResponse.status, 200)
  assert.match(await auditContractResponse.text(), /function parseAuditSnapshot/u)

  const stylesResponse = await request(`${running.url}/styles.css`)
  assert.equal(stylesResponse.status, 200)
  assert.match(await stylesResponse.text(), /\.app-shell/u)

  const healthResponse = await request(`${running.url}/health`)
  assert.deepEqual(await healthResponse.json(), {
    service: 'twindesk-web',
    status: 'ok',
    version: 1,
  })

  const inboxResponse = await request(`${running.url}/api/inbox?state=needs_review`)
  assert.equal(inboxResponse.status, 200)
  assert.match(inboxResponse.headers.get('content-type') ?? '', /^application\/json/u)
  const inbox = await inboxResponse.json()
  assert.deepEqual(inbox.counts, {
    needs_reply: 1,
    needs_review: 1,
    waiting: 1,
    done: 1,
  })
  assert.equal(inbox.fixture, true)
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].inboxState, 'needs_review')
  assert.equal(inbox.items[0].context.status, 'partial')
  assert.equal(inbox.items[0].source.label, 'Synthetic fixture')
  assert.equal('accountId' in inbox.items[0].source, false)
  const headInbox = await request(`${running.url}/api/inbox?state=done`, { method: 'HEAD' })
  assert.equal(headInbox.status, 200)
  assert.equal(await headInbox.text(), '')
  assert.equal((await request(`${running.url}/api/inbox?state=unknown`)).status, 400)
  assert.equal((await request(`${running.url}/api/inbox?state=done&extra=true`)).status, 400)

  const auditResponse = await request(`${running.url}/api/audit`)
  assert.equal(auditResponse.status, 200)
  assert.match(auditResponse.headers.get('content-type') ?? '', /^application\/json/u)
  const audit = await auditResponse.json()
  assert.equal(audit.fixture, true)
  assert.equal(audit.items.length, 4)
  assert.equal(
    audit.items.every(
      (/** @type {{ actorLabel: string, referenceKinds: string[] }} */ item) =>
        item.actorLabel === 'TwinDesk' &&
        item.referenceKinds.includes('work_item') &&
        !Object.hasOwn(item, 'details') &&
        !Object.hasOwn(item, 'id'),
    ),
    true,
  )
  const headAudit = await request(`${running.url}/api/audit`, { method: 'HEAD' })
  assert.equal(headAudit.status, 200)
  assert.equal(await headAudit.text(), '')
  assert.equal((await request(`${running.url}/api/audit?extra=true`)).status, 400)

  const postResponse = await request(`${running.url}/health`, { method: 'POST' })
  assert.equal(postResponse.status, 405)
  assert.equal(postResponse.headers.get('allow'), 'GET, HEAD')
  assert.equal((await request(`${running.url}/api/inbox`, { method: 'POST' })).status, 405)
  assert.equal((await request(`${running.url}/api/audit`, { method: 'POST' })).status, 405)
  assert.equal((await request(`${running.url}/unknown`)).status, 404)

  const port = running.port
  await running.close()
  await running.close()
  const restarted = await startTwinDeskWebServer({ databasePath, port })
  try {
    assert.equal((await request(`${restarted.url}/inbox`)).status, 200)
    const restartedInbox = await request(`${restarted.url}/api/inbox`)
    assert.deepEqual((await restartedInbox.json()).counts, inbox.counts)
  } finally {
    await restarted.close()
  }
})

test('the Web server rejects non-loopback hosts and invalid ports', async () => {
  await assert.rejects(
    startTwinDeskWebServer({
      host: /** @type {'127.0.0.1'} */ ('0.0.0.0'),
      port: 0,
    }),
    /must bind to loopback/u,
  )
  await assert.rejects(startTwinDeskWebServer({ port: 65_536 }), /port must be an integer/u)
})
