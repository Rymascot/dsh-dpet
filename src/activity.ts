/**
 * Agent activity tracking — projects the DSH session vocabulary onto the
 * pet's seven phases. The tracker is pure apart from an injected clock: the
 * host feeds it `session/event` and `agent/assistant-stream` publications,
 * and the state route reads a snapshot.
 *
 * Several sessions can run at once; the pet follows whichever session
 * produced the latest meaningful event. Terminal phases (done / failed) are
 * shown for a short window and then settle back to idle, and an in-progress
 * phase that stops receiving events for a long time also settles to idle so
 * a lost terminal event cannot leave the pet busy forever.
 * @module dsh-dpet/activity
 */

import type { ActivityLine, ActivityPhase, ActivitySnapshot } from './types.ts'

/** How long done / failed stay on screen before settling to idle. */
export const TERMINAL_HOLD_MS = 5000
/** In-progress phases older than this with no new events settle to idle. */
export const STALE_MS = 10 * 60 * 1000

/** The slice of a durable session event the tracker reads. */
export interface SessionEventLike {
  type: string
  data?: unknown
}

/** The slice of an `agent/assistant-stream` frame the tracker reads. */
export interface StreamFrameLike {
  type: string
  chunk?: { type?: string; text?: string }
}

interface Transition {
  phase: ActivityPhase
  line?: ActivityLine
  tool?: string
}

interface SessionRuntime {
  /** Tool calls issued in the current step and not yet answered. */
  openTools: Map<string, string>
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Map one durable session event onto a transition; undefined leaves the
 * current phase alone (log-only and unknown events).
 */
export function projectSessionEvent(event: SessionEventLike, runtime: SessionRuntime): Transition | undefined {
  const data = record(event.data)
  switch (event.type) {
    case 'turn/start':
      runtime.openTools.clear()
      return { phase: 'waiting', line: 'prepare' }
    case 'step/start':
      runtime.openTools.clear()
      return { phase: 'waiting', line: 'waiting' }
    case 'assistant/message':
      return { phase: 'review', line: 'writing' }
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : ''
      runtime.openTools.set(String(data.callId ?? runtime.openTools.size), name)
      return { phase: 'tool', line: 'tool', tool: name }
    }
    case 'tool/result': {
      const message = record(data.message)
      runtime.openTools.delete(String(message.toolCallId ?? data.callId ?? ''))
      const failed = data.error !== undefined || message.isError === true
      const remaining = [...runtime.openTools.values()]
      if (remaining.length > 0) return { phase: 'tool', line: 'tool', tool: remaining.at(-1)! }
      // A failing tool mid-turn is routine (a search with no hits, a test
      // that is about to be fixed); the agent keeps going, so does the pet.
      return failed ? { phase: 'thinking', line: 'toolRetry' } : { phase: 'thinking', line: 'thinking' }
    }
    case 'turn/end': {
      runtime.openTools.clear()
      const kind = record(data.reason).kind
      switch (kind) {
        case 'completed':
          return { phase: 'done', line: 'done' }
        case 'error':
        case 'max-tokens':
          return { phase: 'failed', line: 'failed' }
        case 'blocked':
          return { phase: 'waiting', line: 'blocked' }
        case 'interrupted':
          return { phase: 'idle', line: 'interrupted' }
        default:
          return { phase: 'idle' }
      }
    }
    default:
      return undefined
  }
}

/** Map one live stream frame: reasoning keeps the pet thinking, text means it is writing. */
export function projectStreamFrame(frame: StreamFrameLike): Transition | undefined {
  if (frame.type !== 'chunk' || frame.chunk === undefined) return undefined
  const { type, text } = frame.chunk
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (type === 'reasoning-delta') return { phase: 'thinking', line: 'thinking' }
  if (type === 'text-delta') return { phase: 'review', line: 'writing' }
  return undefined
}

/** Tracks every live session and exposes the one the pet should follow. */
export class ActivityTracker {
  private readonly sessions = new Map<string, SessionRuntime>()
  private current: ActivitySnapshot
  private currentSession: string | undefined
  /** Last time any event refreshed the current phase (stale detection). */
  private touchedAt = 0

  constructor(private readonly now: () => number = Date.now) {
    this.current = { phase: 'idle', since: now() }
  }

  private runtimeOf(sessionId: string): SessionRuntime {
    let runtime = this.sessions.get(sessionId)
    if (runtime === undefined) {
      runtime = { openTools: new Map() }
      this.sessions.set(sessionId, runtime)
    }
    return runtime
  }

  private apply(sessionId: string, transition: Transition | undefined): void {
    if (transition === undefined) return
    const at = this.now()
    const same = this.current.phase === transition.phase
      && this.current.line === transition.line
      && this.current.tool === transition.tool
    this.currentSession = sessionId
    // A repeated transition (every streamed chunk) keeps its start time, so
    // motions do not restart dozens of times per second.
    this.current = {
      phase: transition.phase,
      since: same ? this.current.since : at,
      ...(transition.line === undefined ? {} : { line: transition.line }),
      ...(transition.tool === undefined ? {} : { tool: transition.tool }),
    }
    this.touchedAt = at
  }

  /** Feed one durable `session/event`. */
  onSessionEvent(sessionId: string, event: SessionEventLike): void {
    this.apply(sessionId, projectSessionEvent(event, this.runtimeOf(sessionId)))
  }

  /** Feed one `agent/assistant-stream` frame. */
  onStreamFrame(sessionId: string, frame: StreamFrameLike): void {
    this.apply(sessionId, projectStreamFrame(frame))
  }

  /** Forget a disposed session; if the pet was following it, settle to idle. */
  onSessionDisposed(sessionId: string): void {
    this.sessions.delete(sessionId)
    if (this.currentSession === sessionId) {
      this.currentSession = undefined
      this.current = { phase: 'idle', since: this.now() }
    }
  }

  /** The phase to show right now (terminal and stale phases settle to idle). */
  snapshot(): ActivitySnapshot {
    const now = this.now()
    const { phase } = this.current
    const terminal = phase === 'done' || phase === 'failed'
    const expired = terminal
      ? now - this.current.since > TERMINAL_HOLD_MS
      : phase !== 'idle' && now - Math.max(this.touchedAt, this.current.since) > STALE_MS
    if (expired) {
      this.current = { phase: 'idle', since: now }
      this.currentSession = undefined
    }
    return { ...this.current }
  }
}
