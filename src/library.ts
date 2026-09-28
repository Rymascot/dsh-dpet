/**
 * Pet library — the built-in pets shipped under `assets/pets/` plus the
 * user's imported pets under `$DSH_HOME/dpet/pets/`. Each pet is one
 * directory holding a `pet.json` manifest, the model or image it names, and
 * an optional `preview.png` thumbnail. Only those files are ever served.
 * @module dsh-dpet/library
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFileAtomic } from './files.ts'
import type { PetKind, PetView } from './types.ts'

/** The on-disk manifest. */
export interface PetManifest {
  id: string
  name: string
  kind: PetKind
  /** File name of the model or image inside the pet directory. */
  file: string
  description?: string
  author?: string
  source?: string
  bytes?: number
  triangles?: number
  createdAt?: number
}

/** A resolved library entry (host side). */
export interface PetEntry {
  manifest: PetManifest
  dir: string
  builtin: boolean
  hasPreview: boolean
}

/** Browser prefix the asset route serves pet files under. */
export const PET_FILE_PREFIX = '/dpet/pets'
/** Name of the optional thumbnail file. */
export const PREVIEW_FILE = 'preview.png'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const FILE_PATTERN = /^[A-Za-z0-9._-]+\.(glb|png|jpg|jpeg|webp|gif)$/i
const NAME_MAX = 32

/** Validate an untrusted manifest; undefined when it is unusable. */
export function parseManifest(raw: unknown, dirName: string): PetManifest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id) || m.id !== dirName) return undefined
  if (typeof m.name !== 'string' || m.name.trim() === '') return undefined
  if (m.kind !== '3d' && m.kind !== '2d') return undefined
  if (typeof m.file !== 'string' || !FILE_PATTERN.test(m.file)) return undefined
  if ((m.kind === '3d') !== m.file.toLowerCase().endsWith('.glb')) return undefined
  const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
  const optionalNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const manifest: PetManifest = { id: m.id, name: m.name.trim().slice(0, NAME_MAX), kind: m.kind, file: m.file }
  const description = optionalString(m.description)
  const author = optionalString(m.author)
  const source = optionalString(m.source)
  const bytes = optionalNumber(m.bytes)
  const triangles = optionalNumber(m.triangles)
  const createdAt = optionalNumber(m.createdAt)
  if (description !== undefined) manifest.description = description
  if (author !== undefined) manifest.author = author
  if (source !== undefined) manifest.source = source
  if (bytes !== undefined) manifest.bytes = bytes
  if (triangles !== undefined) manifest.triangles = triangles
  if (createdAt !== undefined) manifest.createdAt = createdAt
  return manifest
}

/** Turn a display name into a directory id; falls back to a time-based id. */
export function idFromName(name: string, taken: (id: string) => boolean, now: number = Date.now()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const base = slug === '' ? 'pet-' + now.toString(36) : slug
  let id = base
  for (let n = 2; taken(id); n += 1) id = base + '-' + n
  return id
}

/** Trim and bound a user-supplied display name. */
export function cleanName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
  return trimmed === '' ? undefined : trimmed
}

export class PetLibrary {
  constructor(private readonly dirs: { builtin: string; user: string }) {}

