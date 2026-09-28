/**
 * Jelly deformation for flat pets — the math behind the 2D renderer.
 *
 * A single picture moved as one rigid card reads as paper. Instead the
 * picture is cut into horizontal strips and every strip is placed on its
 * own, by its height above the feet:
 *
 *   - bend: the feet stay put and each strip shifts sideways by h^1.7, so a
 *     sway curves the body instead of rotating a card (bounded, because a
 *     large shift shears the picture into a parallelogram);
 *   - breathe / squash: vertical stretch concentrates in the upper body
 *     (the chest rises), horizontal bulge concentrates near the feet (the
 *     body settles like jelly on landing);
 *   - nod / droop: the head region folds down;
 *   - follow-through: higher strips sample the motion a little later, so
 *     the top trails the base and the whole body feels soft;
 *   - turn: yaw becomes a gentle perspective tilt (at most TILT_MAX) instead
 *     of a card flip;
 *   - look at the pointer: a small perspective turn plus a small rigid tip
 *     toward the pointer. It never bends the strips: a held bend is exactly
 *     the sideways shear that makes a flat picture look dragged.
 *
 * Everything here is pure; ./flat.ts draws the result onto a canvas.
 * @module dsh-dpet/client/engine/jelly
 */

import type { GltfPose } from './motion.ts'

/** Number of strips the picture is cut into. */
export const STRIPS = 40
/** Largest perspective tilt a turn produces, radians (about 14 degrees). */
export const TILT_MAX = (14 * Math.PI) / 180
/** Delay of the topmost strip behind the feet, seconds. */
export const FOLLOW_LAG = 0.12
/** Lift (in body heights) at which the shadow is smallest. */
const SHADOW_LIFT = 0.2
/** Largest sideways shift of the head from bending, in picture heights. */
export const MAX_BEND = 0.1
/** Perspective turn toward the pointer at full look, radians (about 8 degrees). */
export const LOOK_TILT = (8 * Math.PI) / 180
/** Rigid tip toward the pointer at full look, radians (about 3 degrees). */
export const LOOK_ROLL = (3 * Math.PI) / 180

/** One strip, in units of the rest picture (width 1, height 1, feet at y = 0). */
export interface Strip {
  /** Source rows [v0, v1) of the picture, 0 = top edge. */
  v0: number
  v1: number
  /** Destination center offset from the feet axis, in picture heights. */
  x: number
  /** Destination top, measured upward from the ground, in picture heights. */
  top: number
  /** Destination width, in picture widths. */
  width: number
  /** Destination height, in picture heights. */
  height: number
}

export interface JellyFrame {
  strips: Strip[]
  /** Perspective tilt around the vertical axis, radians. */
  tilt: number
  /** Rigid rotation of the whole picture around the feet, radians (clockwise positive). */
  roll: number
  /** Shadow size (1 = resting) and opacity multiplier. */
  shadowScale: number
  shadowAlpha: number
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Lay out one frame.
 * @param poseAt - the motion pose `lag` seconds in the past (0 = now).
 * @param squash - tap squash factors.
 * @param look - where the pointer is, -1 (far left) .. 1 (far right).
 */
export function jellyFrame(
  poseAt: (lag: number) => GltfPose,
  squash: { sx: number; sy: number },
  look: number,
  strips: number = STRIPS,
): JellyFrame {
  const base = poseAt(0)
  const lift = Math.max(0, base.y)
  const out: Strip[] = []
  // Stack strips upward from the feet so the base never leaves the ground.
  let ground = lift
  for (let i = strips - 1; i >= 0; i--) {
    const v0 = i / strips
    const v1 = (i + 1) / strips
    const h = 1 - (v0 + v1) / 2 // height above the feet, 0..1
    const pose = poseAt(FOLLOW_LAG * h)
    const sy = pose.sy * squash.sy
    const sx = pose.sx * squash.sx
    const stretch = 1 + (sy - 1) * (0.4 + 1.2 * h)
    const bulge = 1 + (sx - 1) * (1.4 - 0.8 * h)
    const fold = 1 - Math.max(0, pose.pitch) * 1.0 * smoothstep(0.62, 1, h)
    const height = (stretch * fold) / strips
    const bend = Math.max(-MAX_BEND, Math.min(MAX_BEND, pose.roll * 1.4)) * Math.pow(h, 1.7)
    out.push({ v0, v1, x: bend, top: ground + height, width: bulge, height })
    ground += height
  }
  const lifted = Math.min(1, lift / SHADOW_LIFT)
  const facing = Math.max(-1, Math.min(1, look))
  return {
    strips: out.reverse(),
    tilt: Math.max(-TILT_MAX, Math.min(TILT_MAX, TILT_MAX * Math.sin(base.yaw) + LOOK_TILT * facing)),
    roll: LOOK_ROLL * facing,
    shadowScale: 1 - lifted * 0.45,
    shadowAlpha: 1 - lifted * 0.6,
  }
}
