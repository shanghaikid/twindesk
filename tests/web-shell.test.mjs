import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_TWIN_DESK_ROUTE,
  resolveTwinDeskRoute,
  TWIN_DESK_ROUTES,
} from '../packages/web/dist/routes.js'
import { startTwinDeskWebServer } from '../packages/web/dist/server.js'

const FEISHU_SETTINGS = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  state: 'ready',
  identities: ['bot', 'user'],
  oauth: Object.freeze({
    redirectHost: '127.0.0.1',
    redirectPort: 43121,
    scopes: ['im:message:readonly', 'offline_access'],
    appMatchesIdentity: true,
  }),
})
const EMPTY_FEISHU_SETTINGS = Object.freeze({
  version: 1,
  connectorId: 'feishu',
  state: 'not_configured',
  identities: [],
  oauth: null,
})

const feishuSettingsReader = Object.freeze({
  async read() {
    return FEISHU_SETTINGS
  },
})
const feishuOAuthRecoveryReady = Object.freeze({
  read() {
    return { version: 1, connectorId: 'feishu', state: 'not_started' }
  },
})

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

/** @param {string} url @param {Record<string, string>} headers @param {string} body */
function rawPostStatus(url, headers, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          connection: 'close',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
      },
    )
    outgoing.once('error', reject)
    outgoing.end(body)
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
  const running = await startTwinDeskWebServer({
    databasePath,
    feishuSettings: feishuSettingsReader,
    port: 0,
  })
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
  assert.match(appSource, /\/api\/settings\/feishu/u)
  assert.match(appSource, /data-feishu-oauth-form/u)
  assert.match(appSource, /feishuSettingsDraft/u)
  assert.match(appSource, /data-feishu-user-identity-form/u)
  assert.match(appSource, /\/api\/settings\/feishu\/user-identity/u)
  assert.match(appSource, /\/api\/authorization\/feishu\/start/u)
  assert.match(appSource, /\/api\/authorization\/feishu\/cancel/u)
  assert.match(appSource, /\/api\/recovery\/feishu\/oauth/u)
  assert.match(appSource, /\/api\/reauthorization\/feishu\/start/u)
  assert.match(appSource, /\/api\/reauthorization\/feishu\/cancel/u)
  assert.match(appSource, /data-feishu-authorization-form/u)
  assert.match(appSource, /data-feishu-reauthorization-form/u)
  assert.match(appSource, /data-feishu-oauth-recovery/u)
  assert.match(appSource, /bytes\.fill\(0\)/u)
  assert.match(appSource, /rel="noopener noreferrer"/u)
  assert.match(appSource, /x-twindesk-csrf-token/u)
  assert.match(appSource, /method: 'POST'/u)
  assert.match(appSource, /function escapeHtml/u)

  const contractResponse = await request(`${running.url}/inbox-contract.js`)
  assert.equal(contractResponse.status, 200)
  assert.match(await contractResponse.text(), /function parseInboxSnapshot/u)

  const auditContractResponse = await request(`${running.url}/audit-contract.js`)
  assert.equal(auditContractResponse.status, 200)
  assert.match(await auditContractResponse.text(), /function parseAuditSnapshot/u)

  const settingsContractResponse = await request(`${running.url}/feishu-settings-contract.js`)
  assert.equal(settingsContractResponse.status, 200)
  assert.match(await settingsContractResponse.text(), /function parseFeishuSettingsSnapshot/u)

  const authorizationContractResponse = await request(
    `${running.url}/feishu-authorization-contract.js`,
  )
  assert.equal(authorizationContractResponse.status, 200)
  assert.match(
    await authorizationContractResponse.text(),
    /function parseFeishuAuthorizationSnapshot/u,
  )

  const recoveryContractResponse = await request(`${running.url}/feishu-oauth-recovery-contract.js`)
  assert.equal(recoveryContractResponse.status, 200)
  assert.match(await recoveryContractResponse.text(), /function parseFeishuOAuthRecoverySnapshot/u)

  const reauthorizationContractResponse = await request(
    `${running.url}/feishu-reauthorization-contract.js`,
  )
  assert.equal(reauthorizationContractResponse.status, 200)
  assert.match(
    await reauthorizationContractResponse.text(),
    /function parseFeishuReauthorizationSnapshot/u,
  )

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
  assert.equal(audit.items.length, 6)
  assert.equal(
    audit.items.every(
      (/** @type {{ actorLabel: string, referenceKinds: string[] }} */ item) =>
        (item.actorLabel === 'TwinDesk' || item.actorLabel === 'Persona') &&
        item.referenceKinds.includes('work_item') &&
        !Object.hasOwn(item, 'details') &&
        !Object.hasOwn(item, 'id'),
    ),
    true,
  )
  assert.equal(
    audit.items.filter(
      (/** @type {{ category: string, actorLabel: string, referenceKinds: string[] }} */ item) =>
        item.category === 'draft' &&
        item.actorLabel === 'Persona' &&
        item.referenceKinds.includes('draft'),
    ).length,
    2,
  )
  const headAudit = await request(`${running.url}/api/audit`, { method: 'HEAD' })
  assert.equal(headAudit.status, 200)
  assert.equal(await headAudit.text(), '')
  assert.equal((await request(`${running.url}/api/audit?extra=true`)).status, 400)

  const settingsResponse = await request(`${running.url}/api/settings/feishu`)
  assert.equal(settingsResponse.status, 200)
  assert.match(settingsResponse.headers.get('content-type') ?? '', /^application\/json/u)
  assert.equal(settingsResponse.headers.get('x-twindesk-settings-writable'), 'false')
  assert.equal(settingsResponse.headers.get('x-twindesk-csrf-token'), null)
  assert.deepEqual(await settingsResponse.json(), FEISHU_SETTINGS)
  const settingsBody = JSON.stringify(FEISHU_SETTINGS)
  assert.doesNotMatch(
    settingsBody,
    /appId|accountId|displayName|principalId|credentialReference|secret_reference|filePath/u,
  )
  const headSettings = await request(`${running.url}/api/settings/feishu`, { method: 'HEAD' })
  assert.equal(headSettings.status, 200)
  assert.equal(await headSettings.text(), '')
  assert.equal((await request(`${running.url}/api/settings/feishu?extra=true`)).status, 400)

  const postResponse = await request(`${running.url}/health`, { method: 'POST' })
  assert.equal(postResponse.status, 405)
  assert.equal(postResponse.headers.get('allow'), 'GET, HEAD')
  assert.equal((await request(`${running.url}/api/inbox`, { method: 'POST' })).status, 405)
  assert.equal((await request(`${running.url}/api/audit`, { method: 'POST' })).status, 405)
  assert.equal(
    (await request(`${running.url}/api/settings/feishu`, { method: 'POST' })).status,
    403,
  )
  const putSettings = await request(`${running.url}/api/settings/feishu`, { method: 'PUT' })
  assert.equal(putSettings.status, 405)
  assert.equal(putSettings.headers.get('allow'), 'GET, HEAD, POST')
  assert.equal((await request(`${running.url}/unknown`)).status, 404)

  const port = running.port
  await running.close()
  await running.close()
  const restarted = await startTwinDeskWebServer({
    databasePath,
    feishuSettings: feishuSettingsReader,
    port,
  })
  try {
    assert.equal((await request(`${restarted.url}/inbox`)).status, 200)
    const restartedInbox = await request(`${restarted.url}/api/inbox`)
    assert.deepEqual((await restartedInbox.json()).counts, inbox.counts)
  } finally {
    await restarted.close()
  }
})

