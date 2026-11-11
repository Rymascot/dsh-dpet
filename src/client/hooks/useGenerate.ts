/**
 * The image-to-3D flow of the settings page, as a hook: connection status,
 * the picked picture, submitting, and the job list. Jobs are polled every
 * two seconds while one is running (and re-read whenever the store's job
 * brief changes); when a job finishes, the pet list is refreshed and the new
 * pet is handed to `onDone` so the page can show it.
 * @module dsh-dpet/client/hooks/useGenerate
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenerateJobView, GenerateModel, GenerateStateResponse } from '../../shared/types.ts'
import { api } from '../api/dpet.ts'
import { useDpet, type DpetStore } from '../store/dpet.ts'
import { nameOf } from '../utils/import-report.ts'

/** Poll interval while a job runs. */
const POLL_MS = 2000
/** Picture types the API takes. */
export const GENERATE_ACCEPT = '.png,.jpg,.jpeg,.webp'
const PICTURE = /\.(png|jpe?g|webp)$/i

const ACTIVE = new Set<GenerateJobView['status']>(['submitting', 'queued', 'running', 'downloading', 'importing'])

/** Whether a job is still in progress. */
export function isActive(job: GenerateJobView): boolean {
  return ACTIVE.has(job.status)
}

export interface GenerateError {
  code: string
  detail?: string
}

export interface GenerateFlow {
  state: GenerateStateResponse | undefined
  picked: { file: File; url: string } | undefined
  name: string
  model: GenerateModel
  submitting: boolean
  error: GenerateError | undefined
  busy: boolean
  pick(file: File): void
  unpick(): void
  setName(name: string): void
  setModel(model: GenerateModel): void
  submit(): Promise<void>
  dismiss(id: string): Promise<void>
  refresh(): Promise<void>
  /** Save keys; resolves to an error code, or undefined on success. */
  saveCredentials(body: Record<string, string>): Promise<string | undefined>
  clearCredentials(): Promise<void>
  check(): Promise<GenerateError | undefined>
}

export function useGenerate(store: DpetStore, onDone: (petId: string) => void): GenerateFlow {
  const [state, setState] = useState<GenerateStateResponse | undefined>(undefined)
  const [picked, setPicked] = useState<{ file: File; url: string } | undefined>(undefined)
  const [name, setName] = useState('')
  const [model, setModel] = useState<GenerateModel>('rapid')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<GenerateError | undefined>(undefined)
  const statuses = useRef(new Map<string, GenerateJobView['status']>())
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const refresh = useCallback(async (): Promise<void> => {
    let next: GenerateStateResponse
    try {
      next = await api.generateState()
    } catch {
      return
    }
    if (!Array.isArray(next.jobs)) return
    let finished: string | undefined
    for (const job of next.jobs) {
      const before = statuses.current.get(job.id)
      if (before !== undefined && before !== 'done' && job.status === 'done' && job.petId !== undefined) finished = job.petId
      statuses.current.set(job.id, job.status)
    }
    setState(next)
    if (finished !== undefined) {
      await store.refreshPets()
      onDoneRef.current(finished)
    }
  }, [store])

  const busy = state?.jobs.some(isActive) ?? false
  // The store polls the host every second and carries a brief of the running
  // job, so a job the AI started shows up here without a page reload.
  const brief = useDpet(store).state?.generation

  useEffect(() => { void refresh() }, [refresh, brief?.name, brief?.status])

  useEffect(() => {
    if (!busy) return undefined
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  // Release the object URL of a replaced or abandoned picture.
  useEffect(() => () => { if (picked !== undefined) URL.revokeObjectURL(picked.url) }, [picked])

  return {
    state,
    picked,
    name,
    model,
    submitting,
    error,
    busy,
    pick(file) {
      if (!PICTURE.test(file.name)) {
        setError({ code: 'unsupported-format' })
        return
      }
      setError(undefined)
      setPicked({ file, url: URL.createObjectURL(file) })
      setName(nameOf(file))
    },
    unpick() {
      setPicked(undefined)
      setError(undefined)
    },
    setName,
    setModel,
    async submit() {
      if (picked === undefined || submitting) return
      setSubmitting(true)
      setError(undefined)
      const result = await api.generate(picked.file, name.trim(), model)
      setSubmitting(false)
      if (!result.ok) {
        setError({ code: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) })
        await refresh()
        return
      }
      statuses.current.set(result.job.id, result.job.status)
      setPicked(undefined)
      setName('')
      await refresh()
    },
    async dismiss(id) {
      await api.dismissJob(id)
      await refresh()
    },
    refresh,
    async saveCredentials(body) {
      const result = await api.saveCredentials(body)
      if (!result.ok) return result.error ?? 'network'
      await refresh()
      return undefined
    },
    async clearCredentials() {
      await api.clearCredentials()
      await refresh()
    },
    async check() {
      const result = await api.checkConnection()
      return result.ok ? undefined : { code: result.error ?? 'network', ...(result.detail === undefined ? {} : { detail: result.detail }) }
    },
  }
}
