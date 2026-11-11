/**
 * Image-to-3D jobs: picture → Tencent Hunyuan 3D → GLB → the regular import
 * pipeline (decimate, compress) → a new pet in the library.
 *
 * Jobs are kept in `$DSH_HOME/dpet/generate/jobs.json` with a thumbnail of
 * each input picture, so the settings page can list them and a DSH restart
 * resumes polling (a Hunyuan job id stays valid for 24 hours). Hunyuan runs
 * one job per account at a time by default, so a new job is refused while
 * another is still running.
 * @module dsh-dpet/server/service/generator
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../common/files.ts'
import type { CredentialStore } from '../repository/credentials.ts'
import { describeCredentials } from '../repository/credentials.ts'
import { cleanName, type PetLibrary } from '../repository/library.ts'
import type { SettingsStore } from '../repository/settings.ts'
import { IMPORT_LIMITS, processUpload } from './importer.ts'
import { HunyuanError, type HunyuanClient } from './hunyuan/client.ts'
import { prepareGenerateImage } from './hunyuan/image.ts'
import {
  GENERATE_MODELS,
  type GenerateJobStatus,
  type GenerateJobView,
  type GenerateModel,
  type GenerationBrief,
  type HunyuanStatus,
  type ImportReport,
} from '../../shared/types.ts'

/** Browser prefix of the job routes. */
export const JOB_PREFIX = '/api/dpet/generate/job'
/** Job records kept on disk. */
const MAX_JOBS = 20
/** A Hunyuan job id expires after 24 hours. */
const JOB_TTL_MS = 24 * 60 * 60 * 1000
/** Give up on a job that has not finished in this time. */
export const JOB_TIMEOUT_MS = 20 * 60 * 1000
/** Consecutive network failures tolerated while polling. */
const MAX_POLL_FAILURES = 8
/** How long a finished job keeps the floating pet's bubble. */
const BRIEF_AFTER_MS = 10_000

const ACTIVE: ReadonlySet<GenerateJobStatus> = new Set(['submitting', 'queued', 'running', 'downloading', 'importing'])

/** One job on disk. */
export interface JobRecord {
  id: string
  name: string
  model: GenerateModel
  status: GenerateJobStatus
  createdAt: number
  updatedAt: number
  finishedAt?: number
  /** Remote job id. */
  remoteId?: string
  /** The client method the job was submitted with. */
  method?: HunyuanClient['method']
  /** Show the new pet as soon as it is ready. */
  use?: boolean
  petId?: string
  error?: string
  detail?: string
  report?: ImportReport
}

export interface GeneratorOptions {
  /** Directory for jobs.json and input thumbnails. */
  dir: string
  library: PetLibrary
  settings: SettingsStore
  credentials: CredentialStore
  /** The client for the current credentials; undefined when not configured. */
  client: () => HunyuanClient | undefined
  /** Set when DPET_HUNYUAN_MOCK is on. */
  mock?: boolean
  now?: () => number
  /** Poll delay for a job of the given age. */
  pollDelay?: (ageMs: number) => number
}

/** 3 s for the first two minutes, then 6 s. */
function defaultPollDelay(ageMs: number): number {
  return ageMs < 120_000 ? 3000 : 6000
}

function isRecord(raw: unknown): raw is JobRecord {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return typeof r.id === 'string' && /^[a-z0-9]{6,32}$/.test(r.id)
    && typeof r.name === 'string'
    && GENERATE_MODELS.includes(r.model as GenerateModel)
    && typeof r.status === 'string'
    && typeof r.createdAt === 'number'
    && typeof r.updatedAt === 'number'
}

export class Generator {
  private jobs: JobRecord[] = []
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly failures = new Map<string, number>()
  private readonly waiters = new Map<string, Array<(job: GenerateJobView) => void>>()
  private readonly abort = new AbortController()
  private readonly now: () => number
  private readonly pollDelay: (ageMs: number) => number

  constructor(private readonly options: GeneratorOptions) {
    this.now = options.now ?? Date.now
    this.pollDelay = options.pollDelay ?? defaultPollDelay
    this.jobs = this.load()
  }

  // -- public -------------------------------------------------------------

  /** Connection status for the page (no secrets). */
  status(): HunyuanStatus {
    if (this.options.mock === true) return { configured: true, method: 'mock', source: 'mock' }
    return describeCredentials(this.options.credentials.resolve())
  }

  /** Every job, newest first. */
  list(): GenerateJobView[] {
    return [...this.jobs].sort((a, b) => b.createdAt - a.createdAt).map(job => this.view(job))
  }

