/**
 * User settings — defaults, validation, and persistence to
 * `$DSH_HOME/dpet/settings.json`. `sanitizeSettings` is the single gate every
 * write passes through: unknown fields are dropped and numbers are clamped,
 * so a hand-edited or stale file can never break the pet.
 * @module dsh-dpet/server/repository/settings
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../common/files.ts'
import { ACTIVITY_PHASES, PET_MOTIONS, SETTINGS_LIMITS, type ActivityPhase, type DpetSettings, type PetMotion } from '../../shared/types.ts'

/** The pet shown on a fresh install. */
export const DEFAULT_PET_ID = 'dongdong'

/** Settings of a fresh install. */
export const DEFAULT_SETTINGS: Readonly<DpetSettings> = {
  enabled: true,
  petId: DEFAULT_PET_ID,
  size: 180,
  right: 32,
  bottom: 24,
  opacity: 1,
  lookAtCursor: true,
  bubbles: true,
  motions: {},
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function motionsOf(value: unknown): Partial<Record<ActivityPhase, PetMotion>> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Partial<Record<ActivityPhase, PetMotion>> = {}
  for (const [phase, motion] of Object.entries(value)) {
    if (ACTIVITY_PHASES.includes(phase as ActivityPhase) && PET_MOTIONS.includes(motion as PetMotion)) {
      out[phase as ActivityPhase] = motion as PetMotion
    }
  }
  return out
}

/**
 * Merge a partial update onto a base, keeping only valid values.
 * @param patch - untrusted input (request body or file contents).
 * @param base - the settings the patch applies to.
 */
export function sanitizeSettings(patch: unknown, base: DpetSettings = DEFAULT_SETTINGS): DpetSettings {
  const p = typeof patch === 'object' && patch !== null ? patch as Record<string, unknown> : {}
  const { size, inset, opacity } = SETTINGS_LIMITS
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    petId: typeof p.petId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.petId) ? p.petId : base.petId,
    size: Math.round(clamp(p.size, size.min, size.max, base.size)),
    right: Math.round(clamp(p.right, inset.min, inset.max, base.right)),
    bottom: Math.round(clamp(p.bottom, inset.min, inset.max, base.bottom)),
    opacity: clamp(p.opacity, opacity.min, opacity.max, base.opacity),
    lookAtCursor: typeof p.lookAtCursor === 'boolean' ? p.lookAtCursor : base.lookAtCursor,
    bubbles: typeof p.bubbles === 'boolean' ? p.bubbles : base.bubbles,
    motions: p.motions === undefined ? { ...base.motions } : motionsOf(p.motions),
  }
}

/** Settings persisted in one JSON file. */
export class SettingsStore {
  private value: DpetSettings

  constructor(private readonly file: string) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = undefined
    }
    this.value = sanitizeSettings(raw, DEFAULT_SETTINGS)
  }

  get(): DpetSettings {
    return { ...this.value, motions: { ...this.value.motions } }
  }

  /** Apply a partial update, persist it, and return the result. */
  update(patch: unknown): DpetSettings {
    this.value = sanitizeSettings(patch, this.value)
    writeFileAtomic(this.file, JSON.stringify(this.value, null, 2) + '\n')
    return this.get()
  }
}
