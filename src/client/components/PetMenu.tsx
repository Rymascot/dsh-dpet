/**
 * The pet's right-click menu. "Ask the AI" items put a ready-made prompt in
 * the DSH input box (never sent automatically); the quick items change the
 * pet directly.
 * @module dsh-dpet/client/components/PetMenu
 */

import { useEffect, useRef, type ReactElement } from 'react'
import { t, type I18nKey } from '../i18n/index.ts'
import css from '../styles/dpet.module.css'

/** Menu entries that hand a prompt to the AI. */
export const PROMPT_ITEMS: readonly { label: I18nKey; prompt: I18nKey }[] = [
  { label: 'menu.aiSwitch', prompt: 'prompt.switch' },
  { label: 'menu.aiImport', prompt: 'prompt.import' },
  { label: 'menu.aiMotions', prompt: 'prompt.motions' },
  { label: 'menu.aiIntro', prompt: 'prompt.intro' },
]

/** Approximate menu box, for keeping it on screen. */
const MENU_W = 236
const MENU_H = 300

export interface PetMenuProps {
  /** Pointer position that opened the menu (viewport px). */
  x: number
  y: number
  onPrompt: (text: string) => void
  onResize: (delta: number) => void
  onHome: () => void
  onClose: () => void
}

export function PetMenu(props: PetMenuProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    ref.current?.querySelector('button')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const left = Math.max(8, Math.min(props.x - MENU_W, window.innerWidth - MENU_W - 8))
  const top = Math.max(8, Math.min(props.y - MENU_H / 2, window.innerHeight - MENU_H - 8))
  const run = (action: () => void) => () => { action(); props.onClose() }

  return (
    <div ref={ref} className={css.menu} role="menu" style={{ left, top, width: MENU_W }} onContextMenu={e => e.preventDefault()}>
      <div className={css.menuLabel}>{t('menu.sectionAi')}</div>
      {PROMPT_ITEMS.map(item => (
        <button key={item.label} type="button" role="menuitem" className={css.menuItem} onClick={run(() => props.onPrompt(t(item.prompt)))}>
          {t(item.label)}
        </button>
      ))}
      <div className={css.menuDivider} />
      <div className={css.menuLabel}>{t('menu.sectionQuick')}</div>
      <button type="button" role="menuitem" className={css.menuItem} onClick={run(() => props.onResize(40))}>{t('menu.bigger')}</button>
      <button type="button" role="menuitem" className={css.menuItem} onClick={run(() => props.onResize(-40))}>{t('menu.smaller')}</button>
      <button type="button" role="menuitem" className={css.menuItem} onClick={run(props.onHome)}>{t('menu.home')}</button>
    </div>
  )
}
