/**
 * The floating pet: a fixed-position stage anchored to the bottom-right of
 * the page. Drag it to move (the new position is saved), click it for a
 * squash and a reaction, right-click it for the menu (prompts for the AI and
 * quick size / position actions). Showing and hiding it lives in the
 * settings page.
 *
 * A 3D pet shown without a gallery thumbnail (e.g. imported by the AI through
 * the dpet_import tool) gets one captured here the first time it renders.
 *
 * The status bubble follows the pet's real head: the renderer reports where
 * the head is inside the box, and the bubble sits a size-proportional gap
 * above it, or below the pet when there is no room above.
 * @module dsh-dpet/client/components/FloatingPet
 */

import { useEffect, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { SETTINGS_LIMITS } from '../../shared/types.ts'
import { PetStage } from './PetStage.tsx'
import { PetMenu } from './PetMenu.tsx'
import { api } from '../api/dpet.ts'
import { useDpet, type DpetStore } from '../store/dpet.ts'
import type { PetHandle } from '../engine/flat.ts'
import { activityLine, tapLine } from '../utils/lines.ts'
import { bubbleLayout } from '../utils/bubble.ts'
import type { Composer } from '../utils/composer.ts'
import { thumbnailFrom } from '../utils/import-report.ts'
import { t, type I18nKey } from '../i18n/index.ts'
import css from '../styles/dpet.module.css'

/** Width of the pet box relative to its height. */
export const PET_ASPECT = 0.85
/** A pointer that moves farther than this is a drag, not a click. */
const DRAG_SLOP = 4
/** How long a tap reaction or a menu notice stays up. */
const TAP_LINE_MS = 2600
/** The resting corner "back to the bottom right" returns to. */
const HOME = { right: 32, bottom: 24 }

/** Keep the pet box fully inside the viewport. */
export function clampInset(right: number, bottom: number, width: number, height: number): { right: number; bottom: number } {
  const maxRight = Math.max(0, window.innerWidth - width)
  const maxBottom = Math.max(0, window.innerHeight - height)
  return { right: Math.min(Math.max(0, right), maxRight), bottom: Math.min(Math.max(0, bottom), maxBottom) }
}

export function FloatingPet(props: { store: DpetStore; composer: Composer }): ReactElement | null {
  const { state } = useDpet(props.store)
  const handleRef = useRef<PetHandle | undefined>(undefined)
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null)
  const [drag, setDrag] = useState<{ right: number; bottom: number } | null>(null)
  const [tap, setTap] = useState<{ text: string; n: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const thumbnailed = useRef(new Set<string>())
  const tapCount = useRef(0)
  const [headTop, setHeadTop] = useState<number | undefined>(undefined)
  const [, forceLayout] = useState(0)

  useEffect(() => {
    if (tap === null) return undefined
    const timer = window.setTimeout(() => setTap(null), TAP_LINE_MS)
    return () => window.clearTimeout(timer)
  }, [tap])

  // Re-clamp against the viewport when the window resizes.
  useEffect(() => {
    const onResize = (): void => forceLayout(n => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (state === undefined || !state.settings.enabled) return null
  const { settings, pet, activity } = state
  const height = settings.size
  const width = Math.round(settings.size * PET_ASPECT)
  const pos = clampInset(drag?.right ?? settings.right, drag?.bottom ?? settings.bottom, width, height)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d === null) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    d.moved = true
    setDrag(clampInset(d.right - dx, d.bottom - dy, width, height))
  }
  const onPointerUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (d === null) return
    if (d.moved) {
      if (drag !== null) props.store.patchSettings({ right: Math.round(drag.right), bottom: Math.round(drag.bottom) })
      setDrag(null)
      return
    }
    handleRef.current?.tap()
    const n = tapCount.current++
    setTap({ text: tapLine(pet.name, n), n })
  }

  const notify = (text: string): void => {
    const n = tapCount.current++
    setTap({ text, n })
  }
  const onPrompt = (text: string): void => {
    void props.composer(text).then(result => notify(t(('notice.' + result) as I18nKey)))
  }
  const onResize = (delta: number): void => {
    const size = Math.min(SETTINGS_LIMITS.size.max, Math.max(SETTINGS_LIMITS.size.min, settings.size + delta))
    props.store.patchSettings({ size })
  }

  // Capture a gallery thumbnail for a 3D pet that has none yet.
  const onReady = (handle: PetHandle): void => {
    if (pet.kind !== '3d' || pet.previewUrl !== undefined || pet.builtin || thumbnailed.current.has(pet.id)) return
    thumbnailed.current.add(pet.id)
    const dataUrl = handle.snapshot()
    if (dataUrl === undefined) return
    void thumbnailFrom(dataUrl).then(async (blob) => {
      if (blob === undefined) return
      const saved = await api.setPreview(pet.id, blob)
      if (saved.ok) await props.store.refreshPets()
    })
  }

  const statusLine = settings.bubbles && activity.phase !== 'idle' ? activityLine(activity, pet.name) : undefined
  const bubble = tap?.text ?? statusLine
  const place = bubbleLayout(height, headTop, pos.bottom, window.innerHeight)

  return (
    <>
    <div
      className={css.float}
      style={{ right: pos.right, bottom: pos.bottom, width, height, opacity: settings.opacity }}
      data-dpet-floating={pet.id}
    >
      {bubble !== undefined && (
        <div
          key={bubble}
          className={css.bubble}
          style={{
            ...(place.bottom === undefined ? { top: place.top } : { bottom: place.bottom }),
            fontSize: place.fontSize,
            maxWidth: place.maxWidth,
          }}
        >
          {bubble}
        </div>
      )}
      <div
        className={css.floatStage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; setDrag(null) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <PetStage
          pet={pet}
          phase={activity.phase}
          motions={settings.motions}
          lookAtCursor={settings.lookAtCursor}
          style={{ width: '100%', height: '100%' }}
          onHandle={(handle) => { handleRef.current = handle }}
          onReady={onReady}
          onLayout={setHeadTop}
        />
      </div>
    </div>
    {menu !== null && (
      <PetMenu
        x={menu.x}
        y={menu.y}
        onPrompt={onPrompt}
        onResize={onResize}
        onHome={() => props.store.patchSettings(HOME)}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  )
}
