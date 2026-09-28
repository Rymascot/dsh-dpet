/**
 * Phase stream — bridges the polled host snapshots onto a { get, subscribe }
 * source the renderers read. Subscribers fire on CHANGE only, so a renderer
 * restarts its motion once per transition, not once per poll.
 * @module dsh-dpet/client/phase-stream
 */

import type { ActivityPhase } from '../types.ts'

/** The read side renderers consume. */
export interface PhaseSource {
  /** The latest phase. */
  get(): ActivityPhase
  /** Subscribe to phase changes; returns the unsubscribe. */
  subscribe(listener: (phase: ActivityPhase) => void): () => void
}

/** A phase source the owner can push into. */
export interface PhaseStream extends PhaseSource {
  /** Feed a fresh phase; no-op when unchanged. */
  push(phase: ActivityPhase): void
}

/** Create a stream. */
export function createPhaseStream(initial: ActivityPhase = 'idle'): PhaseStream {
  let current = initial
  const listeners = new Set<(phase: ActivityPhase) => void>()
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(phase) {
      if (phase === current) return
      current = phase
      for (const listener of [...listeners]) listener(phase)
    },
  }
}