  private scan(root: string, builtin: boolean): PetEntry[] {
    let names: string[]
    try {
      names = readdirSync(root).filter(name => !name.startsWith('.')).sort()
    } catch {
      return []
    }
    const entries: PetEntry[] = []
    for (const name of names) {
      const dir = join(root, name)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
      } catch {
        continue
      }
      const manifest = parseManifest(raw, name)
      if (manifest === undefined || !existsSync(join(dir, manifest.file))) continue
      entries.push({ manifest, dir, builtin, hasPreview: existsSync(join(dir, PREVIEW_FILE)) })
    }
    return entries
  }

  /** Every usable pet: built-ins first, then imports (a user pet cannot shadow a built-in id). */
  list(): PetEntry[] {
    const builtin = this.scan(this.dirs.builtin, true)
    const ids = new Set(builtin.map(entry => entry.manifest.id))
    return [...builtin, ...this.scan(this.dirs.user, false).filter(entry => !ids.has(entry.manifest.id))]
  }

  get(id: string): PetEntry | undefined {
    return this.list().find(entry => entry.manifest.id === id)
  }

  has(id: string): boolean {
    return existsSync(join(this.dirs.builtin, id)) || existsSync(join(this.dirs.user, id))
  }

  /** Browser view of one entry. */
  view(entry: PetEntry): PetView {
    const m = entry.manifest
    const base = PET_FILE_PREFIX + '/' + encodeURIComponent(m.id) + '/'
    let version = ''
    try {
      version = '?v=' + Math.round(statSync(join(entry.dir, m.file)).mtimeMs).toString(36)
    } catch {}
    let previewVersion = ''
    if (entry.hasPreview) {
      try {
        previewVersion = '?v=' + Math.round(statSync(join(entry.dir, PREVIEW_FILE)).mtimeMs).toString(36)
      } catch {}
    }
    return {
      id: m.id,
      name: m.name,
      kind: m.kind,
      fileUrl: base + encodeURIComponent(m.file) + version,
      ...(entry.hasPreview ? { previewUrl: base + PREVIEW_FILE + previewVersion } : {}),
      builtin: entry.builtin,
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(m.author === undefined ? {} : { author: m.author }),
      ...(m.source === undefined ? {} : { source: m.source }),
      ...(m.bytes === undefined ? {} : { bytes: m.bytes }),
      ...(m.triangles === undefined ? {} : { triangles: m.triangles }),
      ...(m.createdAt === undefined ? {} : { createdAt: m.createdAt }),
    }
  }

  /**
   * Resolve a servable file of a pet: only the manifest's own file and the
   * preview thumbnail; anything else (including traversal attempts) is
   * undefined.
   */
  servableFile(id: string, file: string): string | undefined {
    const entry = this.get(id)
    if (entry === undefined) return undefined
    if (basename(file) !== file) return undefined
    if (file === entry.manifest.file) return join(entry.dir, file)
    if (file === PREVIEW_FILE && entry.hasPreview) return join(entry.dir, PREVIEW_FILE)
    return undefined
  }

  /** Create a user pet from already-processed bytes. */
  create(manifest: Omit<PetManifest, 'id'> & { id?: string }, data: Uint8Array): PetEntry {
    const id = manifest.id ?? idFromName(manifest.name, candidate => this.has(candidate))
    const dir = join(this.dirs.user, id)
    const full: PetManifest = { ...manifest, id }
    writeFileAtomic(join(dir, full.file), data)
    writeFileAtomic(join(dir, 'pet.json'), JSON.stringify(full, null, 2) + '\n')
    return { manifest: full, dir, builtin: false, hasPreview: false }
  }

  /** Rename a user pet. */
  rename(id: string, name: string): PetEntry {
    const entry = this.userEntry(id)
    const manifest = { ...entry.manifest, name }
    writeFileAtomic(join(entry.dir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n')
    return { ...entry, manifest }
  }

  /** Store a PNG thumbnail for a user pet. */
  setPreview(id: string, png: Uint8Array): PetEntry {
    const entry = this.userEntry(id)
    writeFileAtomic(join(entry.dir, PREVIEW_FILE), png)
    return { ...entry, hasPreview: true }
  }

  /** Delete a user pet directory. */
  remove(id: string): void {
    const entry = this.userEntry(id)
    rmSync(entry.dir, { recursive: true, force: true })
  }

  private userEntry(id: string): PetEntry {
    const entry = this.get(id)
    if (entry === undefined) throw new Error('pet-not-found')
    if (entry.builtin) throw new Error('builtin-pet')
    return entry
  }
}
