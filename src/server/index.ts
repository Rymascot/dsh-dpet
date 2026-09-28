/**
 * DPet host half — runs inside the DSH host process.
 *
 * It follows the agent through the session events, keeps the pet library
 * (built-in pets plus imports under $DSH_HOME/dpet), persists the settings,
 * and serves all of it to the browser half over same-origin routes. The
 * browser half (./client) draws the floating pet and the settings page.
 * @module dsh-dpet
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ActivityTracker } from './service/activity.ts'
import { resolveDshHome } from './common/files.ts'
import { PetLibrary } from './repository/library.ts'
import { makeRoutes } from './controller/routes.ts'
import { SettingsStore } from './repository/settings.ts'

export { ActivityTracker, projectSessionEvent, projectStreamFrame } from './service/activity.ts'
export { PetLibrary } from './repository/library.ts'
export { SettingsStore, sanitizeSettings, DEFAULT_SETTINGS } from './repository/settings.ts'
export { makeRoutes } from './controller/routes.ts'
export type * from '../shared/types.ts'

/** Stable cordis plugin name (matches the cordis.patch.yml row id). */
export const name = 'dpet'

/** The web server must be up before routes can register. */
export const inject = ['webServer']

/**
 * Package root: the nearest directory above this module holding package.json
 * (lib/index.js when built, src/server/index.ts in development).
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('dsh-dpet: package.json not found above ' + fileURLToPath(import.meta.url))
    dir = parent
  }
  return dir
}

/** Mount the activity tracker, the library, and the routes. */
export function apply(ctx: Context): void {
  const root = packageRoot()
  const dataDir = join(resolveDshHome(), 'dpet')
  const library = new PetLibrary({ builtin: join(root, 'assets', 'pets'), user: join(dataDir, 'pets') })
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  const tracker = new ActivityTracker()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    tracker.onSessionEvent(String(session.id), event)
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: { session: Session }; frame: AssistantStreamFrame }) => {
    tracker.onStreamFrame(String(agent.session.id), frame)
  })
  ctx.on('session/disposed', (session: Session) => {
    tracker.onSessionDisposed(String(session.id))
  })

  const routes = makeRoutes({ tracker, library, settings, vendorDir: join(root, 'lib') })
  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dpet: routes')
}
