import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../repository/credentials.ts'
import { PetLibrary } from '../repository/library.ts'
import { SettingsStore } from '../repository/settings.ts'
import { Generator, type GeneratorOptions } from './generator.ts'
import { HunyuanError, mockClient, type HunyuanClient, type RemoteJob } from './hunyuan/client.ts'

const GLB = fileURLToPath(new URL('../../../assets/pets/dongdong/dongdong.glb', import.meta.url))

let dir: string
let generators: Generator[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dpet-gen-'))
})

afterEach(() => {
  for (const g of generators) g.dispose()
  generators = []
  rmSync(dir, { recursive: true, force: true })
})

function make(client: () => HunyuanClient | undefined, extra: Partial<GeneratorOptions> = {}): { generator: Generator; library: PetLibrary; settings: SettingsStore } {
  const library = new PetLibrary({ builtin: join(dir, 'builtin'), user: join(dir, 'pets') })
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const generator = new Generator({
    dir: join(dir, 'generate'),
    library,
    settings,
    credentials: new CredentialStore(join(dir, 'credentials.json'), {}),
    client,
    pollDelay: () => 5,
    ...extra,
  })
  generators.push(generator)
  return { generator, library, settings }
}

const picture = (): Promise<Buffer> =>
  sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } } }).png().toBuffer()

/** A client whose query answers come from a list. */
function scripted(answers: Array<RemoteJob | Error>, submit: () => Promise<string> = async () => 'remote-1'): HunyuanClient {
  return {
    method: 'tokenhub',
    submit,
    async query() {
      const next = answers.shift() ?? { state: 'running' }
      if (next instanceof Error) throw next
      return next
    },
    async check() {},
    async download() { return new Uint8Array(readFileSync(GLB)) },
  }
}

describe('Generator', () => {
  it('runs a job from picture to pet', async () => {
    const client = mockClient(GLB, 2)
    const { generator, library, settings } = make(() => client)
    const started = await generator.start(await picture(), { name: '小蓝', model: 'rapid', use: true })
    expect(started.status).toBe('queued')
    expect(started.inputUrl).toBe('/api/dpet/generate/job/' + started.id + '/input.png')
    expect(generator.brief()).toEqual({ name: '小蓝', status: 'queued' })
    const done = await generator.settled(started.id)
    expect(done.status).toBe('done')
    expect(done.report?.format).toBe('glb')
    const pet = library.get(done.petId!)
    expect(pet?.manifest.kind).toBe('3d')
    expect(pet?.manifest.name).toBe('小蓝')
    expect(pet?.manifest.source).toBe('腾讯混元 3D（演示模式）')
    expect(settings.get().petId).toBe(done.petId)
    expect(generator.brief()?.status).toBe('done')
  }, 60_000)

  it('leaves the current pet alone without use', async () => {
    const { generator, settings } = make(() => mockClient(GLB, 1))
    const before = settings.get().petId
    const job = await generator.start(await picture(), { name: 'x' })
    expect((await generator.settled(job.id)).status).toBe('done')
    expect(settings.get().petId).toBe(before)
  }, 60_000)

  it('refuses without credentials and while another job runs', async () => {
    const none = make(() => undefined).generator
    await expect(none.start(await picture(), {})).rejects.toMatchObject({ code: 'not-configured' })
    const { generator } = make(() => scripted([]))
    await generator.start(await picture(), {})
    await expect(generator.start(await picture(), {})).rejects.toThrow('busy')
  })

  it('records a failed submission with the remote message', async () => {
    const { generator } = make(() => scripted([], async () => { throw new HunyuanError('quota', 'ResourceInsufficient: 积分不足') }))
    const job = await generator.start(await picture(), { name: 'q' })
    expect(job.status).toBe('failed')
    expect(job.error).toBe('quota')
    expect(job.detail).toBe('ResourceInsufficient: 积分不足')
    // A failed job does not block the next one.
    await expect(generator.start(await picture(), {})).resolves.toBeDefined()
  })

  it('fails when Hunyuan reports a failure or returns no GLB', async () => {
    const script = scripted([{ state: 'running' }, { state: 'failed', code: 'ContentRisk', message: '内容不合规' }])
    const failed = make(() => script).generator
    const a = await failed.start(await picture(), {})
    expect(await failed.settled(a.id)).toMatchObject({ status: 'failed', error: 'rejected', detail: 'ContentRisk: 内容不合规' })
    const noGlb = make(() => scripted([{ state: 'done' }])).generator
    const b = await noGlb.start(await picture(), {})
    expect(await noGlb.settled(b.id)).toMatchObject({ status: 'failed', error: 'no-glb' })
  })

  it('retries network hiccups while polling', async () => {
    const answers: Array<RemoteJob | Error> = [new HunyuanError('network', 'reset'), { state: 'running' }, new HunyuanError('network', 'reset'), { state: 'done', glbUrl: 'https://cos/x.glb' }]
    const { generator } = make(() => scripted(answers))
    const job = await generator.start(await picture(), {})
    expect((await generator.settled(job.id)).status).toBe('done')
  }, 60_000)

  it('stops at once on an auth failure while polling', async () => {
    const { generator } = make(() => scripted([new HunyuanError('unauthorized', 'AuthFailure')]))
    const job = await generator.start(await picture(), {})
    expect(await generator.settled(job.id)).toMatchObject({ status: 'failed', error: 'unauthorized' })
  })

  it('persists jobs and resumes polling after a restart', async () => {
    const first = make(() => scripted([]), { pollDelay: () => 60_000 }).generator
    const job = await first.start(await picture(), { name: '续' })
    first.dispose()
    const { generator } = make(() => scripted([{ state: 'done', glbUrl: 'https://cos/x.glb' }]))
    expect(generator.get(job.id)?.status).toBe('queued')
    generator.resume()
    expect((await generator.settled(job.id)).status).toBe('done')
  }, 60_000)

  it('marks a job interrupted before submission as failed on resume', async () => {
    let release!: (id: string) => void
    const first = make(() => scripted([], () => new Promise<string>((resolve) => { release = resolve })), {}).generator
    const pending = first.start(await picture(), {})
    await new Promise(resolve => setTimeout(resolve, 50))
    first.dispose()
    const { generator } = make(() => scripted([]))
    const [stuck] = generator.list()
    expect(stuck?.status).toBe('submitting')
    generator.resume()
    expect(generator.get(stuck!.id)).toMatchObject({ status: 'failed', error: 'interrupted' })
    release('late')
    await pending.catch(() => undefined)
  })

  it('dismisses finished jobs only', async () => {
    const { generator } = make(() => scripted([], async () => { throw new HunyuanError('unauthorized') }))
    const failed = await generator.start(await picture(), {})
    generator.dismiss(failed.id)
    expect(generator.list()).toEqual([])
    const running = make(() => scripted([])).generator
    const active = await running.start(await picture(), {})
    expect(() => running.dismiss(active.id)).toThrow('job-active')
  })

  it('reports the connection status without secrets', () => {
    expect(make(() => undefined).generator.status()).toEqual({ configured: false })
    expect(make(() => undefined, { mock: true }).generator.status()).toEqual({ configured: true, method: 'mock', source: 'mock' })
  })
})
