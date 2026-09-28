/**
 * Route integration: a real HTTP server with the DPet routes over temp dirs.
 */
import { createServer, type Server } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ActivityTracker } from '../src/server/service/activity.ts'
import { PetLibrary } from '../src/server/repository/library.ts'
import { makeRoutes } from '../src/server/controller/routes.ts'
import { SettingsStore } from '../src/server/repository/settings.ts'
import type { ImportResponse, PetView, StateResponse } from '../src/shared/types.ts'

const pkg = fileURLToPath(new URL('..', import.meta.url))
let dir: string
let server: Server
let base: string
let tracker: ActivityTracker

/** Recursive copy. fs.cpSync is avoided: its native Windows implementation crashes on non-ASCII paths in Node 22. */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    if (statSync(source).isDirectory()) copyDir(source, join(to, name))
    else copyFileSync(source, join(to, name))
  }
}

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
  dir = mkdtempSync(join(tmpdir(), 'dpet-routes-'))
  copyDir(join(pkg, 'assets', 'pets'), join(dir, 'builtin'))
  tracker = new ActivityTracker()
  const routes = makeRoutes({
    tracker,
    library: new PetLibrary({ builtin: join(dir, 'builtin'), user: join(dir, 'user') }),
    settings: new SettingsStore(join(dir, 'settings.json')),
    vendorDir: join(dir, 'lib'),
  })
  server = dispatch(routes)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = 'http://127.0.0.1:' + (typeof address === 'object' && address !== null ? address.port : 0)
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe('DPet routes', () => {
  it('serves the state with the default pet and live activity', async () => {
    tracker.onSessionEvent('s1', { type: 'tool/call', data: { callId: 'a', name: 'bash' } })
    const state = await (await fetch(base + '/api/dpet/state')).json() as StateResponse
    expect(state.pet.id).toBe('dongdong')
    expect(state.pet.kind).toBe('3d')
    expect(state.activity).toMatchObject({ phase: 'tool', tool: 'bash' })
  })

  it('lists built-in pets and serves their files', async () => {
    const pets = await (await fetch(base + '/api/dpet/pets')).json() as PetView[]
    expect(pets.map(p => p.id)).toEqual(['dongdong', 'dongdong-flat'])
    const file = await fetch(base + pets[0]!.fileUrl)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('model/gltf-binary')
    expect((await fetch(base + '/dpet/pets/dongdong/pet.json')).status).toBe(404)
    expect((await fetch(base + '/dpet/pets/dongdong/..%2F..%2Fsettings.json')).status).toBe(404)
  })

  it('updates settings and rejects unknown pets', async () => {
    const ok = await fetch(base + '/api/dpet/settings', { method: 'POST', body: JSON.stringify({ size: 300, petId: 'dongdong-flat' }) })
    expect((await ok.json()).settings).toMatchObject({ size: 300, petId: 'dongdong-flat' })
    const bad = await fetch(base + '/api/dpet/settings', { method: 'POST', body: JSON.stringify({ petId: 'nope' }) })
    expect(bad.status).toBe(400)
  })

  it('refuses cross-origin writes', async () => {
    const res = await fetch(base + '/api/dpet/settings', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(403)
  })

  it('imports an image, renames it, and deletes it', async () => {
    const png = readFileSync(join(pkg, 'assets', 'pets', 'dongdong-flat', 'dongdong.png'))
    const imported = await (await fetch(base + '/api/dpet/import?name=My%20Pet', { method: 'POST', body: png })).json() as ImportResponse
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.pet).toMatchObject({ id: 'my-pet', name: 'My Pet', kind: '2d', builtin: false })
    expect((await fetch(base + imported.pet.fileUrl)).status).toBe(200)
    const renamed = await (await fetch(base + '/api/dpet/pet/my-pet/rename', { method: 'POST', body: JSON.stringify({ name: 'Renamed' }) })).json()
    expect(renamed.pet.name).toBe('Renamed')
    expect((await fetch(base + '/api/dpet/pet/dongdong/delete', { method: 'POST' })).status).toBe(400)
    expect((await fetch(base + '/api/dpet/pet/my-pet/delete', { method: 'POST' })).status).toBe(200)
    const pets = await (await fetch(base + '/api/dpet/pets')).json() as PetView[]
    expect(pets.some(p => p.id === 'my-pet')).toBe(false)
  })

  it('previews a background removal without creating a pet', async () => {
    const sharp = (await import('sharp')).default
    const png = readFileSync(join(pkg, 'assets', 'pets', 'dongdong-flat', 'dongdong.png'))
    const jpeg = await sharp(png).flatten({ background: '#ffffff' }).jpeg().toBuffer()
    const res = await fetch(base + '/api/dpet/import/preview', { method: 'POST', body: jpeg })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(JSON.parse(res.headers.get('x-dpet-report')!)).toMatchObject({ background: 'removed' })
    const pets = await (await fetch(base + '/api/dpet/pets')).json() as PetView[]
    expect(pets.map(p => p.id)).toEqual(['dongdong', 'dongdong-flat'])
    const kept = await (await fetch(base + '/api/dpet/import?name=White&background=keep', { method: 'POST', body: jpeg })).json() as ImportResponse
    expect(kept.ok && kept.report.background).toBe('kept')
  })

  it('reports unsupported uploads', async () => {
    const res = await fetch(base + '/api/dpet/import', { method: 'POST', body: 'hello' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'unsupported-format' })
  })
})
