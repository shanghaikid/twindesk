import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FeishuOAuthAuthorizationConfigurationError,
  FeishuOAuthAuthorizationConfigurationStore,
  parseFeishuOAuthAuthorizationConfiguration,
} from '../packages/plugin-feishu/dist/index.js'

function configuration(changes = {}) {
  return {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: 'cli_synthetic_registered_redirect',
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['offline_access', 'im:message:readonly'],
    ...changes,
  }
}

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryStore(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-feishu-oauth-settings-${suffix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  return { root, path: join(root, 'authorization.json') }
}

test('registered OAuth configuration is app-bound, canonical, sorted, and immutable', () => {
  const parsed = parseFeishuOAuthAuthorizationConfiguration(configuration())
  assert.deepEqual(parsed, {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: 'cli_synthetic_registered_redirect',
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['im:message:readonly', 'offline_access'],
  })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.scopes), true)

  assert.equal(
    parseFeishuOAuthAuthorizationConfiguration(
      configuration({ redirectUri: 'http://[::1]:43122/oauth/feishu/callback' }),
    ).redirectUri,
    'http://[::1]:43122/oauth/feishu/callback',
  )
})

test('registered OAuth configuration rejects dynamic, non-loopback, and noncanonical redirects', () => {
  for (const redirectUri of [
    'http://127.0.0.1:0/oauth/feishu/callback',
    'http://127.0.0.1:80/oauth/feishu/callback',
    'http://localhost:43121/oauth/feishu/callback',
    'https://127.0.0.1:43121/oauth/feishu/callback',
    'http://127.0.0.1:43121/oauth/feishu/callback?extra=x',
    'http://127.0.0.1:43121/oauth/feishu/%63allback',
  ]) {
    assert.throws(
      () => parseFeishuOAuthAuthorizationConfiguration(configuration({ redirectUri })),
      (error) =>
        error instanceof FeishuOAuthAuthorizationConfigurationError &&
        error.code === 'invalid_configuration',
    )
  }
})

test('registered OAuth configuration rejects invalid scopes, versions, and hostile data', () => {
  for (const value of [
    configuration({ scopes: ['im:message:readonly'] }),
    configuration({ scopes: ['offline_access', 'offline_access'] }),
    configuration({ schemaVersion: 2 }),
    configuration({ extra: true }),
  ]) {
    assert.throws(
      () => parseFeishuOAuthAuthorizationConfiguration(value),
      FeishuOAuthAuthorizationConfigurationError,
    )
  }
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'kind', {
    get() {
      getterCalls += 1
      return 'feishu_oauth_authorization_configuration'
    },
  })
  assert.throws(
    () => parseFeishuOAuthAuthorizationConfiguration(hostile),
    FeishuOAuthAuthorizationConfigurationError,
  )
  assert.equal(getterCalls, 0)
})

test('authorization settings persist atomically and recover across restart', async (context) => {
  const fixture = await temporaryStore(context, 'restart')
  const store = new FeishuOAuthAuthorizationConfigurationStore(fixture.path)
  assert.equal(await store.read(), undefined)
  const written = await store.write(configuration())
  assert.deepEqual(
    await new FeishuOAuthAuthorizationConfigurationStore(fixture.path).read(),
    written,
  )
  assert.equal((await lstat(fixture.path)).mode & 0o777, 0o600)
  const document = await readFile(fixture.path, 'utf8')
  assert.match(document, /cli_synthetic_registered_redirect/u)
  assert.match(document, /http:\/\/127\.0\.0\.1:43121\/oauth\/feishu\/callback/u)
  assert.doesNotMatch(
    document,
    /clientSecret|accessToken|refreshToken|authorizationCode|codeVerifier|privateKey/u,
  )
})

test('rejected authorization settings retain the last valid document', async (context) => {
  const fixture = await temporaryStore(context, 'rollback')
  const store = new FeishuOAuthAuthorizationConfigurationStore(fixture.path)
  const committed = await store.write(configuration())
  const original = await readFile(fixture.path, 'utf8')
  const secret = 'synthetic-private-value-that-must-not-persist'
  await assert.rejects(
    store.write({ ...configuration(), clientSecret: secret }),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError &&
      !error.message.includes(secret),
  )
  assert.equal(await readFile(fixture.path, 'utf8'), original)
  assert.deepEqual(await store.read(), committed)
})

test('authorization settings reject unsafe, oversized, corrupt, and invalid stores', async (context) => {
  const fixture = await temporaryStore(context, 'unsafe')
  const external = join(fixture.root, 'external.json')
  const linkedPath = join(fixture.root, 'linked.json')
  await writeFile(external, JSON.stringify(configuration()))
  await symlink(external, linkedPath)
  const linked = new FeishuOAuthAuthorizationConfigurationStore(linkedPath)
  for (const operation of [() => linked.read(), () => linked.write(configuration())]) {
    await assert.rejects(
      operation(),
      (error) =>
        error instanceof FeishuOAuthAuthorizationConfigurationError && error.code === 'unsafe_file',
    )
  }

  const largePath = join(fixture.root, 'large.json')
  await writeFile(largePath, 'x'.repeat(65 * 1024))
  await chmod(largePath, 0o600)
  await assert.rejects(
    new FeishuOAuthAuthorizationConfigurationStore(largePath).read(),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError &&
      error.code === 'configuration_too_large',
  )

  const corruptPath = join(fixture.root, 'corrupt.json')
  await writeFile(corruptPath, '{')
  await assert.rejects(
    new FeishuOAuthAuthorizationConfigurationStore(corruptPath).read(),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError &&
      error.code === 'invalid_configuration',
  )

  const invalidUtf8Path = join(fixture.root, 'invalid-utf8.json')
  await writeFile(invalidUtf8Path, new Uint8Array([0xff]))
  await assert.rejects(
    new FeishuOAuthAuthorizationConfigurationStore(invalidUtf8Path).read(),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError &&
      error.code === 'invalid_configuration',
  )

  assert.throws(
    () => new FeishuOAuthAuthorizationConfigurationStore('bad\u0000path'),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError &&
      error.code === 'invalid_store_path',
  )
  const directoryPath = join(fixture.root, 'directory')
  await mkdir(directoryPath)
  await assert.rejects(
    new FeishuOAuthAuthorizationConfigurationStore(directoryPath).read(),
    (error) =>
      error instanceof FeishuOAuthAuthorizationConfigurationError && error.code === 'unsafe_file',
  )
})
