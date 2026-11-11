/**
 * Image-to-3D routes.
 *
 *   GET  /api/dpet/generate                       connection status + jobs
 *   POST /api/dpet/generate?name=&model=rapid|pro raw picture -> new job
 *   POST /api/dpet/generate/credentials           { method, apiKey | secretId, secretKey, region } or { clear: true }
 *   POST /api/dpet/generate/check                 verify the saved key with Tencent Cloud (free)
 *   POST /api/dpet/generate/job/<id>/dismiss      drop a finished job from the list
 *   GET  /api/dpet/generate/job/<id>/input.png    thumbnail of the job's picture
 *
 * Secrets travel only browser -> host (same origin, loopback) and host ->
 * Tencent Cloud; no route ever returns them.
 * @module dsh-dpet/server/controller/generate-routes
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { guarded, methodIs, readBody, readJson, sendFile, writeJson, type Handler } from '../common/http.ts'
import type { CredentialStore } from '../repository/credentials.ts'
import { JOB_PREFIX, type Generator } from '../service/generator.ts'
import { HunyuanError } from '../service/hunyuan/client.ts'
import { GENERATE_UPLOAD_LIMIT } from '../service/hunyuan/image.ts'
import type { GenerateResponse, GenerateStateResponse } from '../../shared/types.ts'

export const GENERATE_PATH = '/api/dpet/generate'

export interface GenerateRouteDeps {
  generator: Generator
  credentials: CredentialStore
  /** Builds a client for checking; same factory the generator uses. */
  check: () => Promise<void>
}

function errorBody(error: unknown): { ok: false; error: string; detail?: string } {
  if (error instanceof HunyuanError) return { ok: false, error: error.code, ...(error.detail === undefined ? {} : { detail: error.detail.slice(0, 300) }) }
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export function makeGenerateRoutes(deps: GenerateRouteDeps): WebRoute[] {
  const { generator, credentials } = deps

  const root: Handler = async (req, res) => {
    if (!methodIs(req, res, 'GET', 'POST')) return
    if (req.method === 'GET') {
      const body: GenerateStateResponse = { hunyuan: generator.status(), jobs: generator.list() }
      writeJson(res, 200, body)
      return
    }
    const url = new URL(req.url ?? '/', 'http://dpet.local')
    const data = await readBody(req, GENERATE_UPLOAD_LIMIT)
    try {
      const job = await generator.start(data, {
        name: url.searchParams.get('name'),
        model: url.searchParams.get('model'),
        use: url.searchParams.get('use') === '1',
      })
      const body: GenerateResponse = { ok: true, job }
      writeJson(res, 200, body)
    } catch (error) {
      const body = errorBody(error)
      writeJson(res, body.error === 'busy' ? 409 : 400, body)
    }
  }

  const saveCredentials: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    const body = await readJson(req)
    if (body.clear === true) {
      credentials.clear()
    } else {
      credentials.save(body)
    }
    writeJson(res, 200, { ok: true, hunyuan: generator.status() })
  }

  const check: Handler = async (req, res) => {
    if (!methodIs(req, res, 'POST')) return
    try {
      await deps.check()
      writeJson(res, 200, { ok: true })
    } catch (error) {
      writeJson(res, 200, errorBody(error))
    }
  }

  // /api/dpet/generate/job/<id>/<action>
  const job: Handler = async (req, res) => {
    const segments = new URL(req.url ?? '/', 'http://dpet.local').pathname.split('/').filter(Boolean)
    const [id, action] = segments.slice(4)
    if (segments.length !== 6 || id === undefined || action === undefined || !/^[a-z0-9]{6,32}$/.test(id)) {
      writeJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (action === 'input.png') {
      if (!methodIs(req, res, 'GET', 'HEAD')) return
      const file = generator.inputFile(id)
      if (file === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await sendFile(req, res, file)
      return
    }
    if (action === 'dismiss') {
      if (!methodIs(req, res, 'POST')) return
      generator.dismiss(id)
      writeJson(res, 200, { ok: true })
      return
    }
    writeJson(res, 404, { ok: false, error: 'not-found' })
  }

  return [
    { kind: 'exact', path: GENERATE_PATH, handler: guarded(root) },
    { kind: 'exact', path: GENERATE_PATH + '/credentials', handler: guarded(saveCredentials) },
    { kind: 'exact', path: GENERATE_PATH + '/check', handler: guarded(check) },
    { kind: 'prefix', path: JOB_PREFIX, handler: guarded(job) },
  ]
}
