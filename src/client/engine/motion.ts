/**
 * Procedural whole-body motions shared by 2D and 3D pets. AI-generated
 * meshes almost never carry a rig, and a flat image has none at all, so both
 * renderers animate the pet root instead: every motion is a pure function
 * from elapsed seconds to a pose offset around the bottom-center pivot. The
 * 3D renderer applies it to a scene-graph group, the 2D renderer to a CSS
 * transform. Keeping the math pure lets tests pin the curves without WebGL.
 * @module dsh-dpet/client/engine/motion
 */

import type { ActivityPhase, PetMotion } from '../../shared/types.ts'

/** A pose offset; translation is in model heights, angles in radians. */
export interface GltfPose {
  y: number
  yaw: number
  pitch: number
  roll: number
  sx: number
  sy: number
  sz: number
}

/** The rest pose. */
export const REST_POSE: Readonly<GltfPose> = { y: 0, yaw: 0, pitch: 0, roll: 0, sx: 1, sy: 1, sz: 1 }

/** Built-in phase -> motion mapping; manifests override per phase. */
export const DEFAULT_GLTF_MOTIONS: Readonly<Record<ActivityPhase, PetMotion>> = {
  idle: 'bob',
  waiting: 'sway',
  thinking: 'spin',
  tool: 'hop',
  review: 'nod',
  done: 'cheer',
  failed: 'droop',
}

/** Duration of the one-shot part of 'cheer' before it settles into 'bob'. */
export const CHEER_SECONDS = 1.1

const TAU = Math.PI * 2

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
}

/** Breathing idle: a slow bob with a matching volume-preserving squash. */
function bob(t: number): GltfPose {
  const breath = Math.sin(TAU * t / 2.4)
  return {
    ...REST_POSE,
    y: 0.012 * breath,
    roll: 0.03 * Math.sin(TAU * t / 4.8),
    sy: 1 + 0.012 * breath,
    sx: 1 - 0.006 * breath,
    sz: 1 - 0.006 * breath,
  }
}

/** The pose of one motion at t seconds since the motion started. */
export function motionPose(motion: PetMotion, t: number): GltfPose {
  switch (motion) {
    case 'still':
      return { ...REST_POSE }
    case 'bob':
      return bob(t)
    case 'sway':
      // Waiting: looks left and right while rocking.
      return { ...bob(t), yaw: 0.35 * Math.sin(TAU * t / 4), roll: 0.07 * Math.sin(TAU * t / 2) }
    case 'spin':
      // Thinking: a slow turntable with a puzzled head tilt.
      return { ...bob(t), yaw: 1.2 * t, roll: 0.06 }
    case 'hop': {
      // Busy with a tool: quick hops with squash on landing.
      const p = (t / 0.6) % 1
      const h = Math.sin(Math.PI * p)
      const land = (1 - h) ** 4
      return { ...REST_POSE, y: 0.07 * h, sy: 1 + 0.05 * h - 0.07 * land, sx: 1 + 0.035 * land, sz: 1 + 0.035 * land }
    }
    case 'nod':
      // Reviewing: forward nods.
      return { ...bob(t), pitch: 0.12 * Math.max(0, Math.sin(TAU * t / 1.2)) }
    case 'cheer': {
      // Done: one jump with a full turn, then settle into the idle bob.
      if (t >= CHEER_SECONDS) return bob(t - CHEER_SECONDS)
      const p = t / CHEER_SECONDS
      return { ...REST_POSE, y: 0.18 * Math.sin(Math.PI * p), yaw: TAU * easeInOut(p) }
    }
    case 'droop': {
      // Failed: sinks and bows its head after a short shiver.
      const e = Math.min(t / 0.6, 1)
      return {
        ...REST_POSE,
        y: -0.02 * e,
        pitch: 0.15 * e,
        roll: 0.05 * Math.sin(TAU * t * 3) * Math.exp(-2 * t),
        sy: 1 - 0.06 * e,
        sx: 1 + 0.03 * e,
        sz: 1 + 0.03 * e,
      }
    }
  }
}

/** Seconds a tap squash lasts. */
export const TAP_SECONDS = 0.9

/** Jelly squash-and-stretch layered over the motion after a tap. */
export function tapSquash(tau: number): { sx: number; sy: number } {
  if (tau < 0 || tau >= TAP_SECONDS) return { sx: 1, sy: 1 }
  const s = Math.exp(-5 * tau) * Math.sin(18 * tau)
  return { sx: 1 + 0.1 * s, sy: 1 - 0.15 * s }
}

/** The motion a phase plays under an optional manifest override map. */
export function motionForPhase(
  phase: ActivityPhase,
  overrides: Partial<Record<ActivityPhase, PetMotion>> | undefined,
): PetMotion {
  return overrides?.[phase] ?? DEFAULT_GLTF_MOTIONS[phase]
}
