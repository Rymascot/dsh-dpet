/**
 * Tencent Hunyuan 3D clients: submit an image-to-3D job, poll it, download
 * the GLB. Two official ways in, behind one interface:
 *
 * - TokenHub (Tencent's recommended platform for Hunyuan now): an API key
 *   sent as `Authorization: Bearer`. Models hy-3d-express (rapid) and
 *   hy-3d-3.0 (pro). https://cloud.tencent.com/document/product/1823/137175
 * - Tencent Cloud API 3.0 (ai3d.tencentcloudapi.com, 2025-05-13): a
 *   SecretId / SecretKey pair with TC3 signing. Submit/QueryHunyuanTo3DRapidJob
 *   and Submit/QueryHunyuanTo3DProJob.
 *   https://cloud.tencent.com/document/api/1804/123463
 *
 * A third, mock client answers from a local GLB without any network access,
 * for development and demos (DPET_HUNYUAN_MOCK=1).
 * @module dsh-dpet/server/service/hunyuan/client
 */

import { readFile } from 'node:fs/promises'
import type { GenerateModel } from '../../../shared/types.ts'
import type { HunyuanCredentials } from '../../repository/credentials.ts'
import { tc3Headers } from './tc3.ts'

/** Remote job state, normalized across the two APIs. */
export type RemoteState = 'queued' | 'running' | 'done' | 'failed'

export interface RemoteJob {
  state: RemoteState
  /** Download URL of the GLB file, when done. */
  glbUrl?: string
  /** Remote failure code and message, when failed. */
  code?: string
  message?: string
}

/** Error codes the settings page localizes. */
export type HunyuanErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'quota'
  | 'rejected'
  | 'remote-error'
  | 'network'
  | 'no-glb'
  | 'download-too-large'

export class HunyuanError extends Error {
  constructor(readonly code: HunyuanErrorCode, readonly detail?: string) {
    super(code)
    this.name = 'HunyuanError'
  }
}

export interface HunyuanClient {
  readonly method: HunyuanCredentials['method'] | 'mock'
  /** Submit a picture; resolves to the remote job id. */
  submit(imageBase64: string, model: GenerateModel, signal?: AbortSignal): Promise<string>
  query(jobId: string, model: GenerateModel, signal?: AbortSignal): Promise<RemoteJob>
  /** Cheap credential check (queries a job that does not exist; costs nothing). */
  check(signal?: AbortSignal): Promise<void>
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Per-request time limit for API calls. */
const API_TIMEOUT_MS = 30_000
/** Time limit for downloading the model. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Run a fetch, turning transport failures into HunyuanError('network'). */
async function send(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init)
  } catch (error) {
    if ((init.signal as AbortSignal | undefined)?.aborted === true && (error as Error)?.name === 'AbortError') throw error
    throw new HunyuanError('network', error instanceof Error ? error.message : String(error))
  }
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Pick the GLB entry out of a result file list ({type|Type, url|Url}). */
export function pickGlb(files: unknown): string | undefined {
  if (!Array.isArray(files)) return undefined
  for (const file of files) {
    if (typeof file !== 'object' || file === null) continue
    const f = file as Record<string, unknown>
    const type = str(f.type) ?? str(f.Type)
    const url = str(f.url) ?? str(f.Url)
    if (type?.toLowerCase() === 'glb' && url !== undefined) return url
  }
  return undefined
}

