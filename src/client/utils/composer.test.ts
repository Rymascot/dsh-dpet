import { describe, expect, it } from 'vitest'
import { createComposer, decideInjection, mainSessionId } from './composer.ts'

describe('decideInjection', () => {
  it('fills an empty input or one holding our previous prompt', () => {
    expect(decideInjection('', undefined)).toBe('inject')
    expect(decideInjection('   ', 'x')).toBe('inject')
    expect(decideInjection('hello', 'hello')).toBe('inject')
  })

  it('never overwrites the user\'s own unsent text', () => {
    expect(decideInjection('my question', undefined)).toBe('skip')
    expect(decideInjection('my question', 'our prompt')).toBe('skip')
  })
})

describe('mainSessionId', () => {
  it('picks the session retained by the main view', () => {
    const snapshot = { byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } }
    expect(mainSessionId(snapshot)).toBe('b')
    expect(mainSessionId({ byId: {} })).toBeUndefined()
    expect(mainSessionId(undefined)).toBeUndefined()
  })
})

/** A fake sessions service with one main session and a draft box. */
function fakeSessions(initialDraft = '') {
  const state = { draft: initialDraft, focused: false }
  const input = {
    snapshot: () => ({ draft: state.draft }),
    setDraft: (text: string) => { state.draft = text },
    focus: () => { state.focused = true },
  }
  const sessions = {
    list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) },
    scope: () => ({ get: () => ({ input: { for: () => input } }) }),
  }
  return { sessions, state }
}

describe('createComposer', () => {
  it('fills and focuses the main input, then may replace its own prompt', async () => {
    const { sessions, state } = fakeSessions()
    const compose = createComposer(() => sessions, async () => { throw new Error('unused') })
    expect(await compose('first')).toBe('injected')
    expect(state).toEqual({ draft: 'first', focused: true })
    expect(await compose('second')).toBe('injected')
    expect(state.draft).toBe('second')
  })

  it('leaves a user draft alone', async () => {
    const { sessions, state } = fakeSessions('half-written question')
    const compose = createComposer(() => sessions, async () => {})
    expect(await compose('prompt')).toBe('skipped')
    expect(state.draft).toBe('half-written question')
  })

  it('falls back to the clipboard without a main session', async () => {
    const copied: string[] = []
    const compose = createComposer(() => undefined, async (text) => { copied.push(text) })
    expect(await compose('prompt')).toBe('clipboard')
    expect(copied).toEqual(['prompt'])
    const broken = createComposer(() => undefined, async () => { throw new Error('denied') })
    expect(await broken('prompt')).toBe('failed')
  })
})
