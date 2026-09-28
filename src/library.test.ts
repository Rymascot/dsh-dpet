import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PetLibrary, cleanName, idFromName, parseManifest } from './library.ts'

let root: string
let library: PetLibrary

function writePet(base: string, id: string, manifest: Record<string, unknown>, file = 'model.glb'): void {
  mkdirSync(join(base, id), { recursive: true })
  writeFileSync(join(base, id, 'pet.json'), JSON.stringify({ id, name: id, kind: '3d', file, ...manifest }))
  writeFileSync(join(base, id, file), 'x')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dpet-lib-'))
  library = new PetLibrary({ builtin: join(root, 'builtin'), user: join(root, 'user') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('parseManifest', () => {
  it('requires the id to match its directory and the file to match the kind', () => {
    expect(parseManifest({ id: 'a', name: 'A', kind: '3d', file: 'm.glb' }, 'a')).toBeDefined()
    expect(parseManifest({ id: 'a', name: 'A', kind: '3d', file: 'm.glb' }, 'b')).toBeUndefined()
    expect(parseManifest({ id: 'a', name: 'A', kind: '2d', file: 'm.glb' }, 'a')).toBeUndefined()
    expect(parseManifest({ id: 'a', name: 'A', kind: '3d', file: '../m.glb' }, 'a')).toBeUndefined()
    expect(parseManifest({ id: 'a', name: '  ', kind: '3d', file: 'm.glb' }, 'a')).toBeUndefined()
  })
})

describe('names and ids', () => {
  it('slugs ascii names and falls back to a time id for others', () => {
    expect(idFromName('My Dragon!', () => false)).toBe('my-dragon')
    expect(idFromName('东东', () => false, 36 ** 3)).toBe('pet-1000')
    expect(idFromName('cat', id => id === 'cat')).toBe('cat-2')
    expect(cleanName('  a   b  ')).toBe('a b')
    expect(cleanName('')).toBeUndefined()
  })
})

describe('PetLibrary', () => {
  it('lists built-ins first and never lets an import shadow a built-in id', () => {
    writePet(join(root, 'builtin'), 'dongdong', { name: '东东' })
    writePet(join(root, 'user'), 'dongdong', { name: 'fake' })
    writePet(join(root, 'user'), 'cat', { kind: '2d', file: 'image.png' }, 'image.png')
    const list = library.list()
    expect(list.map(e => [e.manifest.id, e.builtin])).toEqual([['dongdong', true], ['cat', false]])
    expect(list[0]!.manifest.name).toBe('东东')
  })

  it('skips pets whose file is missing', () => {
    mkdirSync(join(root, 'user', 'ghost'), { recursive: true })
    writeFileSync(join(root, 'user', 'ghost', 'pet.json'), JSON.stringify({ id: 'ghost', name: 'g', kind: '3d', file: 'm.glb' }))
    expect(library.list()).toEqual([])
  })

  it('serves only the manifest file and the preview', () => {
    writePet(join(root, 'user'), 'cat', {})
    expect(library.servableFile('cat', 'model.glb')).toBe(join(root, 'user', 'cat', 'model.glb'))
    expect(library.servableFile('cat', 'pet.json')).toBeUndefined()
    expect(library.servableFile('cat', '../cat/model.glb')).toBeUndefined()
    expect(library.servableFile('cat', 'preview.png')).toBeUndefined()
    library.setPreview('cat', new Uint8Array([1]))
    expect(library.servableFile('cat', 'preview.png')).toBe(join(root, 'user', 'cat', 'preview.png'))
  })

  it('creates, renames and removes user pets but protects built-ins', () => {
    writePet(join(root, 'builtin'), 'dongdong', {})
    const created = library.create({ name: 'Red Fox', kind: '2d', file: 'image.png' }, new Uint8Array([1, 2]))
    expect(created.manifest.id).toBe('red-fox')
    expect(library.view(library.rename('red-fox', 'Fox')).name).toBe('Fox')
    expect(() => library.rename('dongdong', 'x')).toThrow('builtin-pet')
    expect(() => library.remove('dongdong')).toThrow('builtin-pet')
    library.remove('red-fox')
    expect(library.get('red-fox')).toBeUndefined()
  })

  it('builds browser URLs with a cache-busting version', () => {
    writePet(join(root, 'user'), 'cat', {})
    const view = library.view(library.get('cat')!)
    expect(view.fileUrl).toMatch(/^\/dpet\/pets\/cat\/model\.glb\?v=[0-9a-z]+$/)
    expect(view.previewUrl).toBeUndefined()
  })
})
