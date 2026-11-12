/**
 * Agent tools — let the DSH agent read and change the pet, so a user can say
 * "switch to the flat Dong Xiaolong, make it bigger, nod while thinking" in chat.
 * These are the AI-facing counterpart of ./routes.ts and go through the same
 * library, settings and import pipeline.
 *
 * The registration pattern (defineTool + ctx.tools.register, descriptions
 * that tell the model when to call and when not to) follows
 * hherosoul/dsh-task-pet (MIT).
 * @module dsh-dpet/server/controller/agent-tools
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ACTIVITY_PHASES, PET_MOTIONS, SETTINGS_LIMITS, type ActivityPhase, type DpetSettings, type PetMotion } from '../../shared/types.ts'
import { IMPORT_LIMITS, kindOf, processUpload } from '../service/importer.ts'
import { cleanName, type PetLibrary } from '../repository/library.ts'
import { DEFAULT_PET_ID, type SettingsStore } from '../repository/settings.ts'
import type { Generator } from '../service/generator.ts'
import { GENERATE_UPLOAD_LIMIT } from '../service/hunyuan/image.ts'
import { currentPet } from './routes.ts'

export interface AgentToolDeps {
  library: PetLibrary
  settings: SettingsStore
  /** Image-to-3D jobs; the generate tool is left out without it. */
  generator?: Pick<Generator, 'status' | 'list' | 'start'>
}

/** Built-in motion of each state (mirrors the client defaults). */
const DEFAULT_MOTIONS: Readonly<Record<ActivityPhase, PetMotion>> = {
  idle: 'bob',
  waiting: 'sway',
  thinking: 'spin',
  tool: 'hop',
  review: 'nod',
  done: 'cheer',
  failed: 'droop',
}

const PHASE_NOTES: Readonly<Record<ActivityPhase, string>> = {
  idle: 'idle (nothing running)',
  waiting: 'preparing a turn / waiting for approval',
  thinking: 'thinking (reasoning)',
  tool: 'running tools',
  review: 'writing the reply',
  done: 'turn finished',
  failed: 'turn failed',
}

const MOTION_NOTES: Readonly<Record<PetMotion, string>> = {
  bob: 'breathe gently',
  sway: 'look around',
  spin: 'turn around slowly',
  hop: 'hop',
  nod: 'nod',
  cheer: 'jump and turn once',
  droop: 'droop and bow',
  still: 'stand still',
}

const IMPORT_EXTENSIONS = new Set(['.glb', '.png', '.jpg', '.jpeg', '.webp', '.gif'])
const GENERATE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
/** Jobs listed by dpet_status. */
const STATUS_JOBS = 5

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('aborted')
}

/** Everything the agent needs to reason about the pet. */
export function describeState(deps: AgentToolDeps): Record<string, unknown> {
  const settings = deps.settings.get()
  const pets = deps.library.list()
  const current = currentPet(deps.library, settings.petId)
  return {
    shown: settings.enabled,
    current: current === undefined ? null : { id: current.manifest.id, name: current.manifest.name, kind: current.manifest.kind },
    appearance: {
      size: settings.size,
      opacity: settings.opacity,
      right: settings.right,
      bottom: settings.bottom,
      lookAtCursor: settings.lookAtCursor,
      bubbles: settings.bubbles,
    },
    motions: Object.fromEntries(ACTIVITY_PHASES.map(phase => [phase, settings.motions[phase] ?? DEFAULT_MOTIONS[phase]])),
    pets: pets.map(entry => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      kind: entry.manifest.kind,
      builtin: entry.builtin,
      ...(entry.manifest.source === undefined ? {} : { source: entry.manifest.source }),
    })),
    ...(deps.generator === undefined ? {} : { imageTo3d: describeGeneration(deps.generator) }),
  }
}

