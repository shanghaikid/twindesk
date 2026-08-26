import { readFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTwinDeskRoute } from './routes.ts'

const outputRoot = dirname(fileURLToPath(import.meta.url))
const ASSETS = new Map([
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/routes.js', { file: 'routes.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
])
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ')

/** Options for the local-only TwinDesk product Web server. */
export interface TwinDeskWebServerOptions {
  readonly host?: '127.0.0.1' | '::1'
  readonly port?: number
}

/** Running local server with explicit, idempotent shutdown. */
export interface RunningTwinDeskWebServer {
  readonly host: string
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

function commonHeaders(contentType: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

function send(response: ServerResponse, status: number, body: string | Buffer, type: string): void {
  response.writeHead(status, commonHeaders(type))
  response.end(body)
}

async function serveAsset(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const asset = ASSETS.get(pathname)
  if (asset === undefined) {
    send(response, 404, 'Not found.\n', 'text/plain; charset=utf-8')
    return
  }
  const body = await readFile(join(outputRoot, asset.file))
  response.writeHead(200, {
    ...commonHeaders(asset.type),
    'content-length': String(body.byteLength),
  })
  response.end(headOnly ? undefined : body)
}

async function serveIndex(response: ServerResponse, headOnly: boolean): Promise<void> {
  const body = await readFile(join(outputRoot, 'index.html'))
  response.writeHead(200, {
    ...commonHeaders('text/html; charset=utf-8'),
    'content-length': String(body.byteLength),
  })
  response.end(headOnly ? undefined : body)
}

function addressOf(server: Server): { host: string; port: number } {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('TwinDesk Web server did not acquire a TCP address')
  }
  return { host: address.address, port: address.port }
}

/**
 * Start the product-owned local Web shell without exposing it to the network.
 * @param options - optional loopback host and TCP port; port 0 selects an available port.
 * @returns the running server and its idempotent shutdown operation.
 */
export async function startTwinDeskWebServer(
  options: TwinDeskWebServerOptions = {},
): Promise<RunningTwinDeskWebServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4173
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('TwinDesk Web must bind to loopback')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('TwinDesk Web port must be an integer from 0 through 65535')
  }

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD')
        send(response, 405, 'Method not allowed.\n', 'text/plain; charset=utf-8')
        return
      }

      const requestUrl = new URL(request.url ?? '/', `http://${host}`)
      if (requestUrl.pathname === '/health') {
        const body = JSON.stringify({ service: 'twindesk-web', status: 'ok', version: 1 })
        send(response, 200, method === 'HEAD' ? '' : body, 'application/json; charset=utf-8')
        return
      }
      if (ASSETS.has(requestUrl.pathname)) {
        await serveAsset(response, requestUrl.pathname, method === 'HEAD')
        return
      }
      if (resolveTwinDeskRoute(requestUrl.pathname) !== undefined) {
        await serveIndex(response, method === 'HEAD')
        return
      }
      send(response, 404, 'Not found.\n', 'text/plain; charset=utf-8')
    })().catch(() => {
      if (!response.headersSent) {
        send(response, 500, 'Internal server error.\n', 'text/plain; charset=utf-8')
      } else {
        response.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = addressOf(server)
  const displayHost = address.host.includes(':') ? `[${address.host}]` : address.host
  let closing: Promise<void> | undefined
  return {
    host: address.host,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error)
          else resolve()
        })
      })
      return closing
    },
  }
}
