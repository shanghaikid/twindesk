import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FEISHU_CONNECTOR_ID,
  FEISHU_IDENTITY_CONFIGURATION_VERSION,
  FeishuIdentityConfigurationError,
  FeishuIdentityConfigurationStore,
  parseFeishuIdentityConfiguration,
  toFeishuActionIdentity,
} from '../packages/plugin-feishu/dist/index.js'

const BOT_SECRET_REFERENCE = Object.freeze({
  kind: 'secret_reference',
  schemaVersion: 1,
  id: 'secret-ref:feishu-bot-app-credential',
  store: 'system_keychain',
  purpose: 'connector_app_credential',
})

const USER_SECRET_REFERENCE = Object.freeze({
  kind: 'secret_reference',
  schemaVersion: 1,
  id: 'secret-ref:feishu-user-oauth',
  store: 'system_keychain',
  purpose: 'connector_oauth',
})

function configuration() {
  return {
    kind: 'feishu_identity_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    accountId: 'feishu-account:primary',
    appId: 'cli_synthetic_twindesk',
    bot: {
      identityType: 'bot',
      displayName: 'TwinDesk Bot',
      principalId: 'bot:synthetic-twindesk',
      credentialReference: { ...BOT_SECRET_REFERENCE },
    },
    user: {
      identityType: 'user',
      displayName: 'Local User',
      principalId: 'user:synthetic-local',
      credentialReference: { ...USER_SECRET_REFERENCE },
    },
  }
}

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryStore(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-feishu-${suffix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  return { root, path: join(root, 'identity-configuration.json') }
}

test('Bot and User identities remain separate and project without credentials', () => {
  const parsed = parseFeishuIdentityConfiguration(configuration())
  assert.equal(FEISHU_IDENTITY_CONFIGURATION_VERSION, 1)
  assert.equal(FEISHU_CONNECTOR_ID, 'feishu')
  assert.equal(parsed.bot?.identityType, 'bot')
  assert.equal(parsed.bot?.credentialReference.purpose, 'connector_app_credential')
  assert.equal(parsed.user?.identityType, 'user')
  assert.equal(parsed.user?.credentialReference.purpose, 'connector_oauth')
  assert.notEqual(parsed.bot?.credentialReference.id, parsed.user?.credentialReference.id)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.bot), true)
  assert.equal(Object.isFrozen(parsed.bot?.credentialReference), true)

  const bot = toFeishuActionIdentity(parsed, 'bot')
  const user = toFeishuActionIdentity(parsed, 'user')
  assert.deepEqual(bot, {
    connectorId: 'feishu',
    accountId: 'feishu-account:primary',
    identityType: 'bot',
    displayName: 'TwinDesk Bot',
  })
  assert.deepEqual(user, {
    connectorId: 'feishu',
    accountId: 'feishu-account:primary',
    identityType: 'user',
    displayName: 'Local User',
  })
  assert.doesNotMatch(JSON.stringify([bot, user]), /secret-ref/u)
})

test('identity configuration rejects mixed credentials and undeclared secret material', () => {
  const secret = 'synthetic-secret-value-that-must-not-persist-or-echo'
  const cases = [
    { ...configuration(), accessToken: secret },
    {
      ...configuration(),
      bot: { ...configuration().bot, identityType: 'user' },
    },
    {
      ...configuration(),
      bot: { ...configuration().bot, credentialReference: { ...USER_SECRET_REFERENCE } },
    },
    {
      ...configuration(),
      user: {
        ...configuration().user,
        credentialReference: { ...USER_SECRET_REFERENCE, id: BOT_SECRET_REFERENCE.id },
      },
    },
    {
      ...configuration(),
      bot: {
        ...configuration().bot,
        credentialReference: { ...BOT_SECRET_REFERENCE, appSecret: secret },
      },
    },
  ]
  for (const value of cases) {
    assert.throws(
      () => parseFeishuIdentityConfiguration(value),
      (error) =>
        error instanceof FeishuIdentityConfigurationError && !error.message.includes(secret),
    )
  }

  let invoked = false
  const hostile = configuration()
  Object.defineProperty(hostile, 'user', {
    enumerable: true,
    get() {
      invoked = true
      return secret
    },
  })
  assert.throws(
    () => parseFeishuIdentityConfiguration(hostile),
    (error) => error instanceof FeishuIdentityConfigurationError,
  )
  assert.equal(invoked, false)

  const hostileProxy = new Proxy(configuration(), {
    getPrototypeOf() {
      throw new Error(secret)
    },
  })
  assert.throws(
    () => parseFeishuIdentityConfiguration(hostileProxy),
    (error) => error instanceof FeishuIdentityConfigurationError && !error.message.includes(secret),
  )
  assert.throws(
    () => toFeishuActionIdentity(configuration(), /** @type {any} */ ('admin')),
    (error) =>
      error instanceof FeishuIdentityConfigurationError && error.code === 'invalid_configuration',
  )
})

