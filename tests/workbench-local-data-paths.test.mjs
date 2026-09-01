import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  WorkbenchLocalDataPathError,
  openWorkbenchFeishuSettingsStores,
  resolveWorkbenchLocalDataPaths,
} from '../packages/bundle-workbench/dist/index.js'

const execFileAsync = promisify(execFile)
const pluginUrl = new URL('../packages/plugin-feishu/dist/index.js', import.meta.url).href

const IDENTITY = Object.freeze({
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-default-paths',
  appId: 'cli_synthetic_default_paths',
  user: Object.freeze({
    identityType: 'user',
    principalId: 'ou_synthetic_default_paths',
    displayName: 'Synthetic User',
    credentialReference: Object.freeze({
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-default-paths',
      store: 'system_keychain',
      purpose: 'connector_oauth',
    }),
  }),
})

/** @param {import('node:test').TestContext} context @param {string} suffix */
async function temporaryHome(context, suffix) {
  const root = await mkdtemp(join(tmpdir(), `twindesk-local-paths-${suffix}-`))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  return { root, homeDirectory }
}

test('Workbench resolves one fixed macOS product-data layout', () => {
  const paths = resolveWorkbenchLocalDataPaths({
    platform: 'darwin',
    homeDirectory: '/Users/synthetic',
  })
  assert.deepEqual(paths, {
    kind: 'workbench_local_data_paths',
    schemaVersion: 2,
    platform: 'darwin',
    rootDirectory: '/Users/synthetic/Library/Application Support/TwinDesk',
    feishuSettingsDirectory:
      '/Users/synthetic/Library/Application Support/TwinDesk/settings/connectors/feishu',
    feishuStateDirectory:
      '/Users/synthetic/Library/Application Support/TwinDesk/state/connectors/feishu',
    feishuIdentityConfiguration:
      '/Users/synthetic/Library/Application Support/TwinDesk/settings/connectors/feishu/identity.v1.json',
    feishuOAuthAuthorizationConfiguration:
      '/Users/synthetic/Library/Application Support/TwinDesk/settings/connectors/feishu/oauth-authorization.v1.json',
    feishuOAuthRotationJournal:
      '/Users/synthetic/Library/Application Support/TwinDesk/state/connectors/feishu/oauth-rotation.jsonl',
  })
  assert.equal(Object.isFrozen(paths), true)
})

