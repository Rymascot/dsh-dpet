import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from './settings.ts'

describe('sanitizeSettings', () => {
  it('clamps numbers and keeps the base for invalid values', () => {
    const out = sanitizeSettings({ size: 9999, right: -5, opacity: 0.1, bubbles: 'yes', petId: '../evil' })
    expect(out.size).toBe(480)
    expect(out.right).toBe(0)
    expect(out.opacity).toBe(0.3)
    expect(out.bubbles).toBe(DEFAULT_SETTINGS.bubbles)
    expect(out.petId).toBe(DEFAULT_SETTINGS.petId)
  })

  it('keeps only known phase -> motion pairs', () => {
    const out = sanitizeSettings({ motions: { thinking: 'nod', idle: 'moonwalk', napping: 'bob' } })
    expect(out.motions).toEqual({ thinking: 'nod' })
  })

  it('ignores non-object input', () => {
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('SettingsStore', () => {
  it('persists updates and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dpet-settings-'))
    try {
      const file = join(dir, 'nested', 'settings.json')
      const store = new SettingsStore(file)
      expect(store.get()).toEqual(DEFAULT_SETTINGS)
      store.update({ size: 240, motions: { done: 'hop' } })
      expect(new SettingsStore(file).get()).toMatchObject({ size: 240, motions: { done: 'hop' } })
      expect(JSON.parse(readFileSync(file, 'utf8')).size).toBe(240)
      writeFileSync(file, '{ broken')
      expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