  get(id: string): GenerateJobView | undefined {
    const job = this.jobs.find(j => j.id === id)
    return job === undefined ? undefined : this.view(job)
  }

  /** The running job, or one that just finished, for the floating pet. */
  brief(): GenerationBrief | undefined {
    const now = this.now()
    const job = this.jobs.find(j => ACTIVE.has(j.status))
      ?? this.jobs.filter(j => j.finishedAt !== undefined && now - j.finishedAt < BRIEF_AFTER_MS)
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
    if (job === undefined) return undefined
    return { name: job.name, status: job.status, ...(job.petId === undefined ? {} : { petId: job.petId }) }
  }

  /** Path of a job's input thumbnail, if it exists. */
  inputFile(id: string): string | undefined {
    if (!this.jobs.some(j => j.id === id)) return undefined
    const file = join(this.options.dir, id + '.png')
    return existsSync(file) ? file : undefined
  }

  /**
   * Start a job from a picture. Resolves once the job is submitted (or has
   * failed to submit); generation itself continues in the background.
   * Throws 'busy', 'not-configured', or a picture error before any job exists.
   */
  async start(input: Uint8Array, request: { name?: unknown; model?: unknown; use?: boolean }): Promise<GenerateJobView> {
    if (this.jobs.some(j => ACTIVE.has(j.status))) throw new Error('busy')
    const client = this.options.client()
    if (client === undefined) throw new HunyuanError('not-configured')
    const model: GenerateModel = request.model === 'pro' ? 'pro' : 'rapid'
    const image = await prepareGenerateImage(input)
    // Re-check: another start may have slipped in while the picture was prepared.
    if (this.jobs.some(j => ACTIVE.has(j.status))) throw new Error('busy')

    const now = this.now()
    const job: JobRecord = {
      id: randomBytes(8).toString('hex'),
      name: cleanName(request.name) ?? '3D 桌宠',
      model,
      status: 'submitting',
      createdAt: now,
      updatedAt: now,
      method: client.method,
      ...(request.use === true ? { use: true } : {}),
    }
    writeFileAtomic(join(this.options.dir, job.id + '.png'), image.thumbnail)
    this.jobs.push(job)
    this.prune()
    this.save()

    try {
      job.remoteId = await client.submit(image.base64, model, this.abort.signal)
      this.patch(job, { status: 'queued' })
      this.schedule(job, Math.min(1000, this.pollDelay(0)))
    } catch (error) {
      if (this.abort.signal.aborted) throw error
      this.fail(job, error)
    }
    return this.view(job)
  }

  /** Remove a finished job from the list. */
  dismiss(id: string): void {
    const job = this.jobs.find(j => j.id === id)
    if (job === undefined) throw new Error('job-not-found')
    if (ACTIVE.has(job.status)) throw new Error('job-active')
    this.jobs = this.jobs.filter(j => j.id !== id)
    rmSync(join(this.options.dir, id + '.png'), { force: true })
    this.save()
  }