test('default Feishu Settings and recovery stores survive a cold restart', async (context) => {
  const fixture = await temporaryHome(context, 'restart')
  const options = {
    platform: /** @type {const} */ ('darwin'),
    homeDirectory: fixture.homeDirectory,
  }
  const first = await openWorkbenchFeishuSettingsStores(options)
  const authorization = {
    kind: 'feishu_oauth_authorization_configuration',
    schemaVersion: 1,
    connectorId: 'feishu',
    appId: IDENTITY.appId,
    redirectUri: 'http://127.0.0.1:43121/oauth/feishu/callback',
    scopes: ['offline_access', 'im:message:readonly'],
  }
  await first.identityStore.write(IDENTITY)
  await first.authorizationStore.write(authorization)
  const reserved = await first.rotationJournal.reserve(
    '2026-08-31T12:00:00.000Z',
    '2026-08-31T12:00:01.000Z',
  )
  await first.rotationJournal.settle(
    reserved.sequence,
    'completed',
    '2026-08-31T12:00:03.000Z',
    '2026-08-31T12:00:02.000Z',
  )

  const coldRead = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { FeishuOAuthRotationJournal } from ${JSON.stringify(pluginUrl)}; const journal = new FeishuOAuthRotationJournal(process.argv[1]); process.stdout.write(JSON.stringify(await journal.inspect()));`,
    first.paths.feishuOAuthRotationJournal,
  ])
  assert.deepEqual(JSON.parse(coldRead.stdout), {
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: 3,
    sequence: 1,
    state: 'completed',
    sourceObtainedAt: '2026-08-31T12:00:00.000Z',
    recordedAt: '2026-08-31T12:00:03.000Z',
    resultObtainedAt: '2026-08-31T12:00:02.000Z',
  })

  const restarted = await openWorkbenchFeishuSettingsStores(options)
  assert.deepEqual(await restarted.identityStore.read(), IDENTITY)
  assert.deepEqual(await restarted.authorizationStore.read(), {
    ...authorization,
    scopes: ['im:message:readonly', 'offline_access'],
  })
  assert.deepEqual(await restarted.rotationJournal.inspect(), {
    kind: 'feishu_oauth_rotation_event',
    schemaVersion: 3,
    sequence: 1,
    state: 'completed',
    sourceObtainedAt: '2026-08-31T12:00:00.000Z',
    recordedAt: '2026-08-31T12:00:03.000Z',
    resultObtainedAt: '2026-08-31T12:00:02.000Z',
  })
  for (const path of [
    restarted.paths.rootDirectory,
    join(restarted.paths.rootDirectory, 'settings'),
    join(restarted.paths.rootDirectory, 'settings', 'connectors'),
    restarted.paths.feishuSettingsDirectory,
    join(restarted.paths.rootDirectory, 'state'),
    join(restarted.paths.rootDirectory, 'state', 'connectors'),
    restarted.paths.feishuStateDirectory,
  ]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700)
  }
  const documents = await Promise.all([
    readFile(restarted.paths.feishuIdentityConfiguration, 'utf8'),
    readFile(restarted.paths.feishuOAuthAuthorizationConfiguration, 'utf8'),
    readFile(restarted.paths.feishuOAuthRotationJournal, 'utf8'),
  ])
  assert.doesNotMatch(
    documents.join('\n'),
    /clientSecret|accessToken|refreshToken|authorizationCode|codeVerifier|privateKey/u,
  )
})

test('default data paths reject unsupported, aliased, broad, and hostile options', async () => {
  for (const options of [
    { platform: 'linux', homeDirectory: '/home/synthetic' },
    { platform: 'darwin', homeDirectory: 'relative/home' },
    { platform: 'darwin', homeDirectory: '/' },
    { platform: 'darwin', homeDirectory: '/Users/synthetic/../synthetic' },
    { platform: 42, homeDirectory: '/Users/synthetic' },
    { platform: 'darwin', homeDirectory: '/Users/synthetic', extra: true },
  ]) {
    assert.throws(
      () => resolveWorkbenchLocalDataPaths(/** @type {never} */ (options)),
      WorkbenchLocalDataPathError,
    )
  }
  const secret = 'synthetic-hostile-path-secret'
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'homeDirectory', {
    get() {
      getterCalls += 1
      throw new Error(secret)
    },
  })
  assert.throws(
    () => resolveWorkbenchLocalDataPaths(/** @type {never} */ (hostile)),
    (error) => error instanceof WorkbenchLocalDataPathError && !error.message.includes(secret),
  )
  assert.equal(getterCalls, 0)
})

test('default local-data preparation rejects linked or publicly accessible directories', async (context) => {
  const linked = await temporaryHome(context, 'linked')
  const external = join(linked.root, 'external')
  await mkdir(external)
  await symlink(external, join(linked.homeDirectory, 'Library'))
  await assert.rejects(
    openWorkbenchFeishuSettingsStores({
      platform: 'darwin',
      homeDirectory: linked.homeDirectory,
    }),
    (error) => error instanceof WorkbenchLocalDataPathError && error.code === 'unsafe_path',
  )

  const linkedState = await temporaryHome(context, 'linked-state')
  const linkedStateRoot = join(
    linkedState.homeDirectory,
    'Library',
    'Application Support',
    'TwinDesk',
  )
  await mkdir(linkedStateRoot, { recursive: true, mode: 0o700 })
  const externalState = join(linkedState.root, 'external-state')
  await mkdir(externalState)
  await symlink(externalState, join(linkedStateRoot, 'state'))
  await assert.rejects(
    openWorkbenchFeishuSettingsStores({
      platform: 'darwin',
      homeDirectory: linkedState.homeDirectory,
    }),
    (error) => error instanceof WorkbenchLocalDataPathError && error.code === 'unsafe_path',
  )
  assert.deepEqual(await readdir(externalState), [])
  assert.deepEqual(await readdir(external), [])

  const publicFixture = await temporaryHome(context, 'public')
  const productRoot = join(
    publicFixture.homeDirectory,
    'Library',
    'Application Support',
    'TwinDesk',
  )
  await mkdir(productRoot, { recursive: true, mode: 0o755 })
  await assert.rejects(
    openWorkbenchFeishuSettingsStores({
      platform: 'darwin',
      homeDirectory: publicFixture.homeDirectory,
    }),
    (error) => error instanceof WorkbenchLocalDataPathError && error.code === 'unsafe_path',
  )

  await chmod(productRoot, 0o600)
  await assert.rejects(
    openWorkbenchFeishuSettingsStores({
      platform: 'darwin',
      homeDirectory: publicFixture.homeDirectory,
    }),
    (error) => error instanceof WorkbenchLocalDataPathError && error.code === 'unsafe_path',
  )
})
