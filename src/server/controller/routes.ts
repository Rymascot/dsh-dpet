/**
 * The DPet route family.
 *
 *   GET  /api/dpet/state                 activity + settings + current pet
 *   GET  /api/dpet/pets                  the library
 *   POST /api/dpet/settings              partial settings update (JSON)
 *   POST /api/dpet/import/preview        raw picture -> processed PNG (no pet created)
 *   POST /api/dpet/import?name=...&background=remove|keep   raw upload -> new pet
 *   POST /api/dpet/pet/<id>/rename       { name }
 *   POST /api/dpet/pet/<id>/preview      raw PNG thumbnail body
 *   POST /api/dpet/pet/<id>/delete
 *   GET  /api/dpet/runtime/<vendor>      three.js vendor bundle
 *   GET  /dpet/pets/<id>/<file>          a pet's model / image / preview
 * @module dsh-dpet/server/controller/routes
 */

import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ActivityTracker } from '../service/activity.ts'
import { accessProblem, readBody, readJson, sendFile, writeJson } from '../common/http.ts'
import { IMPORT_LIMITS, kindOf, processUpload, sniffFormat } from '../service/importer.ts'
import { cleanName, PET_FILE_PREFIX, type PetEntry, type PetLibrary } from '../repository/library.ts'
import { DEFAULT_PET_ID, type SettingsStore } from '../repository/settings.ts'
import type { BackgroundMode, ImportResponse, PetView, StateResponse } from '../../shared/types.ts'

/** API prefix of the JSON endpoints. */
export const API_PREFIX = '/api/dpet'
/** Runtime files the vendor route may serve, by exact name. */
const RUNTIME_FILES = new Set(['gltf-vendor.js', 'gltf-vendor.js.map'])
/** Largest accepted thumbnail upload. */
const PREVIEW_MAX = 2 * 1024 * 1024

function backgroundMode(url: URL): BackgroundMode {
  return url.searchParams.get('background') === 'keep' ? 'keep' : 'remove'
}

