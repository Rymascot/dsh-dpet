/**
 * HTTP plumbing for the DPet routes: access control, bounded body readers,
 * JSON and file responses.
 *
 * Access: every route is loopback-only (socket address AND Host header), and
 * state-changing requests additionally require a same-origin Origin header
 * when the browser sends one, so a web page on another site cannot drive
 * the import or settings endpoints through the user's browser.
 * @module dsh-dpet/http
 */

import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket address is in the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  if (a.startsWith('::ffff:')) return isIPv4Loopback(a.slice(7))
  return isIPv4Loopback(a)
}

/** Whether a URL hostname names the loopback host. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
}

/**
 * Loopback-only access check, plus a same-origin check for writes.
 * @returns undefined when allowed, else the reason.
 */
export function accessProblem(req: IncomingMessage): string | undefined {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return 'loopback-only'
  const host = req.headers.host
  if (typeof host !== 'string') return 'missing-host'
  let hostname: string
  try {
    hostname = new URL('http://' + host).hostname
  } catch {
    return 'bad-host'
  }
  if (!isLoopbackHostname(hostname)) return 'loopback-only'
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost: string
      try {
        originHost = new URL(origin).host
      } catch {
        return 'bad-origin'
      }
      if (originHost !== host) return 'cross-origin'
    }
  }
  return undefined
}

/** Send a JSON body. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read a request body up to a byte ceiling; rejects with 'body-too-large' beyond it. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new Error('body-too-large'))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.byteLength
      if (size > maxBytes) {
        failed = true
        reject(new Error('body-too-large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', (error) => { if (!failed) reject(error) })
  })
}

/** Read and parse a small JSON body ({} when empty). */
export async function readJson(req: IncomingMessage, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const data = await readBody(req, maxBytes)
  if (data.byteLength === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid-json')
  return parsed as Record<string, unknown>
}

const MIME: Readonly<Record<string, string>> = {
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json',
}

/** Content type by extension (octet-stream fallback). */
export function mimeOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return (dot < 0 ? undefined : MIME[file.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
}

/** Serve one file with a weak validator so repeat loads settle as 304. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let info
  try {
    info = await stat(file)
    if (!info.isFile()) throw new Error('not-a-file')
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  const etag = '"' + info.size.toString(16) + '-' + Math.round(info.mtimeMs).toString(16) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': String(body.byteLength),
    'cache-control': 'no-cache',
    etag,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
