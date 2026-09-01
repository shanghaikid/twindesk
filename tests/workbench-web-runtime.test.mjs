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
  } finally {
    await running.close()
  }
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
