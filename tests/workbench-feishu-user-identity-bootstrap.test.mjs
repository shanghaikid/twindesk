import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuUserIdentityBootstrapper } from '../packages/bundle-workbench/dist/index.js'
import { FeishuIdentityConfigurationStore } from '../packages/plugin-feishu/dist/index.js'

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function fixture(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-user-bootstrap-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'identity.v1.json')
  const store = new FeishuIdentityConfigurationStore(path)
  return { path, store }
}

const NEW_USER = Object.freeze({
  version: 1,
  connection: 'new',
  appId: 'cli_synthetic_bootstrap',
  displayName: 'Synthetic Local User',
  principalId: 'ou_synthetic_bootstrap',
})

test('Workbench creates one credential-free User identity and recovers it after restart', async (context) => {
  const { path, store } = await fixture(context, 'new')
  const bootstrapper = createWorkbenchFeishuUserIdentityBootstrapper({ identityStore: store })
  await bootstrapper.create(NEW_USER)

  const created = await new FeishuIdentityConfigurationStore(path).read()
  assert.equal(created?.appId, NEW_USER.appId)
  assert.equal(created?.user?.displayName, NEW_USER.displayName)
  assert.equal(created?.user?.principalId, NEW_USER.principalId)
  assert.match(created?.accountId ?? '', /^feishu-account:[a-f0-9-]{36}$/u)
  assert.match(
    created?.user?.credentialReference.id ?? '',
    /^secret-ref:feishu-user-oauth-[a-f0-9-]{36}$/u,
  )
  assert.equal(created?.user?.credentialReference.store, 'system_keychain')
  assert.equal(created?.user?.credentialReference.purpose, 'connector_oauth')

  const document = await readFile(path, 'utf8')
  assert.doesNotMatch(document, /accessToken|refreshToken|clientSecret|appSecret|privateKey/u)
  await assert.rejects(bootstrapper.create(NEW_USER), /creation is invalid/u)
  assert.deepEqual(await new FeishuIdentityConfigurationStore(path).read(), created)
})

test('Workbench adds a User to an existing Bot connection without replacing Bot metadata', async (context) => {
  const { store } = await fixture(context, 'existing')
  const bot = {
    identityType: 'bot',
    displayName: 'Synthetic Bot',
    principalId: 'ou_synthetic_bot',
    credentialReference: {
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-bootstrap-bot',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    },
  }
  const existing = await store.write({
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-bootstrap-existing',
    appId: 'cli_synthetic_existing_app',
    bot,
  })
  const bootstrapper = createWorkbenchFeishuUserIdentityBootstrapper({ identityStore: store })
  await bootstrapper.create({
    version: 1,
    connection: 'existing',
    appId: null,
    displayName: 'Synthetic Added User',
    principalId: 'ou_synthetic_added_user',
  })
  const created = await store.read()
  assert.equal(created?.accountId, existing.accountId)
  assert.equal(created?.appId, existing.appId)
  assert.deepEqual(created?.bot, existing.bot)
  assert.equal(created?.user?.principalId, 'ou_synthetic_added_user')
})

test('Workbench serializes competing User creation and rejects hostile input without access', async (context) => {
  const { store } = await fixture(context, 'hostile')
  const bootstrapper = createWorkbenchFeishuUserIdentityBootstrapper({ identityStore: store })
  let getterCalls = 0
  const hostile = Object.defineProperty({ ...NEW_USER }, 'principalId', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('synthetic-private-principal')
    },
  })
  await assert.rejects(bootstrapper.create(hostile), (error) => {
    assert.ok(error instanceof TypeError)
    assert.equal(error.message.includes('synthetic-private'), false)
    return true
  })
  assert.equal(getterCalls, 0)
  assert.equal(await store.read(), undefined)

  const results = await Promise.allSettled([
    bootstrapper.create({ ...NEW_USER, displayName: 'Synthetic First User' }),
    bootstrapper.create({ ...NEW_USER, displayName: 'Synthetic Second User' }),
  ])
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
  assert.match((await store.read())?.user?.displayName ?? '', /^Synthetic (First|Second) User$/u)

  for (const invalid of [
    { ...NEW_USER, connection: 'existing', appId: NEW_USER.appId },
    { ...NEW_USER, appId: null },
    { ...NEW_USER, accessToken: 'synthetic-secret-that-must-not-echo' },
  ]) {
    await assert.rejects(
      createWorkbenchFeishuUserIdentityBootstrapper({
        identityStore: new FeishuIdentityConfigurationStore(join(tmpdir(), 'unused-synthetic')),
      }).create(invalid),
      (error) => error instanceof TypeError && !error.message.includes('synthetic-secret'),
    )
  }
})
