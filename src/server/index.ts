/**
 * DPet host half — runs inside the DSH host process.
 *
 * It follows the agent through the session events, keeps the pet library
 * (built-in pets plus imports under $DSH_HOME/dpet), persists the settings,
 * runs Tencent Hunyuan image-to-3D jobs with the user's own key, and serves
 * all of it to the browser half over same-origin routes. The browser half
 * (./client) draws the floating pet and the settings page.
 * @module dsh-dpet
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the ctx.tools merge.
import type {} from '@deepseek-ai/dsh-tools'
import { ActivityTracker } from './service/activity.ts'
import { resolveDshHome } from './common/files.ts'
import { PetLibrary } from './repository/library.ts'
import { makeRoutes } from './controller/routes.ts'
import { makeAgentTools } from './controller/agent-tools.ts'
import { makeGenerateRoutes } from './controller/generate-routes.ts'
import { SettingsStore } from './repository/settings.ts'
import { CredentialStore } from './repository/credentials.ts'
import { Generator } from './service/generator.ts'
import { clientFor, HunyuanError, mockClient, type HunyuanClient } from './service/hunyuan/client.ts'

export { ActivityTracker, projectSessionEvent, projectStreamFrame } from './service/activity.ts'
export { PetLibrary } from './repository/library.ts'
export { SettingsStore, sanitizeSettings, DEFAULT_SETTINGS } from './repository/settings.ts'
export { makeRoutes } from './controller/routes.ts'
export { makeAgentTools } from './controller/agent-tools.ts'
export { makeGenerateRoutes } from './controller/generate-routes.ts'
export { CredentialStore } from './repository/credentials.ts'
export { Generator } from './service/generator.ts'
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
  const credentials = new CredentialStore(join(dataDir, 'credentials.json'))
  // DPET_HUNYUAN_MOCK=1: generation answers with the built-in Dongdong model, no network.
  const mock = process.env.DPET_HUNYUAN_MOCK === '1'
  const mocked = mock ? mockClient(join(root, 'assets', 'pets', 'dongdong', 'dongdong.glb')) : undefined
  const client = (): HunyuanClient | undefined => {
    if (mocked !== undefined) return mocked
    const resolved = credentials.resolve()
    return resolved === undefined ? undefined : clientFor(resolved.credentials)
  }
  const generator = new Generator({ dir: join(dataDir, 'generate'), library, settings, credentials, client, mock })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    tracker.onSessionEvent(String(session.id), event)
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: { session: Session }; frame: AssistantStreamFrame }) => {
    tracker.onStreamFrame(String(agent.session.id), frame)
  })
  ctx.on('session/disposed', (session: Session) => {
    tracker.onSessionDisposed(String(session.id))
  })

  const routes = [
    ...makeRoutes({ tracker, library, settings, vendorDir: join(root, 'lib'), generation: generator }),
    ...makeGenerateRoutes({
      generator,
      credentials,
      check: async () => {
        const current = client()
        if (current === undefined) throw new HunyuanError('not-configured')
        await current.check()
      },
    }),
  ]
  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dpet: routes')

  // Jobs that were running when DSH stopped carry on; polling stops with the plugin.
  ctx.effect(() => {
    generator.resume()
    return () => generator.dispose()
  }, 'dpet: image-to-3D jobs')

  // Agent tools join only where the tool registry exists; the pet itself
  // keeps working without it.
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = makeAgentTools({ library, settings, generator })
    toolsCtx.effect(() => {
      const disposers = tools.map(tool => toolsCtx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dpet: agent tools')
  })
}