test('identity references persist atomically across restart without secret values', async (context) => {
  const fixture = await temporaryStore(context, 'restart')
  const store = new FeishuIdentityConfigurationStore(fixture.path)
  assert.equal(await store.read(), undefined)
  const written = await store.write(configuration())
  const restarted = new FeishuIdentityConfigurationStore(fixture.path)
  assert.deepEqual(await restarted.read(), written)

  const document = await readFile(fixture.path, 'utf8')
  assert.match(document, /secret-ref:feishu-bot-app-credential/u)
  assert.match(document, /secret-ref:feishu-user-oauth/u)
  assert.doesNotMatch(document, /accessToken|refreshToken|appSecret|privateKey/u)
  assert.equal((await lstat(fixture.path)).mode & 0o777, 0o600)
})

test('rejected writes retain the last valid configuration and never echo payloads', async (context) => {
  const fixture = await temporaryStore(context, 'rollback')
  const store = new FeishuIdentityConfigurationStore(fixture.path)
  const committed = await store.write(configuration())
  const originalDocument = await readFile(fixture.path, 'utf8')
  const secret = 'synthetic-rejected-refresh-token'

  await assert.rejects(
    store.write({ ...configuration(), refreshToken: secret }),
    (error) => error instanceof FeishuIdentityConfigurationError && !error.message.includes(secret),
  )
  assert.equal(await readFile(fixture.path, 'utf8'), originalDocument)
  assert.deepEqual(await new FeishuIdentityConfigurationStore(fixture.path).read(), committed)
})

test('identity storage rejects symlinks, oversized documents, and invalid paths', async (context) => {
  const fixture = await temporaryStore(context, 'unsafe')
  const external = join(fixture.root, 'external.json')
  const linkedPath = join(fixture.root, 'linked.json')
  await writeFile(external, JSON.stringify(configuration()))
  await symlink(external, linkedPath)
  const linked = new FeishuIdentityConfigurationStore(linkedPath)
  await assert.rejects(
    linked.read(),
    (error) => error instanceof FeishuIdentityConfigurationError && error.code === 'unsafe_file',
  )
  await assert.rejects(
    linked.write(configuration()),
    (error) => error instanceof FeishuIdentityConfigurationError && error.code === 'unsafe_file',
  )

  const largePath = join(fixture.root, 'large.json')
  await writeFile(largePath, 'x'.repeat(65 * 1024))
  await chmod(largePath, 0o600)
  await assert.rejects(
    new FeishuIdentityConfigurationStore(largePath).read(),
    (error) =>
      error instanceof FeishuIdentityConfigurationError && error.code === 'configuration_too_large',
  )
  assert.throws(
    () => new FeishuIdentityConfigurationStore('bad\u0000path'),
    (error) =>
      error instanceof FeishuIdentityConfigurationError && error.code === 'invalid_store_path',
  )

  const directoryPath = join(fixture.root, 'directory')
  await mkdir(directoryPath)
  await assert.rejects(
    new FeishuIdentityConfigurationStore(directoryPath).read(),
    (error) => error instanceof FeishuIdentityConfigurationError && error.code === 'unsafe_file',
  )
})