/** Download over HTTPS with a byte ceiling. */
export async function downloadBytes(fetchImpl: FetchLike, url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HunyuanError('remote-error', 'bad download url')
  }
  if (parsed.protocol !== 'https:') throw new HunyuanError('remote-error', 'download url is not https')
  const response = await send(fetchImpl, url, { signal: withTimeout(signal, DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new HunyuanError('remote-error', 'download HTTP ' + response.status)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new HunyuanError('download-too-large')
  if (response.body === null) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > maxBytes) throw new HunyuanError('download-too-large')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof HunyuanError) throw error
    throw new HunyuanError('network', error instanceof Error ? error.message : String(error))
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// TokenHub

export const TOKENHUB_BASE = 'https://tokenhub.tencentmaas.com/v1/api/3d'

const TOKENHUB_MODELS: Readonly<Record<GenerateModel, string>> = {
  rapid: 'hy-3d-express',
  pro: 'hy-3d-3.0',
}

/** Map a TokenHub error (HTTP status + OpenAI-style error body). */
export function tokenHubError(status: number, body: Record<string, unknown>): HunyuanError {
  const error = typeof body.error === 'object' && body.error !== null ? body.error as Record<string, unknown> : {}
  const code = str(error.code) ?? str(error.type) ?? str(body.code) ?? ''
  const message = str(error.message) ?? str(body.message) ?? str(body.error) ?? (status === 0 ? '' : 'HTTP ' + status)
  const detail = [code, message].filter(Boolean).join(': ') || undefined
  if (status === 401) return new HunyuanError('unauthorized', detail)
  if (status === 403) return new HunyuanError('forbidden', detail)
  if (status === 429) return new HunyuanError('rate-limited', detail)
  if (status === 402) return new HunyuanError('quota', detail)
  const hay = (code + ' ' + message).toLowerCase()
  if (/quota|balance|insufficient|arrear|credit|余额|额度|欠费/.test(hay)) return new HunyuanError('quota', detail)
  if (/rate|limit|concurren|并发/.test(hay)) return new HunyuanError('rate-limited', detail)
  if (/auth|api.?key|unauthori/.test(hay)) return new HunyuanError('unauthorized', detail)
  if (status >= 500) return new HunyuanError('remote-error', detail)
  return new HunyuanError('rejected', detail)
}

export function tokenHubClient(apiKey: string, fetchImpl: FetchLike = fetch, base: string = TOKENHUB_BASE): HunyuanClient {
  const call = async (path: 'submit' | 'query', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const response = await send(fetchImpl, base + '/' + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(signal, API_TIMEOUT_MS),
    })
    const json = await readJsonBody(response)
    if (!response.ok || (json.error !== undefined && json.error !== null && json.status === undefined)) {
      throw tokenHubError(response.ok ? 0 : response.status, json)
    }
    return json
  }

  const query = async (jobId: string, model: GenerateModel, signal?: AbortSignal): Promise<RemoteJob> => {
    const json = await call('query', { model: TOKENHUB_MODELS[model], id: jobId }, signal)
    const status = str(json.status)?.toLowerCase()
    if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
      const glbUrl = pickGlb(json.data)
      return { state: 'done', ...(glbUrl === undefined ? {} : { glbUrl }) }
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const error = typeof json.error === 'object' && json.error !== null ? json.error as Record<string, unknown> : {}
      const code = str(error.code) ?? str(json.error_code)
      const message = str(error.message) ?? str(json.error_message) ?? str(json.message)
      return { state: 'failed', ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
    }
    if (status === 'in_progress' || status === 'running' || status === 'processing') return { state: 'running' }
    return { state: 'queued' }
  }

  return {
    method: 'tokenhub',
    async submit(imageBase64, model, signal) {
      const json = await call('submit', {
        model: TOKENHUB_MODELS[model],
        image_base64: imageBase64,
        // The rapid model defaults to OBJ; the pro model returns OBJ + GLB by default.
        ...(model === 'rapid' ? { result_format: 'glb' } : {}),
      }, signal)
      const id = str(json.id) ?? (typeof json.id === 'number' ? String(json.id) : undefined)
      if (id === undefined) throw new HunyuanError('remote-error', 'no job id in response')
      return id
    },
    query,
    async check(signal) {
      try {
        await query('0', 'rapid', signal)
      } catch (error) {
        if (error instanceof HunyuanError && error.code === 'rejected') return
        throw error
      }
    },
    download: (url, maxBytes, signal) => downloadBytes(fetchImpl, url, maxBytes, signal),
  }
}

// ---------------------------------------------------------------------------
// Tencent Cloud API 3.0

export const AI3D_HOST = 'ai3d.tencentcloudapi.com'
export const AI3D_VERSION = '2025-05-13'

const AI3D_ACTIONS: Readonly<Record<GenerateModel, { submit: string; query: string }>> = {
  rapid: { submit: 'SubmitHunyuanTo3DRapidJob', query: 'QueryHunyuanTo3DRapidJob' },
  pro: { submit: 'SubmitHunyuanTo3DProJob', query: 'QueryHunyuanTo3DProJob' },
}

/** Map a Tencent Cloud error code (Response.Error.Code). */
export function tencentCloudError(code: string, message: string | undefined): HunyuanError {
  const detail = message === undefined ? code : code + ': ' + message
  if (code.startsWith('AuthFailure')) return new HunyuanError('unauthorized', detail)
  if (code.startsWith('UnauthorizedOperation')) return new HunyuanError('forbidden', detail)
  if (code.startsWith('LimitExceeded') || code === 'RequestLimitExceeded' || code.startsWith('RequestLimitExceeded')) {
    return new HunyuanError('rate-limited', detail)
  }
  if (code.startsWith('ResourceInsufficient') || code.startsWith('ResourceUnavailable') || code.startsWith('ResourcesSoldOut') || /arrear|balance|quota/i.test(code)) {
    return new HunyuanError('quota', detail)
  }
  if (code.startsWith('InvalidParameter') || code.startsWith('MissingParameter') || code.startsWith('UnsupportedOperation') || code.startsWith('UnknownParameter')) {
    return new HunyuanError('rejected', detail)
  }
  return new HunyuanError('remote-error', detail)
}

