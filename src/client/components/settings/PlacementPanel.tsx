/**
 * Settings: where the pet sits (drag it in a scaled-down window), its size
 * and opacity, and the look-at-cursor / status-bubble switches.
 * @module dsh-dpet/client/components/settings/PlacementPanel
 */

import { useEffect, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { SETTINGS_LIMITS, type DpetSettings, type PetView } from '../../../shared/types.ts'
import { PET_ASPECT } from '../FloatingPet.tsx'
import { Switch } from '../common/Switch.tsx'
import { thumbOf } from '../../utils/pet-view.ts'
import { prefersReducedMotion } from '../../engine/reduced-motion.ts'
import { t } from '../../i18n/index.ts'
import css from '../../styles/dpet.module.css'

export function PlacementPanel(props: {
  pet: PetView
  settings: DpetSettings
  patch: (value: Partial<DpetSettings>) => void
}): ReactElement {
  const { settings, patch } = props
  return (
    <section className={css.section}>
      <h3>{t('place.title')}</h3>
      <p className={css.hint}>{t('place.hint')}</p>
      {prefersReducedMotion() && <p className={css.hint}>{t('place.reducedMotion')}</p>}
      <div className={css.place}>
        <MiniScreen pet={props.pet} settings={settings} onMove={(right, bottom) => patch({ right, bottom })} />
        <div className={css.controls}>
          <div>{t('place.position', { right: settings.right, bottom: settings.bottom })}</div>
          <div className={css.row}>
            <label htmlFor="dpet-size">{t('place.size')}</label>
            <input
              id="dpet-size"
              type="range"
              min={SETTINGS_LIMITS.size.min}
              max={SETTINGS_LIMITS.size.max}
              value={settings.size}
              onChange={e => patch({ size: Number(e.target.value) })}
            />
            <output>{settings.size} px</output>
          </div>
          <div className={css.row}>
            <label htmlFor="dpet-opacity">{t('place.opacity')}</label>
            <input
              id="dpet-opacity"
              type="range"
              min={SETTINGS_LIMITS.opacity.min * 100}
              max={100}
              value={Math.round(settings.opacity * 100)}
              onChange={e => patch({ opacity: Number(e.target.value) / 100 })}
            />
            <output>{Math.round(settings.opacity * 100)}%</output>
          </div>
          <div className={css.toggle}>
            <div>{t('place.look')}<small>{t('place.lookHint')}</small></div>
            <Switch checked={settings.lookAtCursor} label={t('place.look')} onChange={lookAtCursor => patch({ lookAtCursor })} />
          </div>
          <div className={css.toggle}>
            <div>{t('place.bubbles')}<small>{t('place.bubblesHint')}</small></div>
            <Switch checked={settings.bubbles} label={t('place.bubbles')} onChange={bubbles => patch({ bubbles })} />
          </div>
        </div>
      </div>
    </section>
  )
}

/** A scaled-down window where the pet can be dragged into place. */
function MiniScreen(props: { pet: PetView; settings: DpetSettings; onMove: (right: number, bottom: number) => void }): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null)
  const [box, setBox] = useState({ w: 400, h: 200 })

  useEffect(() => {
    const el = boxRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const vw = Math.max(1, window.innerWidth)
  const vh = Math.max(1, window.innerHeight)
  const sx = box.w / vw
  const sy = box.h / vh
  const height = Math.max(20, props.settings.size * sy)
  const width = height * PET_ASPECT
  const thumb = thumbOf(props.pet)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, right: props.settings.right, bottom: props.settings.bottom }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d === null) return
    const petW = props.settings.size * PET_ASPECT
    const right = Math.min(Math.max(0, d.right - (e.clientX - d.x) / sx), Math.max(0, vw - petW))
    const bottom = Math.min(Math.max(0, d.bottom - (e.clientY - d.y) / sy), Math.max(0, vh - props.settings.size))
    props.onMove(Math.round(right), Math.round(bottom))
  }

  return (
    <div ref={boxRef} className={css.screen}>
      <span className={css.screenLabel}>{t('place.window')}</span>
      <div className={css.fakeLines} />
      <div
        className={css.miniPet}
        style={{
          right: props.settings.right * sx,
          bottom: props.settings.bottom * sy,
          width,
          height,
          opacity: props.settings.opacity,
          ...(thumb === undefined
            ? { background: 'var(--dsw-alias-label-dimmed, #98a2b3)', borderRadius: 8 }
            : { backgroundImage: `url("${thumb}")` }),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
      />
    </div>
  )
}
