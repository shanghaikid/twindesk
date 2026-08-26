import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TWIN_DESK_ROUTE,
  resolveTwinDeskRoute,
  TWIN_DESK_ROUTES,
} from '../packages/web/dist/routes.js'
import { startTwinDeskWebServer } from '../packages/web/dist/server.js'

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
  const running = await startTwinDeskWebServer({ port: 0 })
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
  assert.match(await appResponse.text(), /history\.pushState/u)

  const stylesResponse = await request(`${running.url}/styles.css`)
  assert.equal(stylesResponse.status, 200)
  assert.match(await stylesResponse.text(), /\.app-shell/u)

  const healthResponse = await request(`${running.url}/health`)
  assert.deepEqual(await healthResponse.json(), {
    service: 'twindesk-web',
    status: 'ok',
    version: 1,
  })

  const postResponse = await request(`${running.url}/health`, { method: 'POST' })
  assert.equal(postResponse.status, 405)
  assert.equal(postResponse.headers.get('allow'), 'GET, HEAD')
  assert.equal((await request(`${running.url}/unknown`)).status, 404)

  const port = running.port
  await running.close()
  await running.close()
  const restarted = await startTwinDeskWebServer({ port })
  try {
    assert.equal((await request(`${restarted.url}/inbox`)).status, 200)
  } finally {
    await restarted.close()
  }
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
