/**
 * 2D renderer — draws a picture (PNG / JPG / WebP / GIF) with the SAME
 * procedural motions as the 3D renderer, but deformed like jelly instead of
 * moved like a card (./jelly.ts): the picture is cut into horizontal strips
 * that bend, breathe and squash by their height above the feet, turns become
 * a small perspective tilt, and a soft shadow grounds the pet. GIFs keep
 * playing: every frame draws the picture's current animation frame.
 *
 * The canvas is larger than the pet box (headroom for hops, side room for
 * bends, a strip below for the shadow) and sits behind the box without
 * taking pointer events.
 * @module dsh-dpet/client/renderers/flat
 */

import type { ActivityPhase, PetMotion } from '../../types.ts'
import type { PhaseSource } from '../phase-stream.ts'
import type { GltfErrorCode, GltfHandle } from './gltf.ts'
import { jellyFrame } from './jelly.ts'
import { motionForPhase, motionPose, tapSquash } from './motion.ts'

/** The handle shape both renderers share. */
export type PetHandle = GltfHandle
export type PetErrorCode = GltfErrorCode

/** Mount options. */
export interface FlatMountOptions {
  container: HTMLElement
  imageUrl: string
  phase: PhaseSource
  motions?: Partial<Record<ActivityPhase, PetMotion>>
  lookAtCursor?: boolean
}

/** Frame budget, matching the 3D renderer. */
const FRAME_MS = 1000 / 30
/** Pointer distance (px) at which the look reaches half strength; it saturates smoothly beyond. */
const LOOK_HALF = 300
/** Canvas margins around the pet box, as fractions of the box height. */
const MARGIN = { top: 0.35, side: 0.3, bottom: 0.1 }
/** Resting shadow opacity. */
const SHADOW_ALPHA = 0.28

/** Mount a 2D pet into a container. */
export function mountFlat(options: FlatMountOptions): PetHandle {
  const { container, phase } = options
  let disposed = false
  let ready = false
  let readyListener: (() => void) | undefined
  let layoutListener: ((headTopPx: number) => void) | undefined
  let headTop: number | undefined
  let errorListener: ((code: PetErrorCode) => void) | undefined
  let motions = options.motions
  let lookAtCursor = options.lookAtCursor ?? true
  let motion: PetMotion = motionForPhase(phase.get(), motions)
  let motionStart = performance.now()
  let tapAt: number | undefined
  let lookTarget = 0
  let look = 0

  const wrap = document.createElement('div')
  Object.assign(wrap.style, { position: 'relative', width: '100%', height: '100%', pointerEvents: 'none' })
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none' })
  // The source picture stays in the document (invisible) so GIFs keep animating.
  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'async'
  Object.assign(img.style, { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' })
  wrap.append(canvas, img)
  container.appendChild(wrap)
  const ctx = canvas.getContext('2d')

  // Geometry of the current layout, in CSS px.
  let box = { w: 0, h: 0 }
  let pic = { w: 0, h: 0 }
  let foot = { x: 0, y: 0 }
  let dpr = 1

  const layout = (): void => {
    if (!ready) return
    box = { w: Math.max(1, container.clientWidth), h: Math.max(1, container.clientHeight) }
    const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight)
    pic = { w: img.naturalWidth * scale, h: img.naturalHeight * scale }
    const top = box.h * MARGIN.top
    const side = box.h * MARGIN.side
    const cssW = box.w + side * 2
    const cssH = box.h + top + box.h * MARGIN.bottom
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    Object.assign(canvas.style, { left: -side + 'px', top: -top + 'px', width: cssW + 'px', height: cssH + 'px' })
    foot = { x: side + box.w / 2, y: top + box.h }
    canvas.style.transformOrigin = `${foot.x}px ${foot.y}px`
    const next = Math.max(0, box.h - pic.h)
    if (next !== headTop) {
      headTop = next
      layoutListener?.(next)
    }
  }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(layout)
  observer?.observe(container)

  const draw = (now: number): void => {
    if (ctx === null || pic.h === 0) return
    const t = (now - motionStart) / 1000
    const squash = tapSquash(tapAt === undefined ? -1 : (now - tapAt) / 1000)
    const frame = jellyFrame(lag => motionPose(motion, Math.max(0, t - lag)), squash, look)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)

    // Soft contact shadow under the feet.
    const rx = pic.w * 0.34 * frame.shadowScale
    const ry = Math.max(2, pic.h * 0.045 * frame.shadowScale)
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    gradient.addColorStop(0, `rgba(0,0,0,${SHADOW_ALPHA * frame.shadowAlpha})`)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save()
    ctx.translate(foot.x, foot.y - ry * 0.25)
    ctx.scale(rx, ry)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // The picture, strip by strip (0.6 px overlap hides seams), tipped
    // rigidly around the feet toward the pointer.
    const srcH = img.naturalHeight
    ctx.save()
    ctx.translate(foot.x, foot.y)
    ctx.rotate(frame.roll)
    ctx.translate(-foot.x, -foot.y)
    for (const strip of frame.strips) {
      const w = pic.w * strip.width
      const h = pic.h * strip.height
      const x = foot.x + strip.x * pic.h - w / 2
      const y = foot.y - strip.top * pic.h
      ctx.drawImage(img, 0, strip.v0 * srcH, img.naturalWidth, (strip.v1 - strip.v0) * srcH, x, y, w, h + 0.6)
    }
    ctx.restore()
    canvas.style.transform = frame.tilt === 0 ? '' : `perspective(${Math.round(box.h * 4)}px) rotateY(${frame.tilt.toFixed(4)}rad)`
  }

  const applyPhase = (next: ActivityPhase): void => {
    motion = motionForPhase(next, motions)
    motionStart = performance.now()
  }
  const unsubscribe = phase.subscribe(applyPhase)

  const onPointerMove = (event: PointerEvent): void => {
    const rect = container.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    lookTarget = dx / (Math.abs(dx) + LOOK_HALF)
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })

  let frameId = 0
  let last = 0
  const tick = (now: number): void => {
    frameId = requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    const dt = last === 0 ? 0 : (now - last) / 1000
    last = now
    look += ((lookAtCursor ? lookTarget : 0) - look) * Math.min(1, dt * 4)
    draw(now)
  }

  img.onload = () => {
    if (disposed) return
    ready = true
    layout()
    frameId = requestAnimationFrame(tick)
    readyListener?.()
  }
  img.onerror = () => {
    if (!disposed) errorListener?.('load-failed')
  }
  img.src = options.imageUrl

  return {
    tap() {
      if (!disposed) tapAt = performance.now()
    },
    setMotions(next) {
      motions = next
      applyPhase(phase.get())
    },
    setLookAtCursor(enabled) {
      lookAtCursor = enabled
    },
    snapshot: () => undefined,
    onReady(listener) {
      readyListener = listener
      if (ready) listener()
    },
    onLayout(listener) {
      layoutListener = listener
      if (headTop !== undefined) listener(headTop)
    },
    onError(listener) {
      errorListener = listener
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frameId)
      observer?.disconnect()
      unsubscribe()
      window.removeEventListener('pointermove', onPointerMove)
      wrap.remove()
    },
  }
}
