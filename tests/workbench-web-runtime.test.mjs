import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openWorkbenchFeishuSettingsStores,
  startWorkbenchWebServer,
} from '../packages/bundle-workbench/dist/index.js'
import { openTwinDeskDatabase } from '../packages/storage-sqlite/dist/index.js'

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
  let runtimeChanges = 0
  const running = await startWorkbenchWebServer({
    ...localPaths,
    databasePath,
    port: 0,
    onFeishuRuntimeChanged() {
      runtimeChanges += 1
      throw new Error('Synthetic runtime observer failure.')
    },
  })
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
    const replyPreview = await fetch(`${running.url}/api/action-proposals/feishu-reply`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await replyPreview.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    })
    assert.match(
      replyPreview.headers.get('x-twindesk-action-proposal-csrf-token') ?? '',
      /^[A-Za-z0-9_-]{43}$/u,
    )
    const replyApproval = await fetch(`${running.url}/api/action-approvals/feishu-reply`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await replyApproval.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
      ttlSeconds: 900,
    })
    assert.match(
      replyApproval.headers.get('x-twindesk-action-approval-csrf-token') ?? '',
      /^[A-Za-z0-9_-]{43}$/u,
    )
    assert.notEqual(
      replyApproval.headers.get('x-twindesk-action-approval-csrf-token'),
      replyPreview.headers.get('x-twindesk-action-proposal-csrf-token'),
    )
    const replyExecution = await fetch(`${running.url}/api/action-executions/feishu-reply`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await replyExecution.json(), {
      version: 1,
      capability: 'ready',
      actionType: 'feishu.reply',
    })
    assert.match(
      replyExecution.headers.get('x-twindesk-action-execution-csrf-token') ?? '',
      /^[A-Za-z0-9_-]{43}$/u,
    )
    assert.notEqual(
      replyExecution.headers.get('x-twindesk-action-execution-csrf-token'),
      replyApproval.headers.get('x-twindesk-action-approval-csrf-token'),
    )
    const restoredFlow = await fetch(
      `${running.url}/api/action-flow/feishu-reply?workItemId=fixture-work-item-release-risk-question`,
      { headers: { connection: 'close' } },
    )
    assert.equal(restoredFlow.status, 200)
    const restoredFlowSnapshot = await restoredFlow.json()
    assert.equal(restoredFlowSnapshot.stage, 'draft')
    assert.equal(
      restoredFlowSnapshot.draft.draft.workItemId,
      'fixture-work-item-release-risk-question',
    )
    assert.equal(restoredFlowSnapshot.draft.disposition, 'recovered')
    const authorization = await fetch(`${running.url}/api/authorization/feishu`, {
      headers: { connection: 'close' },
    })
    assert.equal(authorization.status, 200)
    assert.deepEqual(await authorization.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'idle',
    })
    assert.ok(authorization.headers.get('x-twindesk-csrf-token') !== null)
    const reauthorization = await fetch(`${running.url}/api/reauthorization/feishu`, {
      headers: { connection: 'close' },
    })
    assert.equal(reauthorization.status, 200)
    assert.deepEqual(await reauthorization.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'idle',
    })
    assert.ok(reauthorization.headers.get('x-twindesk-csrf-token') !== null)
    assert.notEqual(
      reauthorization.headers.get('x-twindesk-csrf-token'),
      authorization.headers.get('x-twindesk-csrf-token'),
    )
    const recovery = await fetch(`${running.url}/api/recovery/feishu/oauth`, {
      headers: { connection: 'close' },
    })
    assert.equal(recovery.status, 200)
    assert.deepEqual(await recovery.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'not_started',
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
    assert.equal(runtimeChanges, 1)
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
  const reservation = await restartedStores.rotationJournal.reserve(
    '2026-08-31T08:00:00.000Z',
    '2026-08-31T08:01:00.000Z',
  )
  await restartedStores.rotationJournal.settle(
    reservation.sequence,
    'reauthorization_required',
    '2026-08-31T08:02:00.000Z',
  )
  const restarted = await startWorkbenchWebServer({ ...localPaths, databasePath, port: 0 })
  try {
    const recovery = await fetch(`${restarted.url}/api/recovery/feishu/oauth`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await recovery.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'reauthorization_required',
    })
    const reauthorization = await fetch(`${restarted.url}/api/reauthorization/feishu`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await reauthorization.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'idle',
    })
  } finally {
    await restarted.close()
  }

  await assert.rejects(
    restartedStores.rotationJournal.replaceAfterReauthorization(
      '2026-08-31T08:03:00.000Z',
      async () => {
        throw new Error('synthetic-interrupted-keychain-boundary')
      },
    ),
    /synthetic-interrupted/u,
  )
  const pendingOperationId =
    'connector-maintenance:feishu:credential-reconciliation:web-restart-repair'
  const beforeReconciliationRestart = openTwinDeskDatabase(databasePath)
  beforeReconciliationRestart.beginConnectorMaintenance(
    /** @type {any} */ ({
      kind: 'connector_maintenance_request',
      schemaVersion: 1,
      id: pendingOperationId,
      connectorId: 'feishu',
      operation: 'credential_reconciliation',
      requestedAt: '2026-08-31T08:04:00.000Z',
    }),
  )
  beforeReconciliationRestart.close()
  const reconciliationRestart = await startWorkbenchWebServer({
    ...localPaths,
    databasePath,
    port: 0,
  })
  try {
    const recovery = await fetch(`${reconciliationRestart.url}/api/recovery/feishu/oauth`, {
      headers: { connection: 'close' },
    })
    assert.deepEqual(await recovery.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'reconciliation_required',
    })
    const audit = await fetch(`${reconciliationRestart.url}/api/audit`, {
      headers: { connection: 'close' },
    })
    assert.equal(audit.status, 200)
    assert.equal(
      (await audit.json()).items.some(
        /** @param {{ summary?: unknown }} item */
        (item) =>
          item.summary === 'Local Connector credential reconciliation still requires attention.',
      ),
      true,
    )
  } finally {
    await reconciliationRestart.close()
  }
  const afterReconciliationRestart = openTwinDeskDatabase(databasePath)
  assert.equal(
    afterReconciliationRestart.getConnectorMaintenance(pendingOperationId)?.settlement?.result,
    'still_required',
  )
  afterReconciliationRestart.close()
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

  let nestedGetterCalls = 0
  const hostileRuntime = Object.defineProperty({}, 'runner', {
    enumerable: true,
    get() {
      nestedGetterCalls += 1
      throw new Error('synthetic-private-hostile-model-runtime')
    },
  })
  await assert.rejects(
    startWorkbenchWebServer(
      /** @type {never} */ ({
        port: 0,
        modelDraftRuntime: hostileRuntime,
      }),
    ),
    (error) => error instanceof TypeError && !error.message.includes('synthetic-private'),
  )
  assert.equal(nestedGetterCalls, 0)
})

