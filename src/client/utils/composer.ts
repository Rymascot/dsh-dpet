/**
 * Composer prompt injection: fill the DSH main input with a prompt and focus
 * it, never sending. The user reads it, edits it if needed, and presses Send.
 *
 * Adapted from hherosoul/dsh-task-pet src/suggest.js (MIT): the main-session
 * lookup, the conversation.input.for(...).setDraft() contract, and the rule
 * that an unsent draft of the user's own is never overwritten.
 * @module dsh-dpet/client/utils/composer
 */

/** What happened to a prompt. */
export type InjectResult =
  /** Now in the input box. */
  | 'injected'
  /** The input box holds the user's own unsent text; left untouched. */
  | 'skipped'
  /** No input box reachable; the prompt was copied to the clipboard instead. */
  | 'clipboard'
  /** Neither worked. */
  | 'failed'

/**
 * Inject only into an empty input, or one that still holds exactly what we
 * injected last time. Anything else is the user's unsent edit.
 */
export function decideInjection(currentDraft: unknown, lastInjected: string | undefined): 'inject' | 'skip' {
  const draft = typeof currentDraft === 'string' ? currentDraft : ''
  if (draft.trim() === '') return 'inject'
  if (lastInjected !== undefined && draft === lastInjected) return 'inject'
  return 'skip'
}

interface SessionRow {
  id?: string
  retainedBy?: { mainView?: number }
}

/** The session shown in the main view, from a sessions list snapshot. */
export function mainSessionId(snapshot: unknown): string | undefined {
  const byId = (snapshot as { byId?: Record<string, SessionRow> } | undefined)?.byId ?? {}
  return Object.values(byId).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id
}

/** The slice of the client sessions service the composer uses. */
interface SessionsLike {
  list?: { getSnapshot?: () => unknown }
  scope?: (sessionId: string) => { get(name: string): unknown }
}

interface ComposerInput {
  snapshot?: unknown
  setDraft(text: string): void
  focus?: () => void
}

function readDraft(input: ComposerInput): string {
  try {
    const snap = typeof input.snapshot === 'function' ? (input.snapshot as () => unknown)() : input.snapshot
    const draft = (snap as { draft?: unknown } | undefined)?.draft
    return typeof draft === 'string' ? draft : ''
  } catch {
    return ''
  }
}

/** Fills the DSH input with prompts. */
export type Composer = (text: string) => Promise<InjectResult>

/**
 * @param getSessions - returns the client sessions service when it is available.
 * @param copy - clipboard writer (injectable for tests).
 */
export function createComposer(
  getSessions: () => unknown,
  copy: (text: string) => Promise<void> = text => navigator.clipboard.writeText(text),
): Composer {
  let lastInjected: string | undefined
  const fallback = async (text: string): Promise<InjectResult> => {
    try {
      await copy(text)
      return 'clipboard'
    } catch {
      return 'failed'
    }
  }
  return async (text) => {
    try {
      const sessions = getSessions() as SessionsLike | undefined
      const id = mainSessionId(sessions?.list?.getSnapshot?.())
      if (sessions?.scope === undefined || id === undefined) return fallback(text)
      const scoped = sessions.scope(id)
      const conversation = scoped.get('conversation') as { input?: { for(ctx: unknown): ComposerInput } } | undefined
      const input = conversation?.input?.for(scoped)
      if (input === undefined) return fallback(text)
      if (decideInjection(readDraft(input), lastInjected) === 'skip') return 'skipped'
      input.setDraft(text)
      lastInjected = text
      input.focus?.()
      return 'injected'
    } catch {
      return fallback(text)
    }
  }
}
