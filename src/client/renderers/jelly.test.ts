import { describe, expect, it } from 'vitest'
import { STRIPS, TILT_MAX, jellyFrame } from './jelly.ts'
import { REST_POSE, motionPose, type GltfPose } from './motion.ts'

const still = (): GltfPose => ({ ...REST_POSE })
const neutral = { sx: 1, sy: 1 }

describe('jellyFrame', () => {
  it('reproduces the picture exactly at rest', () => {
    const frame = jellyFrame(still, neutral, 0)
    expect(frame.strips).toHaveLength(STRIPS)
    expect(frame.strips[0]!.top).toBeCloseTo(1)
    expect(frame.strips.at(-1)!.top).toBeCloseTo(1 / STRIPS)
    for (const strip of frame.strips) {
      expect(strip.x).toBe(0)
      expect(strip.width).toBe(1)
    }
    expect(frame.tilt).toBe(0)
    expect(frame.shadowScale).toBe(1)
  })

  it('bends a sway: feet stay, the head moves most', () => {
    const frame = jellyFrame(() => ({ ...REST_POSE, roll: 0.1 }), neutral, 0)
    const feet = frame.strips.at(-1)!
    const head = frame.strips[0]!
    expect(Math.abs(feet.x)).toBeLessThan(0.001)
    expect(head.x).toBeGreaterThan(0.1)
    // Curved, not rigid: the middle moved well under half of the head offset.
    expect(frame.strips[STRIPS / 2]!.x).toBeLessThan(head.x * 0.4)
  })

  it('never turns a spin into a flip, only a bounded tilt', () => {
    for (let t = 0; t < 6; t += 0.1) {
      const frame = jellyFrame(() => motionPose('spin', t), neutral, 0)
      expect(Math.abs(frame.tilt)).toBeLessThanOrEqual(TILT_MAX + 1e-9)
      for (const strip of frame.strips) expect(strip.width).toBeGreaterThan(0.9)
    }
  })

  it('breathes in the upper body more than at the feet', () => {
    const frame = jellyFrame(() => ({ ...REST_POSE, sy: 1.02 }), neutral, 0)
    const feet = frame.strips.at(-1)!
    const head = frame.strips[0]!
    expect(head.height).toBeGreaterThan(feet.height)
    expect(frame.strips[0]!.top).toBeGreaterThan(1)
  })

  it('bulges near the feet on a squash', () => {
    const frame = jellyFrame(still, { sx: 1.1, sy: 0.85 }, 0)
    expect(frame.strips.at(-1)!.width).toBeGreaterThan(frame.strips[0]!.width)
    expect(frame.strips[0]!.top).toBeLessThan(1)
  })

  it('lifts off the ground on a hop and shrinks the shadow', () => {
    const frame = jellyFrame(() => ({ ...REST_POSE, y: 0.1 }), neutral, 0)
    expect(frame.strips.at(-1)!.top - frame.strips.at(-1)!.height).toBeCloseTo(0.1)
    expect(frame.shadowScale).toBeLessThan(1)
    expect(frame.shadowAlpha).toBeLessThan(1)
  })

  it('folds the head down on a nod', () => {
    const frame = jellyFrame(() => ({ ...REST_POSE, pitch: 0.12 }), neutral, 0)
    expect(frame.strips[0]!.top).toBeLessThan(1)
    expect(frame.strips.at(-1)!.height).toBeCloseTo(1 / STRIPS)
  })
})
