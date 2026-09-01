import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openWorkbenchFeishuSettingsStores,
  startWorkbenchWebServer,
} from '../packages/bundle-workbench/dist/index.js'

const IDENTITY = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-web-runtime',
  appId: 'cli_synthetic_web_runtime',
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic Web User',
    principalId: 'ou_synthetic_web_runtime',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-web-runtime',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

test('Workbench hosts default-path Feishu Settings in the product Web shell', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-web-runtime-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  const localPaths = {
    platform: /** @type {const} */ ('darwin'),
    homeDirectory,
  }
  const stores = await openWorkbenchFeishuSettingsStores(localPaths)
  await stores.identityStore.write(IDENTITY)
  await stores.authorizationStore.write({
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: IDENTITY.appId,
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['offline_access', 'im:message:readonly'],
  })

  const databasePath = join(root, 'business', 'twindesk.sqlite3')
  await mkdir(join(root, 'business'), { mode: 0o700 })
  const running = await startWorkbenchWebServer({ ...localPaths, databasePath, port: 0 })
  try {
    const response = await fetch(`${running.url}/api/settings/feishu`, {
      headers: { connection: 'close' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'ready',
      identities: ['user'],
      oauth: {
        redirectHost: '127.0.0.1',
        redirectPort: 43121,
        scopes: ['im:message:readonly', 'offline_access'],
        appMatchesIdentity: true,
      },
    })
    const csrfToken = response.headers.get('x-twindesk-csrf-token')
    assert.ok(csrfToken !== null)
    const updateResponse = await fetch(`${running.url}/api/settings/feishu`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        version: 1,
        redirectHost: '::1',
        redirectPort: 43125,
        scopes: ['im:message:send_as_user', 'offline_access'],
      }),
    })
    assert.equal(updateResponse.status, 200)
    assert.equal((await updateResponse.json()).oauth.redirectPort, 43125)
  } finally {
    await running.close()
  }

  const restartedStores = await openWorkbenchFeishuSettingsStores(localPaths)
  assert.deepEqual(await restartedStores.authorizationStore.read(), {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: IDENTITY.appId,
    redirectUri: 'http://[::1]:43125/oauth/feishu/callback',
    scopes: ['im:message:send_as_user', 'offline_access'],
  })
})

test('Workbench Web composition rejects unknown and hostile options before local access', async () => {
  await assert.rejects(
    startWorkbenchWebServer(/** @type {never} */ ({ port: 0, extra: true })),
    /options are invalid/u,
  )
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'homeDirectory', {
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-hostile-web-value')
    },
  })
  await assert.rejects(
    startWorkbenchWebServer(/** @type {never} */ (hostile)),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(getterCalls, 0)
})

test('Workbench Web bootstraps a User identity from empty Settings and recovers it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-user-bootstrap-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  const localPaths = {
    platform: /** @type {const} */ ('darwin'),
    homeDirectory,
  }
  const running = await startWorkbenchWebServer({ ...localPaths, port: 0 })
  try {
    const status = await fetch(`${running.url}/api/settings/feishu`)
    assert.equal(status.headers.get('x-twindesk-user-identity-creation'), 'new')
    const csrfToken = status.headers.get('x-twindesk-csrf-token')
    assert.ok(csrfToken !== null)
    const response = await fetch(`${running.url}/api/settings/feishu/user-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        version: 1,
        connection: 'new',
        appId: 'cli_synthetic_web_bootstrap',
        displayName: 'Synthetic Bootstrap User',
        principalId: 'ou_synthetic_web_bootstrap',
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'incomplete',
      identities: ['user'],
      oauth: null,
    })
  } finally {
    await running.close()
  }

  const stores = await openWorkbenchFeishuSettingsStores(localPaths)
  const identity = await stores.identityStore.read()
  assert.equal(identity?.appId, 'cli_synthetic_web_bootstrap')
  assert.equal(identity?.user?.principalId, 'ou_synthetic_web_bootstrap')
  assert.match(identity?.accountId ?? '', /^feishu-account:[a-f0-9-]{36}$/u)
  assert.match(
    identity?.user?.credentialReference.id ?? '',
    /^secret-ref:feishu-user-oauth-[a-f0-9-]{36}$/u,
  )

  const restarted = await startWorkbenchWebServer({ ...localPaths, port: 0 })
  try {
    const status = await fetch(`${restarted.url}/api/settings/feishu`)
    assert.equal(status.headers.get('x-twindesk-user-identity-creation'), null)
    assert.deepEqual((await status.json()).identities, ['user'])
  } finally {
    await restarted.close()
  }
})