export function tencentCloudClient(
  credentials: { secretId: string; secretKey: string; region: string },
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): HunyuanClient {
  const call = async (action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const payload = JSON.stringify(body)
    const headers = tc3Headers({
      ...credentials,
      service: 'ai3d',
      host: AI3D_HOST,
      action,
      version: AI3D_VERSION,
      payload,
      timestamp: Math.floor(now() / 1000),
    })
    const response = await send(fetchImpl, 'https://' + AI3D_HOST + '/', {
      method: 'POST',
      headers,
      body: payload,
      signal: withTimeout(signal, API_TIMEOUT_MS),
    })
    const json = await readJsonBody(response)
    const inner = typeof json.Response === 'object' && json.Response !== null ? json.Response as Record<string, unknown> : undefined
    if (inner === undefined) throw new HunyuanError(response.status >= 500 ? 'remote-error' : 'network', 'HTTP ' + response.status)
    const error = typeof inner.Error === 'object' && inner.Error !== null ? inner.Error as Record<string, unknown> : undefined
    if (error !== undefined) throw tencentCloudError(str(error.Code) ?? 'UnknownError', str(error.Message))
    return inner
  }

  const query = async (jobId: string, model: GenerateModel, signal?: AbortSignal): Promise<RemoteJob> => {
    const json = await call(AI3D_ACTIONS[model].query, { JobId: jobId }, signal)
    const status = str(json.Status)?.toUpperCase()
    if (status === 'DONE') {
      const glbUrl = pickGlb(json.ResultFile3Ds)
      return { state: 'done', ...(glbUrl === undefined ? {} : { glbUrl }) }
    }
    if (status === 'FAIL') {
      const code = str(json.ErrorCode)
      const message = str(json.ErrorMessage)
      return { state: 'failed', ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
    }
    if (status === 'RUN') return { state: 'running' }
    return { state: 'queued' }
  }

  return {
    method: 'tencentcloud',
    async submit(imageBase64, model, signal) {
      const json = await call(AI3D_ACTIONS[model].submit, {
        ImageBase64: imageBase64,
        // Rapid defaults to OBJ; pro returns OBJ + GLB unless a format is named.
        ...(model === 'rapid' ? { ResultFormat: 'GLB' } : {}),
      }, signal)
      const id = str(json.JobId)
      if (id === undefined) throw new HunyuanError('remote-error', 'no JobId in response')
      return id
    },
    query,
    async check(signal) {
      try {
        await query('0', 'rapid', signal)
      } catch (error) {
        if (error instanceof HunyuanError && error.code === 'rejected') return
        throw error
      }
    },
    download: (url, maxBytes, signal) => downloadBytes(fetchImpl, url, maxBytes, signal),
  }
}

// ---------------------------------------------------------------------------
// Mock

/** Download URL the mock client hands out. */
export const MOCK_GLB_URL = 'mock:glb'

/**
 * A client that never touches the network: jobs queue, run, and finish with
 * the GLB at `glbPath` after `steps` polls.
 */
export function mockClient(glbPath: string, steps = 3): HunyuanClient {
  const polls = new Map<string, number>()
  let next = 1
  return {
    method: 'mock',
    async submit() {
      const id = 'mock-' + Date.now().toString(36) + '-' + next++
      polls.set(id, 0)
      return id
    },
    async query(jobId) {
      const n = (polls.get(jobId) ?? steps) + 1
      polls.set(jobId, n)
      if (n >= steps) return { state: 'done', glbUrl: MOCK_GLB_URL }
      return { state: n === 1 ? 'queued' : 'running' }
    },
    async check() {},
    async download(url, maxBytes) {
      if (url !== MOCK_GLB_URL) throw new HunyuanError('remote-error', 'unknown mock url')
      const data = await readFile(glbPath)
      if (data.byteLength > maxBytes) throw new HunyuanError('download-too-large')
      return new Uint8Array(data)
    },
  }
}

/** The client for a set of credentials. */
export function clientFor(credentials: HunyuanCredentials, fetchImpl: FetchLike = fetch): HunyuanClient {
  return credentials.method === 'tokenhub'
    ? tokenHubClient(credentials.apiKey, fetchImpl)
    : tencentCloudClient(credentials, fetchImpl)
}