test('the Web server accepts one bounded same-origin CSRF-bound OAuth Settings update', async () => {
  let updateCalls = 0
  /** @type {unknown} */
  let observedUpdate
  const updated = {
    ...FEISHU_SETTINGS,
    oauth: {
      redirectHost: '::1',
      redirectPort: 43123,
      scopes: ['im:message:readonly', 'offline_access'],
      appMatchesIdentity: true,
    },
  }
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuSettings: {
      async read() {
        return FEISHU_SETTINGS
      },
      async updateOAuth(value) {
        updateCalls += 1
        observedUpdate = value
        return updated
      },
    },
  })
  try {
    const status = await request(`${running.url}/api/settings/feishu`)
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.equal(status.headers.get('x-twindesk-settings-writable'), 'true')
    assert.ok(csrfToken !== null)
    const update = {
      version: 1,
      redirectHost: '::1',
      redirectPort: 43123,
      scopes: ['im:message:readonly', 'offline_access'],
    }
    const response = await request(`${running.url}/api/settings/feishu`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify(update),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), updated)
    assert.deepEqual(observedUpdate, update)
    assert.equal(Object.isFrozen(observedUpdate), true)
    assert.equal(updateCalls, 1)

    const validHeaders = {
      'content-type': 'application/json',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-csrf-token': csrfToken,
    }
    for (const [url, init, expectedStatus] of [
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: { ...validHeaders, origin: 'http://example.invalid' },
          body: JSON.stringify(update),
        },
        403,
      ],
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: { ...validHeaders, 'x-twindesk-csrf-token': 'wrong' },
          body: JSON.stringify(update),
        },
        403,
      ],
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: { ...validHeaders, 'sec-fetch-site': 'cross-site' },
          body: JSON.stringify(update),
        },
        403,
      ],
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: { ...validHeaders, 'content-type': 'text/plain' },
          body: JSON.stringify(update),
        },
        415,
      ],
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: validHeaders,
          body: JSON.stringify({ ...update, scopes: ['offline_access', 'im:message:readonly'] }),
        },
        400,
      ],
      [
        `${running.url}/api/settings/feishu?extra=true`,
        { method: 'POST', headers: validHeaders, body: JSON.stringify(update) },
        400,
      ],
      [
        `${running.url}/api/settings/feishu`,
        { method: 'POST', headers: validHeaders, body: '{' },
        400,
      ],
      [
        `${running.url}/api/settings/feishu`,
        { method: 'POST', headers: validHeaders, body: new Uint8Array([0xff]) },
        400,
      ],
      [
        `${running.url}/api/settings/feishu`,
        {
          method: 'POST',
          headers: validHeaders,
          body: JSON.stringify({ ...update, padding: 'x'.repeat(17_000) }),
        },
        413,
      ],
    ]) {
      assert.equal(
        (await request(/** @type {string} */ (url), /** @type {RequestInit} */ (init))).status,
        expectedStatus,
      )
    }
    assert.equal(
      await rawPostStatus(
        `${running.url}/api/settings/feishu`,
        { ...validHeaders, host: 'example.invalid' },
        JSON.stringify(update),
      ),
      403,
    )
    assert.equal(updateCalls, 1)
  } finally {
    await running.close()
  }
})

