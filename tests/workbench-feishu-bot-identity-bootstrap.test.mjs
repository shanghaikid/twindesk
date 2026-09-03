import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkbenchFeishuBotIdentityBootstrapper } from '../packages/bundle-workbench/dist/index.js'
import { FeishuIdentityConfigurationStore } from '../packages/plugin-feishu/dist/index.js'

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function fixture(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-bot-bootstrap-${suffix}-`))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'identity.v1.json')
  return { path, store: new FeishuIdentityConfigurationStore(path) }
}

const NEW_BOT = Object.freeze({
  version: 1,
  connection: 'new',
  appId: 'cli_synthetic_bot_bootstrap',
  displayName: 'Synthetic Local Bot',
  principalId: 'ou_synthetic_bot_bootstrap',
})

test('Workbench creates one credential-free Bot identity and recovers it after restart', async (context) => {
  const { path, store } = await fixture(context, 'new')
  const bootstrapper = createWorkbenchFeishuBotIdentityBootstrapper({ identityStore: store })
  await bootstrapper.create(NEW_BOT)

  const created = await new FeishuIdentityConfigurationStore(path).read()
  assert.equal(created?.appId, NEW_BOT.appId)
  assert.equal(created?.bot?.displayName, NEW_BOT.displayName)
  assert.equal(created?.bot?.principalId, NEW_BOT.principalId)
  assert.match(created?.accountId ?? '', /^feishu-account:[a-f0-9-]{36}$/u)
  assert.match(
    created?.bot?.credentialReference.id ?? '',
    /^secret-ref:feishu-bot-app-[a-f0-9-]{36}$/u,
  )
  assert.equal(created?.bot?.credentialReference.store, 'system_keychain')
  assert.equal(created?.bot?.credentialReference.purpose, 'connector_app_credential')

  const document = await readFile(path, 'utf8')
  assert.doesNotMatch(document, /accessToken|refreshToken|clientSecret|appSecret|privateKey/u)
  await assert.rejects(bootstrapper.create(NEW_BOT), /creation is invalid/u)
  assert.deepEqual(await new FeishuIdentityConfigurationStore(path).read(), created)
})

test('Workbench adds a Bot to an existing User connection without replacing User metadata', async (context) => {
  const { store } = await fixture(context, 'existing')
  const user = {
    identityType: 'user',
    displayName: 'Synthetic User',
    principalId: 'ou_synthetic_user',
    credentialReference: {
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-bootstrap-user',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    },
  }
  const existing = await store.write({
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:synthetic-bot-bootstrap-existing',
    appId: 'cli_synthetic_existing_app',
    user,
  })
  const bootstrapper = createWorkbenchFeishuBotIdentityBootstrapper({ identityStore: store })
  await bootstrapper.create({
    version: 1,
    connection: 'existing',
    appId: null,
    displayName: 'Synthetic Added Bot',
    principalId: 'ou_synthetic_added_bot',
  })

  const created = await store.read()
  assert.equal(created?.accountId, existing.accountId)
  assert.equal(created?.appId, existing.appId)
  assert.deepEqual(created?.user, existing.user)
  assert.equal(created?.bot?.principalId, 'ou_synthetic_added_bot')
})

test('Workbench serializes competing Bot creation and rejects secret or hostile input', async (context) => {
  const { store } = await fixture(context, 'hostile')
  const bootstrapper = createWorkbenchFeishuBotIdentityBootstrapper({ identityStore: store })
  let getterCalls = 0
  const hostile = Object.defineProperty({ ...NEW_BOT }, 'principalId', {
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
    bootstrapper.create({ ...NEW_BOT, displayName: 'Synthetic First Bot' }),
    bootstrapper.create({ ...NEW_BOT, displayName: 'Synthetic Second Bot' }),
  ])
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
  assert.match((await store.read())?.bot?.displayName ?? '', /^Synthetic (First|Second) Bot$/u)

  for (const invalid of [
    { ...NEW_BOT, connection: 'existing', appId: NEW_BOT.appId },
    { ...NEW_BOT, appId: null },
    { ...NEW_BOT, appSecret: 'synthetic-secret-that-must-not-echo' },
  ]) {
    await assert.rejects(
      createWorkbenchFeishuBotIdentityBootstrapper({
        identityStore: new FeishuIdentityConfigurationStore(join(tmpdir(), 'unused-synthetic')),
      }).create(invalid),
      (error) => error instanceof TypeError && !error.message.includes('synthetic-secret'),
    )
  }
})
