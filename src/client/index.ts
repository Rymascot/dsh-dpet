/**
 * DPet browser half — runs inside the DSH web GUI.
 *
 * Mounts the floating pet as a page-global surface (it must survive session
 * switches and the new-conversation screen, so it lives on document.body,
 * not in a session-scoped slot) and seats the "桌宠" page in the settings
 * navigation.
 * @module dsh-dpet/client
 */

import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.slots merge and the settings slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createDpetStore } from './store/dpet.ts'
import { FloatingPet } from './components/FloatingPet.tsx'
import { SettingsPage } from './views/SettingsPage.tsx'
import { t } from './i18n/index.ts'

/** Client services the plugin needs. */
export const inject = ['slots']

/** Settings navigation position: right after the built-in sections. */
const SECTION_ORDER = 130

export function apply(ctx: Context): void {
  const store = createDpetStore()
  store.start()

  // One floating root per page: a hot-reloaded bundle first sweeps any root
  // an older instance left behind.
  for (const stale of Array.from(document.querySelectorAll('div[data-dsh-plugin="dpet"]'))) stale.remove()
  const container = document.createElement('div')
  container.dataset.dshPlugin = 'dpet'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(FloatingPet, { store }))

  const Section = (): ReactElement => createElement(SettingsPage, { store })

  ctx.slots.inject('settings.section', () => {
    try {
      return ctx.slots.register({
        name: 'settings.section',
        id: 'dpet',
        order: SECTION_ORDER,
        label: () => t('settings.title'),
      }, Section)
    } catch {
      return () => {}
    }
  })

  ctx.effect(() => () => {
    root.unmount()
    container.remove()
    store.stop()
  }, 'dpet: floating pet')
}
