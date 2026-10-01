import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PetLibrary } from '../repository/library.ts'
import { SettingsStore } from '../repository/settings.ts'
import { makeAgentTools } from './agent-tools.ts'

const pkg = fileURLToPath(new URL('../../../', import.meta.url))
const flatPng = join(pkg, 'assets', 'pets', 'dongdong-flat', 'dongdong.png')

let dir: string
let tools: Record<string, ToolDefinition>
let settings: SettingsStore
let library: PetLibrary

/** Run a tool the way the registry would (validated args, an execution context). */
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return await tools[name]!.execute(args, { signal: new AbortController().signal } as never) as Record<string, any>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dpet-tools-'))
  const builtin = join(dir, 'builtin')
  for (const [id, kind, file] of [['dongdong', '3d', 'model.glb'], ['dongdong-flat', '2d', 'dongdong.png']] as const) {
    mkdirSync(join(builtin, id), { recursive: true })
    writeFileSync(join(builtin, id, 'pet.json'), JSON.stringify({ id, name: id, kind, file }))
    if (file === 'dongdong.png') copyFileSync(flatPng, join(builtin, id, file))
    else writeFileSync(join(builtin, id, file), 'glTF')
  }
  library = new PetLibrary({ builtin, user: join(dir, 'user') })
  settings = new SettingsStore(join(dir, 'settings.json'))
  tools = Object.fromEntries(makeAgentTools({ library, settings }).map(tool => [tool.name, tool]))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('agent tools', () => {
  it('registers the four DPet tools with model-facing descriptions', () => {
    expect(Object.keys(tools).sort()).toEqual(['dpet_import', 'dpet_manage_pet', 'dpet_status', 'dpet_update'])
    for (const tool of Object.values(tools)) expect(tool.description.length).toBeGreaterThan(40)
  })

  it('dpet_status describes the current pet, motions and library', async () => {
    const state = await call('dpet_status')
    expect(state.current).toEqual({ id: 'dongdong', name: 'dongdong', kind: '3d' })
    expect(state.motions.thinking).toBe('spin')
    expect(state.pets.map((p: { id: string }) => p.id)).toEqual(['dongdong', 'dongdong-flat'])
  })

  it('dpet_update switches the pet, resizes it and remaps one motion only', async () => {
    const state = await call('dpet_update', { petId: 'dongdong-flat', size: 260, motions: { thinking: 'nod' } })
    expect(state.current.id).toBe('dongdong-flat')
    expect(state.appearance.size).toBe(260)
    expect(state.motions).toMatchObject({ thinking: 'nod', done: 'cheer' })
    expect(settings.get()).toMatchObject({ petId: 'dongdong-flat', size: 260, motions: { thinking: 'nod' } })
    const reset = await call('dpet_update', { resetMotions: true })
    expect(reset.motions.thinking).toBe('spin')
  })

  it('dpet_update refuses an unknown pet', async () => {
    await expect(call('dpet_update', { petId: 'nope' })).rejects.toThrow(/Unknown pet id/)
  })

  it('dpet_import turns a picture on disk into the current pet', async () => {
    const sharp = (await import('sharp')).default
    const jpeg = join(dir, 'white-cat.jpg')
    await sharp(flatPng).flatten({ background: '#ffffff' }).jpeg().toFile(jpeg)
    const result = await call('dpet_import', { path: jpeg, name: 'White Cat' })
    expect(result.pet).toMatchObject({ id: 'white-cat', name: 'White Cat', kind: '2d' })
    expect(result.report.background).toBe('removed')
    expect(settings.get().petId).toBe('white-cat')
  })

  it('dpet_import rejects relative paths, missing files and unsupported types', async () => {
    await expect(call('dpet_import', { path: 'cat.png' })).rejects.toThrow(/absolute/)
    await expect(call('dpet_import', { path: join(dir, 'missing.png') })).rejects.toThrow(/not found/)
    const txt = join(dir, 'notes.txt')
    writeFileSync(txt, 'hi')
    await expect(call('dpet_import', { path: txt })).rejects.toThrow(/Unsupported/)
  })

  it('dpet_manage_pet renames and deletes imported pets but never built-ins', async () => {
    await call('dpet_import', { path: flatPng, name: 'Copy', use: true })
    const renamed = await call('dpet_manage_pet', { petId: 'copy', action: 'rename', name: 'Renamed' })
    expect(renamed.pets.find((p: { id: string }) => p.id === 'copy').name).toBe('Renamed')
    const deleted = await call('dpet_manage_pet', { petId: 'copy', action: 'delete' })
    expect(deleted.pets.some((p: { id: string }) => p.id === 'copy')).toBe(false)
    expect(deleted.current.id).toBe('dongdong')
    await expect(call('dpet_manage_pet', { petId: 'dongdong', action: 'delete' })).rejects.toThrow(/Built-in/)
  })
})