/** Image-to-3D connection and recent jobs (never secrets). */
function describeGeneration(generator: NonNullable<AgentToolDeps['generator']>): Record<string, unknown> {
  const status = generator.status()
  return {
    connected: status.configured,
    ...(status.method === undefined ? {} : { method: status.method }),
    recentJobs: generator.list().slice(0, STATUS_JOBS).map(job => ({
      id: job.id,
      name: job.name,
      model: job.model,
      status: job.status,
      ...(job.petId === undefined ? {} : { petId: job.petId }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
    })),
  }
}

function summary(state: Record<string, unknown>): string {
  return JSON.stringify(state, null, 2)
}

/** Build the agent tools over the shared library and settings. */
export function makeAgentTools(deps: AgentToolDeps): ToolDefinition[] {
  const { library, settings } = deps

  const status = defineTool({
    name: 'dpet_status',
    description:
      'Read the DPet desktop pet: whether it is shown, which pet is current, its size / opacity / position, ' +
      'the motion played in each agent state, and every pet in the library (built-in and imported). ' +
      'Call this before changing the pet, and whenever the user asks about their desktop pet (桌宠). ' +
      'Do not call it for unrelated questions.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: 'DPet state:\n' + summary(value as Record<string, unknown>) }],
    },
    async execute(_args, exec) {
      aborted(exec?.signal)
      return describeState(deps) as never
    },
  })

  const motionProperties = Object.fromEntries(ACTIVITY_PHASES.map(phase => [phase, {
    type: 'string' as const,
    enum: PET_MOTIONS,
    description: `Motion while the agent is ${PHASE_NOTES[phase]}.`,
  }]))

  const update = defineTool({
    name: 'dpet_update',
    description:
      'Change the DPet desktop pet. Every field is optional; only the fields given change. ' +
      'petId must be an id from dpet_status. Motions: ' +
      PET_MOTIONS.map(m => `${m} = ${MOTION_NOTES[m]}`).join(', ') + '. ' +
      'Agent states: ' + ACTIVITY_PHASES.map(p => `${p} = ${PHASE_NOTES[p]}`).join('; ') + '. ' +
      'Use it only when the user asks to change the pet.',
    parameters: {
      petId: { type: 'string', description: 'Pet to show (an id from dpet_status).' },
      shown: { type: 'boolean', description: 'Show (true) or hide (false) the floating pet.' },
      size: { type: 'integer', description: `Pet height in px, ${SETTINGS_LIMITS.size.min}-${SETTINGS_LIMITS.size.max}. "Bigger" is about +40.` },
      opacity: { type: 'number', description: `Opacity, ${SETTINGS_LIMITS.opacity.min}-1.` },
      right: { type: 'integer', description: 'Distance from the window right edge, px. A large value such as 4000 clamps to the left edge.' },
      bottom: { type: 'integer', description: 'Distance from the window bottom edge, px. A large value such as 4000 clamps to the top edge.' },
      lookAtCursor: { type: 'boolean', description: 'Turn slightly toward the mouse pointer.' },
      bubbles: { type: 'boolean', description: 'Show status bubbles such as "thinking…".' },
      motions: {
        type: 'object',
        additionalProperties: false,
        properties: motionProperties,
        description: 'Per-state motion overrides; states not listed keep their current motion.',
      },
      resetMotions: { type: 'boolean', description: 'Restore the default motion of every state (applied before motions).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: 'DPet updated. New state:\n' + summary(value as Record<string, unknown>) }],
    },
    async execute(args, exec) {
      aborted(exec?.signal)
      if (args.petId !== undefined && library.get(args.petId) === undefined) {
        throw new Error(`Unknown pet id "${args.petId}". Call dpet_status for the list of pets.`)
      }
      const current = settings.get()
      const motions: DpetSettings['motions'] = args.resetMotions === true ? {} : { ...current.motions }
      for (const [phase, motion] of Object.entries(args.motions ?? {})) {
        if (motion !== undefined) motions[phase as ActivityPhase] = motion as PetMotion
      }
      settings.update({
        ...(args.petId === undefined ? {} : { petId: args.petId }),
        ...(args.shown === undefined ? {} : { enabled: args.shown }),
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.opacity === undefined ? {} : { opacity: args.opacity }),
        ...(args.right === undefined ? {} : { right: args.right }),
        ...(args.bottom === undefined ? {} : { bottom: args.bottom }),
        ...(args.lookAtCursor === undefined ? {} : { lookAtCursor: args.lookAtCursor }),
        ...(args.bubbles === undefined ? {} : { bubbles: args.bubbles }),
        motions,
      })
      return describeState(deps) as never
    },
  })

  const importPet = defineTool({
    name: 'dpet_import',
    description:
      'Turn a local file into a new DPet pet: a 3D model (.glb) or a picture (.png .jpg .jpeg .webp .gif). ' +
      'Models are simplified and compressed automatically; a plain single-color picture background is removed ' +
      'unless background is "keep". Pass the absolute path the user gave you. ' +
      'Use it only when the user asks to make a pet from a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the .glb / .png / .jpg / .jpeg / .webp / .gif file.' },
      name: { type: 'string', description: 'Display name; defaults to the file name.' },
      background: { type: 'string', enum: ['remove', 'keep'], description: 'Pictures only: remove a plain background (default) or keep it.' },
      use: { type: 'boolean', description: 'Show the new pet right away (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: 'DPet import finished:\n' + summary(value as Record<string, unknown>) }],
    },
    async execute(args, exec) {
      aborted(exec?.signal)
      if (!isAbsolute(args.path)) throw new Error('path must be absolute.')
      if (!IMPORT_EXTENSIONS.has(extname(args.path).toLowerCase())) {
        throw new Error('Unsupported file type. Use .glb for 3D, or .png .jpg .jpeg .webp .gif for 2D.')
      }
      const info = await stat(args.path).catch(() => undefined)
      if (info === undefined || !info.isFile()) throw new Error(`File not found: ${args.path}`)
      const limit = extname(args.path).toLowerCase() === '.glb' ? IMPORT_LIMITS.glb : IMPORT_LIMITS.image
      if (info.size > limit) throw new Error(`File too large (${info.size} bytes, limit ${limit}).`)
      const asset = await processUpload(new Uint8Array(await readFile(args.path)), args.background === 'keep' ? 'keep' : 'remove')
      aborted(exec?.signal)
      const name = cleanName(args.name) ?? cleanName(basename(args.path, extname(args.path))) ?? 'pet'
      const entry = library.create({
        name,
        kind: kindOf(asset.report.format),
        file: asset.file,
        bytes: asset.report.finalBytes,
        ...(asset.report.finalTriangles === undefined ? {} : { triangles: asset.report.finalTriangles }),
        createdAt: Date.now(),
      }, asset.data)
      if (args.use !== false) settings.update({ petId: entry.manifest.id, enabled: true })
      return {
        pet: { id: entry.manifest.id, name: entry.manifest.name, kind: entry.manifest.kind },
        report: asset.report,
        shown: args.use !== false,
      } as never
    },
  })

  const manage = defineTool({
    name: 'dpet_manage_pet',
    description:
      'Rename or delete a pet the user imported (built-in pets cannot be changed). ' +
      'Delete is permanent: use it only when the user explicitly asks to delete that pet.',
    parameters: {
      petId: { type: 'string', required: true, description: 'An imported pet id from dpet_status.' },
      action: { type: 'string', enum: ['rename', 'delete'], required: true },
      name: { type: 'string', description: 'New display name (rename only).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: `DPet ${args.action} done:\n` + summary(value as Record<string, unknown>) }],
    },
    async execute(args, exec) {
      aborted(exec?.signal)
      const entry = library.get(args.petId)
      if (entry === undefined) throw new Error(`Unknown pet id "${args.petId}". Call dpet_status for the list of pets.`)
      if (entry.builtin) throw new Error('Built-in pets cannot be renamed or deleted.')
      if (args.action === 'rename') {
        const name = cleanName(args.name)
        if (name === undefined) throw new Error('rename needs a non-empty name.')
        library.rename(args.petId, name)
      } else {
        library.remove(args.petId)
        if (settings.get().petId === args.petId) settings.update({ petId: DEFAULT_PET_ID })
      }
      return describeState(deps) as never
    },
  })

  const tools: ToolDefinition[] = [status, update, importPet, manage]
  const generator = deps.generator
  if (generator === undefined) return tools

  const generate = defineTool({
    name: 'dpet_generate_3d',
    description:
      'Turn a local picture (.png .jpg .jpeg .webp) into a 3D desktop pet with Tencent Hunyuan 3D, using the key ' +
      'the user saved in DSH Settings → 桌宠 → AI 生成 3D. Each job spends the user\'s Tencent Cloud credits, so call it ' +
      'only when the user explicitly asks to generate a 3D model or 3D pet from a picture. The job runs in the background ' +
      '(about 1-3 minutes for rapid, longer for pro); the pet appears in the library when done. Check progress with dpet_status. ' +
      'If it reports not-configured, tell the user to open Settings → 桌宠 and connect Tencent Hunyuan there. ' +
      'Never ask the user to paste API keys or secrets into the chat.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the picture. A subject on a plain or transparent background works best.' },
      name: { type: 'string', description: 'Display name of the new pet; defaults to the file name.' },
      model: { type: 'string', enum: ['rapid', 'pro'], description: 'rapid (default): faster and cheaper. pro: finer detail, slower, more credits.' },
      use: { type: 'boolean', description: 'Show the new pet as soon as it is ready (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: 'DPet image-to-3D:\n' + summary(value as Record<string, unknown>) }],
    },
    async execute(args, exec) {
      aborted(exec?.signal)
      if (!isAbsolute(args.path)) throw new Error('path must be absolute.')
      if (!GENERATE_EXTENSIONS.has(extname(args.path).toLowerCase())) throw new Error('Use a .png, .jpg, .jpeg or .webp picture.')
      const info = await stat(args.path).catch(() => undefined)
      if (info === undefined || !info.isFile()) throw new Error(`File not found: ${args.path}`)
      if (info.size > GENERATE_UPLOAD_LIMIT) throw new Error(`Picture too large (${info.size} bytes, limit ${GENERATE_UPLOAD_LIMIT}).`)
      if (!generator.status().configured) {
        throw new Error('not-configured: Tencent Hunyuan is not connected. Ask the user to open DSH Settings → 桌宠 → AI 生成 3D and save their key there (never in chat).')
      }
      const name = cleanName(args.name) ?? cleanName(basename(args.path, extname(args.path))) ?? '3D pet'
      let job
      try {
        job = await generator.start(new Uint8Array(await readFile(args.path)), { name, model: args.model ?? 'rapid', use: args.use !== false })
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error)
        if (code === 'busy') throw new Error('busy: another image-to-3D job is still running (Hunyuan runs one at a time). Check dpet_status and try again when it finishes.')
        throw error
      }
      if (job.status === 'failed') {
        throw new Error(`Submitting to Tencent Hunyuan failed: ${job.error ?? 'error'}${job.detail === undefined ? '' : ' (' + job.detail + ')'}`)
      }
      return {
        job: { id: job.id, name: job.name, model: job.model, status: job.status },
        note: 'Generation runs in the background. The new pet appears in the library when done' +
          (args.use !== false ? ' and is shown right away' : '') + '. Use dpet_status to check progress.',
      } as never
    },
  })

  return [...tools, generate]
}