test('the Web server exposes create-only User identity capability without a credential field', async () => {
  let createCalls = 0
  /** @type {unknown} */
  let observedCreate
  const created = {
    version: 1,
    connectorId: 'feishu',
    state: 'incomplete',
    identities: ['user'],
    oauth: null,
  }
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuSettings: {
      async read() {
        return EMPTY_FEISHU_SETTINGS
      },
      async createUserIdentity(value) {
        createCalls += 1
        observedCreate = value
        return created
      },
    },
  })
  try {
    const status = await request(`${running.url}/api/settings/feishu`)
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.equal(status.headers.get('x-twindesk-settings-writable'), 'false')
    assert.equal(status.headers.get('x-twindesk-user-identity-creation'), 'new')
    assert.ok(csrfToken !== null)
    const create = {
      version: 1,
      connection: 'new',
      appId: 'cli_synthetic_web_identity',
      displayName: 'Synthetic Web Identity',
      principalId: 'ou_synthetic_web_identity',
    }
    const response = await request(`${running.url}/api/settings/feishu/user-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify(create),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), created)
    assert.deepEqual(observedCreate, create)
    assert.equal(Object.isFrozen(observedCreate), true)
    assert.equal(response.headers.get('x-twindesk-user-identity-creation'), null)
    assert.equal(response.headers.get('x-twindesk-csrf-token'), null)
    assert.equal(createCalls, 1)

    const rejected = await request(`${running.url}/api/settings/feishu/user-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://example.invalid',
        'sec-fetch-site': 'cross-site',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({ ...create, accessToken: 'synthetic-secret' }),
    })
    assert.equal(rejected.status, 403)
    assert.equal(createCalls, 1)

    const malformed = await request(`${running.url}/api/settings/feishu/user-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({ ...create, accessToken: 'synthetic-secret' }),
    })
    assert.equal(malformed.status, 400)
    assert.equal(createCalls, 1)
  } finally {
    await running.close()
  }
})

test('the Web server rejects stale post-mutation Settings presentations', async () => {
  const cases = [
    {
      path: '/api/settings/feishu',
      service: {
        async read() {
          return FEISHU_SETTINGS
        },
        async updateOAuth() {
          return FEISHU_SETTINGS
        },
      },
      body: {
        version: 1,
        redirectHost: '::1',
        redirectPort: 43123,
        scopes: ['im:message:readonly', 'offline_access'],
      },
    },
    {
      path: '/api/settings/feishu/user-identity',
      service: {
        async read() {
          return EMPTY_FEISHU_SETTINGS
        },
        async createUserIdentity() {
          return EMPTY_FEISHU_SETTINGS
        },
      },
      body: {
        version: 1,
        connection: 'new',
        appId: 'cli_synthetic_stale_identity',
        displayName: 'Synthetic Stale Identity',
        principalId: 'ou_synthetic_stale_identity',
      },
    },
  ]
  for (const item of cases) {
    const running = await startTwinDeskWebServer({ port: 0, feishuSettings: item.service })
    try {
      const status = await request(`${running.url}/api/settings/feishu`)
      const csrfToken = status.headers.get('x-twindesk-csrf-token')
      assert.ok(csrfToken !== null)
      const response = await request(`${running.url}${item.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: running.url,
          'sec-fetch-site': 'same-origin',
          'x-twindesk-csrf-token': csrfToken,
        },
        body: JSON.stringify(item.body),
      })
      assert.equal(response.status, 503)
      assert.equal(await response.text(), 'Feishu Settings unavailable.\n')
    } finally {
      await running.close()
    }
  }
})

