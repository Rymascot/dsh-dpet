/**
 * Image-to-3D route integration: a real HTTP server over temp dirs, with the
 * mock Hunyuan client (no network).
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PetLibrary } from '../src/server/repository/library.ts'
import { SettingsStore } from '../src/server/repository/settings.ts'
import { CredentialStore } from '../src/server/repository/credentials.ts'
import { Generator } from '../src/server/service/generator.ts'
import { HunyuanError, mockClient, type HunyuanClient } from '../src/server/service/hunyuan/client.ts'
import { makeGenerateRoutes } from '../src/server/controller/generate-routes.ts'
import type { GenerateResponse, GenerateStateResponse } from '../src/shared/types.ts'

const GLB = fileURLToPath(new URL('../assets/pets/dongdong/dongdong.glb', import.meta.url))
const API_KEY = 'sk-route-test-0123456789zz'

let dir: string
let server: Server
let base: string
let generator: Generator
let credentials: CredentialStore
const mock = mockClient(GLB, 2)

function dispatch(routes: WebRoute[]): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find(r => r.kind === 'exact' ? r.path === path : path === r.path || path.startsWith(r.path + '/'))
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dpet-genroutes-'))
  credentials = new CredentialStore(join(dir, 'credentials.json'), {})
  // Saved credentials switch the mock on; the real clients are never built here.
  const client = (): HunyuanClient | undefined => credentials.resolve() === undefined ? undefined : mock
  generator = new Generator({
    dir: join(dir, 'generate'),
    library: new PetLibrary({ builtin: join(dir, 'builtin'), user: join(dir, 'pets') }),
    settings: new SettingsStore(join(dir, 'settings.json')),
    credentials,
    client,
    pollDelay: () => 5,
  })
  server = dispatch(makeGenerateRoutes({
    generator,
    credentials,
    check: async () => {
      if (client() === undefined) throw new HunyuanError('not-configured')
    },
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = 'http://127.0.0.1:' + (typeof address === 'object' && address !== null ? address.port : 0)
})

afterAll(async () => {
  generator.dispose()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const state = async (): Promise<GenerateStateResponse> => (await fetch(base + '/api/dpet/generate')).json() as Promise<GenerateStateResponse>
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const picture = async (): Promise<Blob> =>
  new Blob([new Uint8Array(await sharp({ create: { width: 256, height: 256, channels: 3, background: '#2255cc' } }).jpeg().toBuffer())])

describe('generate routes', () => {
  it('starts unconfigured and refuses to generate', async () => {
    expect((await state()).hunyuan).toEqual({ configured: false })
    const res = await fetch(base + '/api/dpet/generate?name=x', { method: 'POST', body: await picture() })
    expect(res.status).toBe(400)
    expect((await res.json() as GenerateResponse)).toMatchObject({ ok: false, error: 'not-configured' })
    expect(await (await postJson('/api/dpet/generate/check', {})).json()).toMatchObject({ ok: false, error: 'not-configured' })
  })

  it('refuses cross-origin credential writes and bad keys', async () => {
    const cross = await postJson('/api/dpet/generate/credentials', { method: 'tokenhub', apiKey: API_KEY }, { origin: 'https://evil.example' })
    expect(cross.status).toBe(403)
    const bad = await postJson('/api/dpet/generate/credentials', { method: 'tokenhub', apiKey: 'x' })
    expect(bad.status).toBe(400)
    expect(credentials.resolve()).toBeUndefined()
  })

  it('saves credentials without ever echoing the secret', async () => {
    const res = await postJson('/api/dpet/generate/credentials', { method: 'tokenhub', apiKey: API_KEY })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain(API_KEY)
    expect(JSON.parse(text)).toMatchObject({ ok: true, hunyuan: { configured: true, method: 'tokenhub', source: 'local', hint: '…89zz' } })
    expect(JSON.stringify(await state())).not.toContain(API_KEY)
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).apiKey).toBe(API_KEY)
    expect(await (await postJson('/api/dpet/generate/check', {})).json()).toEqual({ ok: true })
  })

  it('generates a pet, serves the input thumbnail, and dismisses the job', async () => {
    const res = await fetch(base + '/api/dpet/generate?name=' + encodeURIComponent('蓝块') + '&model=pro', { method: 'POST', body: await picture() })
    const body = await res.json() as GenerateResponse
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.job).toMatchObject({ name: '蓝块', model: 'pro', status: 'queued' })

    const busy = await fetch(base + '/api/dpet/generate', { method: 'POST', body: await picture() })
    expect(busy.status).toBe(409)

    const done = await generator.settled(body.job.id)
    expect(done.status).toBe('done')
    const listed = (await state()).jobs[0]!
    expect(listed).toMatchObject({ id: body.job.id, status: 'done', petId: done.petId })

    const thumb = await fetch(base + listed.inputUrl!)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/png')

    expect((await postJson('/api/dpet/generate/job/' + body.job.id + '/dismiss', {})).status).toBe(200)
    expect((await state()).jobs).toEqual([])
    expect((await fetch(base + listed.inputUrl!)).status).toBe(404)
  }, 60_000)

  it('rejects malformed job paths', async () => {
    expect((await fetch(base + '/api/dpet/generate/job/../../credentials.json')).status).toBe(404)
    expect((await fetch(base + '/api/dpet/generate/job/abc/input.png')).status).toBe(404)
  })

  it('clears saved credentials', async () => {
    const res = await postJson('/api/dpet/generate/credentials', { clear: true })
    expect(await res.json()).toMatchObject({ ok: true, hunyuan: { configured: false } })
  })
})