/** Everything the routes need. */
export interface RouteDeps {
  tracker: ActivityTracker
  library: PetLibrary
  settings: SettingsStore
  /** Directory holding lib/gltf-vendor.js. */
  vendorDir: string
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** Wrap a handler with the access check and uniform error reporting. */
function guarded(handler: Handler): WebRoute['handler'] {
  return async (req, res) => {
    const problem = accessProblem(req)
    if (problem !== undefined) {
      writeJson(res, 403, { ok: false, error: problem })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
    }
  }
}

function methodIs(req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean {
  if (methods.includes(req.method ?? 'GET')) return true
  writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/** The selected pet, falling back to the default (or first) pet when it is gone. */
export function currentPet(library: PetLibrary, petId: string): PetEntry | undefined {
  const pets = library.list()
  return pets.find(p => p.manifest.id === petId)
    ?? pets.find(p => p.manifest.id === DEFAULT_PET_ID)
    ?? pets[0]
}

/** Build every route of the plugin. */
export function makeRoutes(deps: RouteDeps): WebRoute[] {
  const { tracker, library, settings } = deps

  const state: Handler = (req, res) => {
    if (!methodIs(req, res, 'GET')) return
    const current = settings.get()
    const entry = currentPet(library, current.petId)
    if (entry === undefined) {
      writeJson(res, 500, { ok: false, error: 'no-pets' })
      return
    }
    const body: StateResponse = {
      activity: tracker.snapshot(),
      settings: { ...current, petId: entry.manifest.id },
      pet: library.view(entry),
    }
    writeJson(res, 200, body)
  }

  const pets: Handler = (req, res) => {
    if (!methodIs(req, res, 'GET')) return
    const list: PetView[] = library.list().map(entry => library.view(entry))
    writeJson(res, 200, list)
  }

  const updateSettings: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    const patch = await readJson(req)
    if (typeof patch.petId === 'string' && library.get(patch.petId) === undefined) {
      writeJson(res, 400, { ok: false, error: 'pet-not-found' })
      return
    }
    writeJson(res, 200, { ok: true, settings: settings.update(patch) })
  }

  const importPet: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    const url = new URL(req.url ?? '/', 'http://dpet.local')
    const data = await readBody(req, IMPORT_LIMITS.glb)
    let asset
    try {
      asset = await processUpload(data, backgroundMode(url))
    } catch (error) {
      const body: ImportResponse = { ok: false, error: error instanceof Error ? error.message : String(error) }
      writeJson(res, 400, body)
      return
    }
    const name = cleanName(url.searchParams.get('name')) ?? (asset.report.kind === '3d' ? '3D 桌宠' : '桌宠')
    const source = cleanName(url.searchParams.get('source'))
    const entry = library.create({
      name,
      kind: kindOf(asset.report.format),
      file: asset.file,
      bytes: asset.report.finalBytes,
      ...(asset.report.finalTriangles === undefined ? {} : { triangles: asset.report.finalTriangles }),
      ...(source === undefined ? {} : { source }),
      createdAt: Date.now(),
    }, asset.data)
    const body: ImportResponse = { ok: true, pet: library.view(entry), report: asset.report }
    writeJson(res, 200, body)
  }

  // Process a picture exactly like an import would, but only hand the result
  // back (PNG body + JSON report header) so the page can show before / after.
  const previewImport: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    const url = new URL(req.url ?? '/', 'http://dpet.local')
    const data = await readBody(req, IMPORT_LIMITS.image)
    const format = sniffFormat(data)
    if (format === undefined || format === 'glb' || format === 'gif') throw new Error('unsupported-format')
    const asset = await processUpload(data, backgroundMode(url))
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(asset.data.byteLength),
      'cache-control': 'no-store',
      'x-dpet-report': JSON.stringify(asset.report),
    })
    res.end(asset.data)
  }

  // /api/dpet/pet/<id>/<action>
  const petAction: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    const segments = new URL(req.url ?? '/', 'http://dpet.local').pathname.split('/').filter(Boolean)
    const [id, action] = segments.slice(3).map(decodeURIComponent)
    if (id === undefined || action === undefined || segments.length !== 5) {
      writeJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (action === 'rename') {
      const name = cleanName((await readJson(req)).name)
      if (name === undefined) throw new Error('invalid-name')
      writeJson(res, 200, { ok: true, pet: library.view(library.rename(id, name)) })
    } else if (action === 'preview') {
      const png = await readBody(req, PREVIEW_MAX)
      const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
      if (!isPng) throw new Error('invalid-preview')
      writeJson(res, 200, { ok: true, pet: library.view(library.setPreview(id, png)) })
    } else if (action === 'delete') {
      library.remove(id)
      if (settings.get().petId === id) settings.update({ petId: DEFAULT_PET_ID })
      writeJson(res, 200, { ok: true })
    } else {
      writeJson(res, 404, { ok: false, error: 'not-found' })
    }
  }

  const runtime: Handler = async (req, res) => {
    if (!methodIs(req, res, 'GET', 'HEAD')) return
    const name = new URL(req.url ?? '/', 'http://dpet.local').pathname.slice((API_PREFIX + '/runtime/').length)
    if (!RUNTIME_FILES.has(name)) {
      res.writeHead(404)
      res.end()
      return
    }
    await sendFile(req, res, join(deps.vendorDir, name))
  }

  // /dpet/pets/<id>/<file>
  const petFile: Handler = async (req, res) => {
    if (!methodIs(req, res, 'GET', 'HEAD')) return
    const segments = new URL(req.url ?? '/', 'http://dpet.local').pathname.split('/').filter(Boolean)
    if (segments.length !== 4) {
      res.writeHead(404)
      res.end()
      return
    }
    let id: string
    let file: string
    try {
      id = decodeURIComponent(segments[2]!)
      file = decodeURIComponent(segments[3]!)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const path = library.servableFile(id, file)
    if (path === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    await sendFile(req, res, path)
  }

  return [
    { kind: 'exact', path: API_PREFIX + '/state', handler: guarded(state) },
    { kind: 'exact', path: API_PREFIX + '/pets', handler: guarded(pets) },
    { kind: 'exact', path: API_PREFIX + '/settings', handler: guarded(updateSettings) },
    { kind: 'exact', path: API_PREFIX + '/import', handler: guarded(importPet) },
    { kind: 'exact', path: API_PREFIX + '/import/preview', handler: guarded(previewImport) },
    { kind: 'prefix', path: API_PREFIX + '/pet', handler: guarded(petAction) },
    { kind: 'prefix', path: API_PREFIX + '/runtime', handler: guarded(runtime) },
    { kind: 'prefix', path: PET_FILE_PREFIX, handler: guarded(petFile) },
  ]
}
