/**
 * Same-origin client for the host routes.
 * @module dsh-dpet/client/api
 */

import type { BackgroundMode, DpetSettings, ImportReport, ImportResponse, PetView, StateResponse } from '../types.ts'

const API = '/api/dpet'

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({ ok: false, error: 'network' })) as T & { ok?: boolean; error?: string }
  if (!response.ok && body.error === undefined) throw new Error('http-' + response.status)
  return body
}

async function post<T>(path: string, body: BodyInit, contentType: string): Promise<T> {
  const response = await fetch(API + path, { method: 'POST', headers: { 'content-type': contentType }, body })
  return json<T>(response)
}

export const api = {
  state: async (): Promise<StateResponse> => json<StateResponse>(await fetch(API + '/state')),
  pets: async (): Promise<PetView[]> => json<PetView[]>(await fetch(API + '/pets')),
  updateSettings: (patch: Partial<DpetSettings>) =>
    post<{ ok: boolean; settings?: DpetSettings; error?: string }>('/settings', JSON.stringify(patch), 'application/json'),
  /** Process a picture like an import would and return the result without creating a pet. */
  previewImport: async (file: Blob): Promise<{ ok: true; image: Blob; report: ImportReport } | { ok: false; error: string }> => {
    try {
      const response = await fetch(API + '/import/preview', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'network' })) as { error?: string }
        return { ok: false, error: body.error ?? 'network' }
      }
      const report = JSON.parse(response.headers.get('x-dpet-report') ?? '{}') as ImportReport
      return { ok: true, image: await response.blob(), report }
    } catch {
      return { ok: false, error: 'network' }
    }
  },
  /** Upload through XHR so large models can report upload progress (0..1). */
  importFile: (file: Blob, name: string, background: BackgroundMode, onProgress?: (ratio: number) => void) =>
    new Promise<ImportResponse>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', API + '/import?name=' + encodeURIComponent(name) + '&background=' + background)
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
      xhr.onload = () => {
        try {
          resolve(JSON.parse(xhr.responseText) as ImportResponse)
        } catch {
          resolve({ ok: false, error: 'network' })
        }
      }
      xhr.onerror = () => resolve({ ok: false, error: 'network' })
      xhr.send(file)
    }),
  rename: (id: string, name: string) =>
    post<{ ok: boolean; pet?: PetView; error?: string }>('/pet/' + encodeURIComponent(id) + '/rename', JSON.stringify({ name }), 'application/json'),
  setPreview: (id: string, png: Blob) =>
    post<{ ok: boolean; pet?: PetView; error?: string }>('/pet/' + encodeURIComponent(id) + '/preview', png, 'image/png'),
  remove: (id: string) =>
    post<{ ok: boolean; error?: string }>('/pet/' + encodeURIComponent(id) + '/delete', '{}', 'application/json'),
}