  /** Resolve when a job reaches done or failed. */
  settled(id: string): Promise<GenerateJobView> {
    const job = this.jobs.find(j => j.id === id)
    if (job === undefined) return Promise.reject(new Error('job-not-found'))
    if (!ACTIVE.has(job.status)) return Promise.resolve(this.view(job))
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? []
      list.push(resolve)
      this.waiters.set(id, list)
    })
  }

  /** Pick up jobs that were running when DSH last stopped. */
  resume(): void {
    const now = this.now()
    for (const job of this.jobs) {
      if (!ACTIVE.has(job.status)) continue
      if (job.remoteId === undefined) {
        this.fail(job, new Error('interrupted'))
      } else if (now - job.createdAt > JOB_TTL_MS) {
        this.fail(job, new Error('timeout'))
      } else {
        this.schedule(job, 500)
      }
    }
  }

  /** Stop polling (jobs stay on disk and resume next time). */
  dispose(): void {
    this.abort.abort()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // -- internals ----------------------------------------------------------

  private view(job: JobRecord): GenerateJobView {
    return {
      id: job.id,
      name: job.name,
      model: job.model,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.petId === undefined ? {} : { petId: job.petId }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
      ...(job.report === undefined ? {} : { report: job.report }),
      ...(existsSync(join(this.options.dir, job.id + '.png')) ? { inputUrl: JOB_PREFIX + '/' + job.id + '/input.png' } : {}),
    }
  }

  private load(): JobRecord[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.options.dir, 'jobs.json'), 'utf8'))
      return Array.isArray(raw) ? raw.filter(isRecord) : []
    } catch {
      return []
    }
  }

  private save(): void {
    // After dispose a newer instance may own the file; leave it alone.
    if (this.abort.signal.aborted) return
    writeFileAtomic(join(this.options.dir, 'jobs.json'), JSON.stringify(this.jobs, null, 2) + '\n')
  }

  /** Keep the newest records; finished ones go first. */
  private prune(): void {
    while (this.jobs.length > MAX_JOBS) {
      const oldest = [...this.jobs].filter(j => !ACTIVE.has(j.status)).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest === undefined) break
      this.jobs = this.jobs.filter(j => j !== oldest)
      rmSync(join(this.options.dir, oldest.id + '.png'), { force: true })
    }
  }

  private patch(job: JobRecord, change: Partial<JobRecord>): void {
    Object.assign(job, change, { updatedAt: this.now() })
    this.save()
  }

  private finish(job: JobRecord, change: Partial<JobRecord>): void {
    const now = this.now()
    Object.assign(job, change, { updatedAt: now, finishedAt: now })
    this.timers.delete(job.id)
    this.failures.delete(job.id)
    this.save()
    const view = this.view(job)
    for (const resolve of this.waiters.get(job.id) ?? []) resolve(view)
    this.waiters.delete(job.id)
  }

  private fail(job: JobRecord, error: unknown): void {
    if (error instanceof HunyuanError) {
      this.finish(job, { status: 'failed', error: error.code, ...(error.detail === undefined ? {} : { detail: error.detail.slice(0, 300) }) })
    } else {
      this.finish(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private schedule(job: JobRecord, delay: number): void {
    if (this.abort.signal.aborted) return
    const timer = setTimeout(() => { void this.poll(job) }, delay)
    timer.unref?.()
    this.timers.set(job.id, timer)
  }

  private async poll(job: JobRecord): Promise<void> {
    this.timers.delete(job.id)
    if (this.abort.signal.aborted || !ACTIVE.has(job.status) || job.remoteId === undefined) return
    const age = this.now() - job.createdAt
    if (age > JOB_TIMEOUT_MS) {
      this.fail(job, new Error('timeout'))
      return
    }
    const client = this.options.client()
    if (client === undefined) {
      this.fail(job, new HunyuanError('not-configured'))
      return
    }
    if (job.method !== undefined && client.method !== job.method) {
      this.fail(job, new Error('credentials-changed'))
      return
    }
    try {
      const remote = await client.query(job.remoteId, job.model, this.abort.signal)
      this.failures.delete(job.id)
      if (remote.state === 'queued' || remote.state === 'running') {
        if (job.status !== remote.state) this.patch(job, { status: remote.state })
        this.schedule(job, this.pollDelay(age))
        return
      }
      if (remote.state === 'failed') {
        const detail = [remote.code, remote.message].filter(Boolean).join(': ')
        this.fail(job, new HunyuanError('rejected', detail === '' ? undefined : detail))
        return
      }
      if (remote.glbUrl === undefined) {
        this.fail(job, new HunyuanError('no-glb'))
        return
      }
      this.patch(job, { status: 'downloading' })
      const data = await client.download(remote.glbUrl, IMPORT_LIMITS.glb, this.abort.signal)
      this.patch(job, { status: 'importing' })
      const asset = await processUpload(data)
      if (asset.report.format !== 'glb') throw new HunyuanError('no-glb')
      const entry = this.options.library.create({
        name: job.name,
        kind: '3d',
        file: asset.file,
        bytes: asset.report.finalBytes,
        ...(asset.report.finalTriangles === undefined ? {} : { triangles: asset.report.finalTriangles }),
        source: client.method === 'mock' ? '腾讯混元 3D（演示模式）' : '腾讯混元 3D',
        createdAt: this.now(),
      }, asset.data)
      if (job.use === true) this.options.settings.update({ petId: entry.manifest.id, enabled: true })
      this.finish(job, { status: 'done', petId: entry.manifest.id, report: asset.report })
    } catch (error) {
      if (this.abort.signal.aborted) return
      const transient = error instanceof HunyuanError && (error.code === 'network' || error.code === 'remote-error' || error.code === 'rate-limited')
      const count = (this.failures.get(job.id) ?? 0) + 1
      if (transient && count < MAX_POLL_FAILURES) {
        // The remote result stays downloadable for a day: query and download again.
        this.failures.set(job.id, count)
        if (job.status !== 'queued' && job.status !== 'running') this.patch(job, { status: 'running' })
        this.schedule(job, this.pollDelay(age) * 2)
        return
      }
      this.fail(job, error)
    }
  }
}