test('the Web server does not expose OAuth Settings writer failures', async () => {
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuSettings: {
      async read() {
        return FEISHU_SETTINGS
      },
      async updateOAuth() {
        throw new Error('synthetic-private-writer-failure')
      },
    },
  })
  try {
    const status = await request(`${running.url}/api/settings/feishu`)
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.ok(csrfToken !== null)
    const response = await request(`${running.url}/api/settings/feishu`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        version: 1,
        redirectHost: '127.0.0.1',
        redirectPort: 43123,
        scopes: ['offline_access'],
      }),
    })
    assert.equal(response.status, 503)
    assert.equal(await response.text(), 'Feishu Settings unavailable.\n')
  } finally {
    await running.close()
  }
})

test('the Web server fails closed when Feishu Settings are unavailable or invalid', async () => {
  for (const feishuSettings of [
    undefined,
    {
      async read() {
        throw new Error('synthetic-private-reader-failure')
      },
    },
    {
      async read() {
        return { ...FEISHU_SETTINGS, appId: 'synthetic-private-app-id' }
      },
    },
  ]) {
    const running = await startTwinDeskWebServer(
      feishuSettings === undefined ? { port: 0 } : { feishuSettings, port: 0 },
    )
    try {
      const response = await request(`${running.url}/api/settings/feishu`)
      assert.equal(response.status, 503)
      assert.equal(await response.text(), 'Feishu Settings unavailable.\n')
      const head = await request(`${running.url}/api/settings/feishu`, { method: 'HEAD' })
      assert.equal(head.status, 503)
      assert.equal(await head.text(), '')
    } finally {
      await running.close()
    }
  }
})