test('Workbench injects only a Host-owned model Draft route into the Web capability', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-model-draft-web-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  let runnerCalls = 0
  const running = await startWorkbenchWebServer({
    platform: 'darwin',
    homeDirectory,
    databasePath: join(root, 'twindesk.sqlite3'),
    port: 0,
    modelDraftRuntime: {
      runner: /** @type {any} */ ({
        run() {
          runnerCalls += 1
        },
      }),
      provider: 'host-provider-not-for-browser',
      model: 'host-model-not-for-browser',
    },
  })
  try {
    const response = await fetch(`${running.url}/api/model-drafts`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.deepEqual(JSON.parse(body), {
      version: 1,
      capability: 'ready',
      autonomy: 'draft_only',
    })
    assert.doesNotMatch(body, /host-provider|host-model/u)
    assert.match(
      response.headers.get('x-twindesk-model-draft-csrf-token') ?? '',
      /^[A-Za-z0-9_-]{43}$/u,
    )
    assert.equal(runnerCalls, 0)
  } finally {
    await running.close()
  }
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
    const replyPreview = await fetch(`${running.url}/api/action-proposals/feishu-reply`)
    assert.equal((await replyPreview.json()).capability, 'ready')
    assert.ok(replyPreview.headers.get('x-twindesk-action-proposal-csrf-token') !== null)
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

test('Workbench Web adds a Bot identity to the existing Feishu application and recovers it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'twindesk-workbench-bot-bootstrap-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const homeDirectory = join(root, 'synthetic-home')
  await mkdir(homeDirectory, { mode: 0o700 })
  const localPaths = {
    platform: /** @type {const} */ ('darwin'),
    homeDirectory,
  }
  const running = await startWorkbenchWebServer({ ...localPaths, port: 0 })
  try {
    const initial = await fetch(`${running.url}/api/settings/feishu`)
    assert.equal(initial.headers.get('x-twindesk-user-identity-creation'), 'new')
    assert.equal(initial.headers.get('x-twindesk-bot-identity-creation'), 'new')
    const initialCsrf = initial.headers.get('x-twindesk-csrf-token')
    assert.ok(initialCsrf !== null)
    const userResponse = await fetch(`${running.url}/api/settings/feishu/user-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': initialCsrf,
      },
      body: JSON.stringify({
        version: 1,
        connection: 'new',
        appId: 'cli_synthetic_bot_web_bootstrap',
        displayName: 'Synthetic Bootstrap User',
        principalId: 'ou_synthetic_bot_web_user',
      }),
    })
    assert.equal(userResponse.status, 200)
    assert.equal(userResponse.headers.get('x-twindesk-bot-identity-creation'), 'existing')
    const botCsrf = userResponse.headers.get('x-twindesk-csrf-token')
    assert.ok(botCsrf !== null)

    const botResponse = await fetch(`${running.url}/api/settings/feishu/bot-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.url,
        'sec-fetch-site': 'same-origin',
        'x-twindesk-csrf-token': botCsrf,
      },
      body: JSON.stringify({
        version: 1,
        connection: 'existing',
        appId: null,
        displayName: 'Synthetic Bootstrap Bot',
        principalId: 'ou_synthetic_bot_web_bootstrap',
      }),
    })
    assert.equal(botResponse.status, 200)
    assert.deepEqual(await botResponse.json(), {
      version: 1,
      connectorId: 'feishu',
      state: 'incomplete',
      identities: ['bot', 'user'],
      oauth: null,
    })
    assert.equal(botResponse.headers.get('x-twindesk-bot-identity-creation'), null)
  } finally {
    await running.close()
  }

  const stores = await openWorkbenchFeishuSettingsStores(localPaths)
  const identity = await stores.identityStore.read()
  assert.equal(identity?.appId, 'cli_synthetic_bot_web_bootstrap')
  assert.equal(identity?.user?.principalId, 'ou_synthetic_bot_web_user')
  assert.equal(identity?.bot?.principalId, 'ou_synthetic_bot_web_bootstrap')
  assert.match(
    identity?.bot?.credentialReference.id ?? '',
    /^secret-ref:feishu-bot-app-[a-f0-9-]{36}$/u,
  )

  const restarted = await startWorkbenchWebServer({ ...localPaths, port: 0 })
  try {
    const status = await fetch(`${restarted.url}/api/settings/feishu`)
    assert.equal(status.headers.get('x-twindesk-user-identity-creation'), null)
    assert.equal(status.headers.get('x-twindesk-bot-identity-creation'), null)
    assert.deepEqual((await status.json()).identities, ['bot', 'user'])
  } finally {
    await restarted.close()
  }
})
