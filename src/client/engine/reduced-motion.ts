/**
 * The operating system's "reduce motion" accessibility setting. When it is on,
 * both renderers hold the pet still (no hops, spins, squashes or pointer
 * following); the pet still appears and still shows its status bubble.
 * @module dsh-dpet/client/engine/reduced-motion
 */

const QUERY = '(prefers-reduced-motion: reduce)'

/** A live view of the setting; `matches` is cheap to read every frame. */
export function reducedMotionQuery(): { readonly matches: boolean } {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return { matches: false }
  return window.matchMedia(QUERY)
}

/** Whether reduced motion is requested right now. */
export function prefersReducedMotion(): boolean {
  return reducedMotionQuery().matches
}
