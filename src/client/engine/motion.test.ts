/**
 * Procedural motion tests — the pure pose curves both renderers apply, the
 * phase mapping, and the tap squash envelope.
 */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_PHASES, PET_MOTIONS } from '../../shared/types.ts'
import {
  CHEER_SECONDS,
  DEFAULT_GLTF_MOTIONS,
  REST_POSE,
  TAP_SECONDS,
  motionForPhase,
  motionPose,
  tapSquash,
} from './motion.ts'

describe('motionPose', () => {
  it('returns finite poses for every motion across a long timeline', () => {
    for (const motion of PET_MOTIONS) {
      for (let t = 0; t <= 30; t += 0.37) {
        const pose = motionPose(motion, t)
        for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true)
        expect(pose.sx).toBeGreaterThan(0.8)
        expect(pose.sy).toBeGreaterThan(0.8)
      }
    }
  })

  it('keeps still at the rest pose', () => {
    expect(motionPose('still', 12.5)).toEqual(REST_POSE)
  })

  it('never lets hop sink below the ground', () => {
    for (let t = 0; t < 3; t += 0.01) expect(motionPose('hop', t).y).toBeGreaterThanOrEqual(0)
  })

  it('turns cheer a full circle and then settles into the idle bob', () => {
    expect(motionPose('cheer', 0).yaw).toBeCloseTo(0)
    expect(motionPose('cheer', CHEER_SECONDS - 1e-6).yaw).toBeCloseTo(Math.PI * 2, 3)
    expect(motionPose('cheer', CHEER_SECONDS + 0.5)).toEqual(motionPose('bob', 0.5))
  })

  it('lands droop in a bowed, sunk pose', () => {
    const settled = motionPose('droop', 5)
    expect(settled.pitch).toBeCloseTo(0.15)
    expect(settled.y).toBeCloseTo(-0.02)
    expect(settled.sy).toBeLessThan(1)
  })
})

describe('motionForPhase', () => {
  it('maps every activity phase to a built-in motion by default', () => {
    for (const phase of ACTIVITY_PHASES) {
      expect(PET_MOTIONS).toContain(motionForPhase(phase, undefined))
    }
    expect(DEFAULT_GLTF_MOTIONS.done).toBe('cheer')
  })

  it('lets manifest overrides win per phase only', () => {
    const overrides = { thinking: 'nod' as const }
    expect(motionForPhase('thinking', overrides)).toBe('nod')
    expect(motionForPhase('idle', overrides)).toBe(DEFAULT_GLTF_MOTIONS.idle)
  })
})

describe('tapSquash', () => {
  it('is neutral outside the tap window', () => {
    expect(tapSquash(-1)).toEqual({ sx: 1, sy: 1 })
    expect(tapSquash(TAP_SECONDS)).toEqual({ sx: 1, sy: 1 })
  })

  it('squashes vertically while bulging sideways early in the window', () => {
    const early = tapSquash(0.08)
    expect(early.sy).toBeLessThan(1)
    expect(early.sx).toBeGreaterThan(1)
  })
})
