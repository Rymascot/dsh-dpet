import { describe, expect, it } from 'vitest'
import { ActivityTracker, STALE_MS, TERMINAL_HOLD_MS, projectSessionEvent, projectStreamFrame } from './activity.ts'

const runtime = () => ({ openTools: new Map<string, string>() })

describe('projectSessionEvent', () => {
  it('maps the turn lifecycle onto phases', () => {
    const r = runtime()
    expect(projectSessionEvent({ type: 'turn/start' }, r)).toEqual({ phase: 'waiting', line: 'prepare' })
    expect(projectSessionEvent({ type: 'assistant/message' }, r)).toEqual({ phase: 'review', line: 'writing' })
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, r)).toEqual({ phase: 'done', line: 'done' })
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } }, r)).toEqual({ phase: 'failed', line: 'failed' })
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }, r)).toEqual({ phase: 'waiting', line: 'blocked' })
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }, r)).toEqual({ phase: 'idle' })
  })

  it('stays on tool while any call is open and names the tool', () => {
    const r = runtime()
    expect(projectSessionEvent({ type: 'tool/call', data: { callId: 'a', name: 'bash' } }, r)).toEqual({ phase: 'tool', line: 'tool', tool: 'bash' })
    projectSessionEvent({ type: 'tool/call', data: { callId: 'b', name: 'read' } }, r)
    expect(projectSessionEvent({ type: 'tool/result', data: { message: { toolCallId: 'b' } } }, r)).toEqual({ phase: 'tool', line: 'tool', tool: 'bash' })
    expect(projectSessionEvent({ type: 'tool/result', data: { message: { toolCallId: 'a' } } }, r)).toEqual({ phase: 'thinking', line: 'thinking' })
  })

  it('treats a failing tool as a hiccup, not a failed turn', () => {
    const r = runtime()
    projectSessionEvent({ type: 'tool/call', data: { callId: 'a', name: 'grep' } }, r)
    expect(projectSessionEvent({ type: 'tool/result', data: { message: { toolCallId: 'a', isError: true } } }, r))
      .toEqual({ phase: 'thinking', line: 'toolRetry' })
  })

  it('ignores unknown and log-only events', () => {
    expect(projectSessionEvent({ type: 'usage/update' }, runtime())).toBeUndefined()
  })
})

describe('projectStreamFrame', () => {
  it('maps reasoning to thinking and text to writing, ignoring empty chunks', () => {
    expect(projectStreamFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'hm' } })).toEqual({ phase: 'thinking', line: 'thinking' })
    expect(projectStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'Hi' } })).toEqual({ phase: 'review', line: 'writing' })
    expect(projectStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', text: '' } })).toBeUndefined()
    expect(projectStreamFrame({ type: 'start' })).toBeUndefined()
  })
})

describe('ActivityTracker', () => {
  it('holds done briefly, then settles to idle', () => {
    let now = 1_000
    const tracker = new ActivityTracker(() => now)
    tracker.onSessionEvent('s1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(tracker.snapshot().phase).toBe('done')
    now += TERMINAL_HOLD_MS + 1
    expect(tracker.snapshot().phase).toBe('idle')
  })

  it('keeps the phase start time across repeated chunks', () => {
    let now = 1_000
    const tracker = new ActivityTracker(() => now)
    tracker.onStreamFrame('s1', { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'a' } })
    const since = tracker.snapshot().since
    now += 500
    tracker.onStreamFrame('s1', { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'b' } })
    expect(tracker.snapshot().since).toBe(since)
  })

  it('settles a phase that stops receiving events for a long time', () => {
    let now = 1_000
    const tracker = new ActivityTracker(() => now)
    tracker.onSessionEvent('s1', { type: 'tool/call', data: { callId: 'a', name: 'bash' } })
    now += STALE_MS - 1
    expect(tracker.snapshot().phase).toBe('tool')
    now += 2
    expect(tracker.snapshot().phase).toBe('idle')
  })

  it('follows the latest session and settles when that session is disposed', () => {
    const tracker = new ActivityTracker(() => 1_000)
    tracker.onSessionEvent('s1', { type: 'turn/start' })
    tracker.onStreamFrame('s2', { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } })
    expect(tracker.snapshot().phase).toBe('review')
    tracker.onSessionDisposed('s1')
    expect(tracker.snapshot().phase).toBe('review')
    tracker.onSessionDisposed('s2')
    expect(tracker.snapshot().phase).toBe('idle')
  })
})
