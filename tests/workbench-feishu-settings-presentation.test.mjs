import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createWorkbenchFeishuSettingsPresentation,
  openWorkbenchFeishuSettingsStores,
} from '../packages/bundle-workbench/dist/index.js'

const APP_ID = 'cli_synthetic_settings_presentation'
const IDENTITY = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:settings-presentation',
  appId: APP_ID,
  bot: Object.freeze({
    identityType: 'bot',
    displayName: 'Synthetic Bot',
    principalId: 'bot:synthetic-settings-presentation',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-settings-bot',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    }),
  }),
  user: Object.freeze({
    identityType: 'user',
    displayName: 'Synthetic User',
    principalId: 'ou_synthetic_settings_presentation',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-settings-user',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function settingsStores(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-settings-presentation-${suffix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  const options = {
    platform: /** @type {const} */ ('darwin'),
    homeDirectory,
  }
  return { options, stores: await openWorkbenchFeishuSettingsStores(options) }
}

/** @param {Awaited<ReturnType<typeof openWorkbenchFeishuSettingsStores>>} stores */
function presentation(stores) {
  return createWorkbenchFeishuSettingsPresentation({
    identityStore: stores.identityStore,
    authorizationStore: stores.authorizationStore,
  })
}

test('Workbench presents canonical minimized Feishu Settings across restart', async (context) => {
  const fixture = await settingsStores(context, 'restart')
  const initial = presentation(fixture.stores)
  assert.deepEqual(await initial.read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'not_configured',
    identities: [],
    oauth: null,
  })

  await fixture.stores.identityStore.write(IDENTITY)
  assert.deepEqual(await initial.read(), {
    version: 1,
    connectorId: 'feishu',
    state: 'incomplete',
    identities: ['bot', 'user'],
    oauth: null,
  })

  await fixture.stores.authorizationStore.write({
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: APP_ID,
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['offline_access', 'im:message:readonly'],
  })
  const restartedStores = await openWorkbenchFeishuSettingsStores(fixture.options)
  const snapshot = await presentation(restartedStores).read()
  assert.deepEqual(snapshot, {
    version: 1,
    connectorId: 'feishu',
    state: 'ready',
    identities: ['bot', 'user'],
    oauth: {
      redirectHost: '127.0.0.1',
      redirectPort: 43121,
      scopes: ['im:message:readonly', 'offline_access'],
      appMatchesIdentity: true,
    },
  })
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.identities), true)
  assert.equal(Object.isFrozen(snapshot.oauth), true)
  assert.equal(Object.isFrozen(snapshot.oauth?.scopes), true)

  const serialized = JSON.stringify(snapshot)
  for (const privateValue of [
    APP_ID,
    IDENTITY.accountId,
    IDENTITY.bot.displayName,
    IDENTITY.bot.principalId,
    IDENTITY.bot.credentialReference.id,
    IDENTITY.user.displayName,
    IDENTITY.user.principalId,
    IDENTITY.user.credentialReference.id,
    fixture.stores.paths.rootDirectory,
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
  assert.doesNotMatch(
    serialized,
    /appId|accountId|displayName|principalId|credentialReference|secret_reference|filePath/u,
  )
})

test('Workbench reports app mismatch as incomplete without exposing either app', async (context) => {
  const fixture = await settingsStores(context, 'mismatch')
  await fixture.stores.identityStore.write(IDENTITY)
  await fixture.stores.authorizationStore.write({
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: 'cli_synthetic_other_app',
    redirectUri: 'http://[::1]:43122/oauth/feishu/callback',
    scopes: ['offline_access'],
  })
  const snapshot = await presentation(fixture.stores).read()
  assert.equal(snapshot.state, 'incomplete')
  assert.deepEqual(snapshot.identities, ['bot', 'user'])
  assert.deepEqual(snapshot.oauth, {
    redirectHost: '::1',
    redirectPort: 43122,
    scopes: ['offline_access'],
    appMatchesIdentity: false,
  })
  assert.doesNotMatch(JSON.stringify(snapshot), /cli_synthetic/u)
})

test('Workbench Settings presentation rejects hostile collaborators and keeps read errors payload-free', async (context) => {
  const fixture = await settingsStores(context, 'invalid')
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'identityStore', {
    get() {
      getterCalls += 1
      throw new Error('synthetic-hostile-settings-value')
    },
  })
  assert.throws(
    () => createWorkbenchFeishuSettingsPresentation(/** @type {never} */ (hostile)),
    (error) =>
      error instanceof TypeError && !error.message.includes('synthetic-hostile-settings-value'),
  )
  assert.equal(getterCalls, 0)
  assert.throws(
    () =>
      createWorkbenchFeishuSettingsPresentation(
        /** @type {never} */ ({
          identityStore: { read: async () => undefined },
          authorizationStore: fixture.stores.authorizationStore,
        }),
      ),
    TypeError,
  )

  const privatePayload = 'synthetic-private-corrupt-settings-payload'
  await writeFile(fixture.stores.paths.feishuIdentityConfiguration, privatePayload, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await assert.rejects(
    presentation(fixture.stores).read(),
    (error) => error instanceof Error && !error.message.includes(privatePayload),
  )
})