test('the Web server starts and cancels one bounded CSRF-bound Feishu authorization', async () => {
  let startCalls = 0
  let cancelCalls = 0
  /** @type {Uint8Array | undefined} */
  let observedSecret
  /** @type {unknown} */
  let state = Object.freeze({ version: 1, connectorId: 'feishu', state: 'idle' })
  const waiting = Object.freeze({
    version: 1,
    connectorId: 'feishu',
    state: 'waiting',
    authorizationUrl: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent('http://127.0.0.1:43121/oauth/callback')}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`,
    redirectUri: 'http://127.0.0.1:43121/oauth/callback',
  })
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuOAuthRecovery: feishuOAuthRecoveryReady,
    feishuAuthorization: {
      read() {
        return state
      },
      async start(secret) {
        startCalls += 1
        observedSecret = secret
        assert.equal(Buffer.from(secret).toString('utf8'), 'synthetic-app-secret')
        state = waiting
        return state
      },
      async cancel() {
        cancelCalls += 1
        state = Object.freeze({ version: 1, connectorId: 'feishu', state: 'cancelled' })
        return state
      },
    },
  })
  try {
    const status = await request(`${running.url}/api/authorization/feishu`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'idle',
    })
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.ok(csrfToken !== null)
    const validHeaders = {
      'content-type': 'application/octet-stream',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-csrf-token': csrfToken,
    }
    /** @type {Array<[Record<string, string>, string, number]>} */
    const rejectedRequests = [
      [{ ...validHeaders, origin: 'http://example.invalid' }, 'synthetic-app-secret', 403],
      [{ ...validHeaders, 'x-twindesk-csrf-token': 'wrong' }, 'synthetic-app-secret', 403],
      [{ ...validHeaders, 'content-type': 'text/plain' }, 'synthetic-app-secret', 415],
      [validHeaders, 'x'.repeat(513), 413],
    ]
    for (const [headers, body, expectedStatus] of rejectedRequests) {
      const response = await request(`${running.url}/api/authorization/feishu/start`, {
        method: 'POST',
        headers,
        body,
      })
      assert.equal(response.status, expectedStatus)
    }
    assert.equal(startCalls, 0)

    const started = await request(`${running.url}/api/authorization/feishu/start`, {
      method: 'POST',
      headers: validHeaders,
      body: 'synthetic-app-secret',
    })
    assert.equal(started.status, 200)
    assert.deepEqual(await started.json(), waiting)
    assert.equal(startCalls, 1)
    assert.ok(observedSecret !== undefined)
    assert.equal(
      observedSecret.every((value) => value === 0),
      true,
    )

    const cancelled = await request(`${running.url}/api/authorization/feishu/cancel`, {
      method: 'POST',
      headers: {
        ...validHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version: 1 }),
    })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(await cancelled.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'cancelled',
    })
    assert.equal(cancelCalls, 1)
  } finally {
    await running.close()
  }
  assert.equal(cancelCalls, 2)
})

test('the Web server minimizes authorization conflicts and invalid service results', async () => {
  /** @type {Array<[(secret: Uint8Array) => Promise<unknown>, number]>} */
  const invalidStarts = [
    [async () => Promise.reject(new Error('synthetic-private-active')), 409],
    [async () => ({ version: 1, connectorId: 'feishu', state: 'idle' }), 503],
    [
      async () => ({
        version: 1,
        connectorId: 'feishu',
        state: 'waiting',
        authorizationUrl: 'https://example.invalid/steal',
        redirectUri: 'http://127.0.0.1:43121/oauth/callback',
      }),
      503,
    ],
  ]
  for (const [start, expectedStatus] of invalidStarts) {
    const running = await startTwinDeskWebServer({
      port: 0,
      feishuOAuthRecovery: feishuOAuthRecoveryReady,
      feishuAuthorization: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'idle' }
        },
        start,
        async cancel() {
          return { version: 1, connectorId: 'feishu', state: 'cancelled' }
        },
      },
    })
    try {
      const status = await request(`${running.url}/api/authorization/feishu`)
      const csrfToken = status.headers.get('x-twindesk-csrf-token')
      assert.ok(csrfToken !== null)
      const response = await request(`${running.url}/api/authorization/feishu/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: running.url,
          'sec-fetch-site': 'same-origin',
          'x-twindesk-csrf-token': csrfToken,
        },
        body: 'synthetic-app-secret',
      })
      assert.equal(response.status, expectedStatus)
      assert.doesNotMatch(await response.text(), /synthetic-private/u)
    } finally {
      await running.close()
    }
  }
})

