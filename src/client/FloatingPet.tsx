/**
 * The floating pet: a fixed-position stage anchored to the bottom-right of
 * the page. Drag it to move (the new position is saved), click it for a
 * squash and a reaction. Showing and hiding it lives in the settings page.
 *
 * The status bubble follows the pet's real head: the renderer reports where
 * the head is inside the box, and the bubble sits a size-proportional gap
 * above it, or below the pet when there is no room above.
 * @module dsh-dpet/client/FloatingPet
 */

import { useEffect, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { PetStage } from './PetStage.tsx'
import { useDpet, type DpetStore } from './store.ts'
import type { PetHandle } from './renderers/flat.ts'
import { activityLine, tapLine } from './lines.ts'
import { bubbleLayout } from './bubble.ts'
import css from './dpet.module.css'

/** Width of the pet box relative to its height. */
export const PET_ASPECT = 0.85
/** A pointer that moves farther than this is a drag, not a click. */
const DRAG_SLOP = 4
/** How long a tap reaction stays up. */
const TAP_LINE_MS = 2600

/** Keep the pet box fully inside the viewport. */
export function clampInset(right: number, bottom: number, width: number, height: number): { right: number; bottom: number } {
  const maxRight = Math.max(0, window.innerWidth - width)
  const maxBottom = Math.max(0, window.innerHeight - height)
  return { right: Math.min(Math.max(0, right), maxRight), bottom: Math.min(Math.max(0, bottom), maxBottom) }
}

export function FloatingPet(props: { store: DpetStore }): ReactElement | null {
  const { state } = useDpet(props.store)
  const handleRef = useRef<PetHandle | undefined>(undefined)
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null)
  const [drag, setDrag] = useState<{ right: number; bottom: number } | null>(null)
  const [tap, setTap] = useState<{ text: string; n: number } | null>(null)
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

  const statusLine = settings.bubbles && activity.phase !== 'idle' ? activityLine(activity, pet.name) : undefined
  const bubble = tap?.text ?? statusLine
  const place = bubbleLayout(height, headTop, pos.bottom, window.innerHeight)

  return (
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
      >
        <PetStage
          pet={pet}
          phase={activity.phase}
          motions={settings.motions}
          lookAtCursor={settings.lookAtCursor}
          style={{ width: '100%', height: '100%' }}
          onHandle={(handle) => { handleRef.current = handle }}
          onLayout={setHeadTop}
        />
      </div>
    </div>
  )
}