test('the authorization start endpoint enforces recovery state before invoking the Host', async () => {
  let startCalls = 0
  const cases = [
    {
      recovery: undefined,
      status: 503,
    },
    {
      recovery: {
        read() {
          return {
            version: 1,
            connectorId: 'feishu',
            state: 'reconciliation_required',
          }
        },
      },
      status: 409,
    },
    {
      recovery: {
        read() {
          throw new Error('synthetic-private-recovery-gate')
        },
      },
      status: 503,
    },
  ]
  for (const entry of cases) {
    const running = await startTwinDeskWebServer({
      port: 0,
      ...(entry.recovery === undefined ? {} : { feishuOAuthRecovery: entry.recovery }),
      feishuAuthorization: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'idle' }
        },
        async start() {
          startCalls += 1
          return { version: 1, connectorId: 'feishu', state: 'succeeded' }
        },
        async cancel() {
          return { version: 1, connectorId: 'feishu', state: 'cancelled' }
        },
      },
    })
    try {
      const status = await request(`${running.url}/api/authorization/feishu`)
      const csrfToken = status.headers.get('x-twindesk-csrf-token')
      assert.ok(csrfToken !== null)
      const response = await request(`${running.url}/api/authorization/feishu/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: running.url,
          'sec-fetch-site': 'same-origin',
          'x-twindesk-csrf-token': csrfToken,
        },
        body: 'synthetic-app-secret',
      })
      assert.equal(response.status, entry.status)
      assert.doesNotMatch(await response.text(), /synthetic-private/u)
    } finally {
      await running.close()
    }
  }
  assert.equal(startCalls, 0)
})

test('the Web server starts and cancels one recovery-gated Feishu reauthorization', async () => {
  let startCalls = 0
  let cancelCalls = 0
  /** @type {Uint8Array | undefined} */
  let observedSecret
  /** @type {unknown} */
  let state = Object.freeze({ version: 1, connectorId: 'feishu', state: 'idle' })
  const waiting = Object.freeze({
    version: 1,
    connectorId: 'feishu',
    state: 'waiting',
    authorizationUrl: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_synthetic&response_type=code&redirect_uri=${encodeURIComponent('http://127.0.0.1:43121/oauth/callback')}&scope=offline_access&state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&prompt=consent`,
    redirectUri: 'http://127.0.0.1:43121/oauth/callback',
  })
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuOAuthRecovery: {
      read() {
        return { version: 1, connectorId: 'feishu', state: 'reauthorization_required' }
      },
    },
    feishuAuthorization: {
      read() {
        return { version: 1, connectorId: 'feishu', state: 'idle' }
      },
      async start() {
        return { version: 1, connectorId: 'feishu', state: 'succeeded' }
      },
      async cancel() {
        return { version: 1, connectorId: 'feishu', state: 'cancelled' }
      },
    },
    feishuReauthorization: {
      read() {
        return state
      },
      async start(secret) {
        startCalls += 1
        observedSecret = secret
        assert.equal(Buffer.from(secret).toString('utf8'), 'synthetic-reauthorization-secret')
        state = waiting
        return state
      },
      async cancel() {
        cancelCalls += 1
        state = Object.freeze({ version: 1, connectorId: 'feishu', state: 'cancelled' })
        return state
      },
    },
  })
  try {
    const status = await request(`${running.url}/api/reauthorization/feishu`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'idle',
    })
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.ok(csrfToken !== null)
    const authorization = await request(`${running.url}/api/authorization/feishu`)
    assert.equal(authorization.status, 200)
    const authorizationCsrfToken = authorization.headers.get('x-twindesk-csrf-token')
    assert.ok(authorizationCsrfToken !== null)
    assert.notEqual(csrfToken, authorizationCsrfToken)
    const headers = {
      'content-type': 'application/octet-stream',
      origin: running.url,
      'sec-fetch-site': 'same-origin',
      'x-twindesk-csrf-token': csrfToken,
    }
    /** @type {Array<[Record<string, string>, string, number]>} */
    const rejectedRequests = [
      [{ ...headers, 'x-twindesk-csrf-token': authorizationCsrfToken }, 'secret', 403],
      [{ ...headers, origin: 'http://example.invalid' }, 'secret', 403],
      [{ ...headers, 'content-type': 'text/plain' }, 'secret', 415],
      [headers, 'x'.repeat(513), 413],
    ]
    for (const [rejectedHeaders, body, expectedStatus] of rejectedRequests) {
      const rejected = await request(`${running.url}/api/reauthorization/feishu/start`, {
        method: 'POST',
        headers: rejectedHeaders,
        body,
      })
      assert.equal(rejected.status, expectedStatus)
    }
    assert.equal(startCalls, 0)
    const started = await request(`${running.url}/api/reauthorization/feishu/start`, {
      method: 'POST',
      headers,
      body: 'synthetic-reauthorization-secret',
    })
    assert.equal(started.status, 200)
    assert.deepEqual(await started.json(), waiting)
    assert.equal(startCalls, 1)
    assert.ok(observedSecret !== undefined)
    assert.equal(
      observedSecret.every((value) => value === 0),
      true,
    )

    const cancelled = await request(`${running.url}/api/reauthorization/feishu/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(await cancelled.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'cancelled',
    })
    assert.equal(cancelCalls, 1)
  } finally {
    await running.close()
  }
  assert.equal(cancelCalls, 2)
})

test('the reauthorization start endpoint enforces exact durable recovery state first', async () => {
  let startCalls = 0
  for (const entry of [
    { recovery: undefined, status: 503 },
    {
      recovery: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'ready' }
        },
      },
      status: 409,
    },
    {
      recovery: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'reconciliation_required' }
        },
      },
      status: 409,
    },
    {
      recovery: {
        read() {
          throw new Error('synthetic-private-recovery-gate')
        },
      },
      status: 503,
    },
  ]) {
    const running = await startTwinDeskWebServer({
      port: 0,
      ...(entry.recovery === undefined ? {} : { feishuOAuthRecovery: entry.recovery }),
      feishuReauthorization: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'idle' }
        },
        async start() {
          startCalls += 1
          return { version: 1, connectorId: 'feishu', state: 'succeeded' }
        },
        async cancel() {
          return { version: 1, connectorId: 'feishu', state: 'cancelled' }
        },
      },
    })
    try {
      const status = await request(`${running.url}/api/reauthorization/feishu`)
      const csrfToken = status.headers.get('x-twindesk-csrf-token')
      assert.ok(csrfToken !== null)
      const response = await request(`${running.url}/api/reauthorization/feishu/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: running.url,
          'sec-fetch-site': 'same-origin',
          'x-twindesk-csrf-token': csrfToken,
        },
        body: 'synthetic-app-secret',
      })
      assert.equal(response.status, entry.status)
      assert.doesNotMatch(await response.text(), /synthetic-private/u)
    } finally {
      await running.close()
    }
  }
  assert.equal(startCalls, 0)
})

test('the Web server minimizes invalid reauthorization services and results', async () => {
  for (const start of [
    async () => Promise.reject(new Error('synthetic-private-active')),
    async () => ({ version: 1, connectorId: 'feishu', state: 'idle' }),
    async () => ({
      version: 1,
      connectorId: 'feishu',
      state: 'waiting',
      authorizationUrl: 'https://example.invalid/steal',
      redirectUri: 'http://127.0.0.1:43121/oauth/callback',
    }),
  ]) {
    const running = await startTwinDeskWebServer({
      port: 0,
      feishuOAuthRecovery: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'reauthorization_required' }
        },
      },
      feishuReauthorization: {
        read() {
          return { version: 1, connectorId: 'feishu', state: 'idle' }
        },
        start,
        async cancel() {
          return { version: 1, connectorId: 'feishu', state: 'cancelled' }
        },
      },
    })
    try {
      const status = await request(`${running.url}/api/reauthorization/feishu`)
      const csrfToken = status.headers.get('x-twindesk-csrf-token')
      assert.ok(csrfToken !== null)
      const response = await request(`${running.url}/api/reauthorization/feishu/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: running.url,
          'sec-fetch-site': 'same-origin',
          'x-twindesk-csrf-token': csrfToken,
        },
        body: 'synthetic-app-secret',
      })
      assert.ok(response.status === 409 || response.status === 503)
      assert.doesNotMatch(await response.text(), /synthetic-private|example\.invalid/u)
    } finally {
      await running.close()
    }
  }

  let getterCalls = 0
  const hostile = Object.defineProperty({ start() {}, cancel() {} }, 'read', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-reauthorization-service')
    },
  })
  await assert.rejects(
    startTwinDeskWebServer({
      port: 0,
      feishuReauthorization: /** @type {never} */ (hostile),
    }),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
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

test('the Web server rejects hostile Feishu Settings services without invoking accessors', async () => {
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'read', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-service-value')
    },
  })
  await assert.rejects(
    startTwinDeskWebServer({
      port: 0,
      feishuSettings: /** @type {never} */ (hostile),
    }),
    (error) =>
      error instanceof TypeError &&
      /service is invalid/u.test(error.message) &&
      !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})

test('the Web server rejects hostile authorization services without invoking accessors', async () => {
  let getterCalls = 0
  const hostile = Object.defineProperty(
    {
      start() {},
      cancel() {},
    },
    'read',
    {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('synthetic-private-authorization-service')
      },
    },
  )
  await assert.rejects(
    startTwinDeskWebServer({
      port: 0,
      feishuAuthorization: /** @type {never} */ (hostile),
    }),
    (error) =>
      error instanceof TypeError &&
      /service is invalid/u.test(error.message) &&
      !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})

test('the Web server still closes when authorization cancellation throws synchronously', async () => {
  const running = await startTwinDeskWebServer({
    port: 0,
    feishuAuthorization: {
      read() {
        return { version: 1, connectorId: 'feishu', state: 'idle' }
      },
      async start() {
        return { version: 1, connectorId: 'feishu', state: 'failed', recovery: 'do_not_retry' }
      },
      cancel() {
        throw new Error('synthetic-private-cancel-failure')
      },
    },
  })
  await running.close()
  await running.close()
})

test('the Web server exposes only minimized read-only Feishu OAuth recovery state', async (context) => {
  const databasePath = await temporaryDatabase(context)
  const running = await startTwinDeskWebServer({
    databasePath,
    port: 0,
    feishuOAuthRecovery: {
      read() {
        return {
          version: 1,
          connectorId: 'feishu',
          state: 'reconciliation_required',
        }
      },
    },
  })
  context.after(() => running.close())

  const response = await request(`${running.url}/api/recovery/feishu/oauth`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    version: 1,
    connectorId: 'feishu',
    state: 'reconciliation_required',
  })
  const head = await request(`${running.url}/api/recovery/feishu/oauth`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal((await request(`${running.url}/api/recovery/feishu/oauth?full=true`)).status, 400)
  const mutation = await request(`${running.url}/api/recovery/feishu/oauth`, { method: 'POST' })
  assert.equal(mutation.status, 405)
})

test('the Web server fails closed for unavailable, invalid, or hostile recovery services', async () => {
  for (const service of [
    undefined,
    {
      read() {
        return {
          version: 1,
          connectorId: 'feishu',
          state: 'ready',
          sequence: 1,
        }
      },
    },
    {
      read() {
        throw new Error('synthetic-private-recovery-read')
      },
    },
  ]) {
    const running = await startTwinDeskWebServer({
      port: 0,
      ...(service === undefined ? {} : { feishuOAuthRecovery: service }),
    })
    try {
      const response = await request(`${running.url}/api/recovery/feishu/oauth`)
      assert.equal(response.status, 503)
      assert.doesNotMatch(await response.text(), /synthetic|sequence/iu)
    } finally {
      await running.close()
    }
  }

  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'read', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-recovery-service')
    },
  })
  await assert.rejects(
    startTwinDeskWebServer({
      port: 0,
      feishuOAuthRecovery: /** @type {never} */ (hostile),
    }),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})
