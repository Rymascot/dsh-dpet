/**
 * 3D renderer — mounts a self-contained .glb into a container through the
 * lazily loaded three.js vendor bundle. `mountGltf` returns synchronously;
 * the boot (vendor script, then model) continues asynchronously and reports
 * through `onReady` / `onError`. Disposing mid-boot is race-safe.
 *
 * Motion model: image-to-3D meshes ship without a skeleton, so each activity
 * phase maps to a procedural whole-body motion (./motion.ts) applied to a
 * bottom-center pivot. Taps layer a jelly squash on top, and the model can
 * turn slightly toward the pointer. A soft contact shadow stays on the
 * ground and shrinks while the pet is in the air. Motions and pointer-follow
 * update live, without reloading the model.
 * @module dsh-dpet/client/engine/gltf
 */

import type { ActivityPhase, PetMotion } from '../../shared/types.ts'
import type { PhaseSource } from './phase-stream.ts'
import { ensureGltfVendor, type GltfVendor } from './gltf/runtime.ts'
import { motionForPhase, motionPose, tapSquash } from './motion.ts'

/** Mount options. */
export interface GltfMountOptions {
  container: HTMLElement
  modelUrl: string
  phase: PhaseSource
  motions?: Partial<Record<ActivityPhase, PetMotion>>
  lookAtCursor?: boolean
}

/** Fatal mount failure codes. */
export type GltfErrorCode = 'vendor-missing' | 'load-failed'

/** A mounted 3D pet. */
export interface GltfHandle {
  /** Play the tap squash. */
  tap(): void
  /** Replace the per-phase motion overrides (restarts the current motion). */
  setMotions(motions: Partial<Record<ActivityPhase, PetMotion>> | undefined): void
  /** Toggle turning toward the pointer. */
  setLookAtCursor(enabled: boolean): void
  /** Render one frame and return it as a PNG data URL (undefined before the model loads). */
  snapshot(): string | undefined
  /** Called once the model is on screen. */
  onReady(listener: () => void): void
  /**
   * Called after every layout with the distance in px from the container top
   * to the top of the pet at rest, so overlays (the status bubble) can sit
   * just above its head whatever the framing.
   */
  onLayout(listener: (headTopPx: number) => void): void
  /** Called at most once on a fatal failure. */
  onError(listener: (code: GltfErrorCode) => void): void
  /** Tear everything down; safe to call repeatedly. */
  dispose(): void
}

/** Frame budget: a desktop pet never needs more than ~30 fps. */
const FRAME_MS = 1000 / 30
/** Headroom above the model so hops and cheers stay inside the canvas. */
const HEADROOM = 1.3
/** Ground margin below the feet, so perspective never clips feet reaching toward the camera. */
const FOOTROOM = 0.08
/** Max yaw toward the pointer, in radians. */
const LOOK_YAW = 0.35
/** Pointer distance (px) at which the look reaches half strength; it saturates smoothly beyond. */
const LOOK_HALF = 300
/** Resting shadow opacity. */
const SHADOW_ALPHA = 0.32
/** Lift (in model heights) at which the shadow is smallest. */
const SHADOW_LIFT = 0.2

type Renderer = InstanceType<GltfVendor['WebGLRenderer']>
type Camera = InstanceType<GltfVendor['PerspectiveCamera']>
type Scene = InstanceType<GltfVendor['Scene']>

/** Release GPU resources held by a loaded scene graph. */
function disposeScene(root: { traverse(fn: (node: unknown) => void): void }): void {
  root.traverse((node) => {
    const mesh = node as { isMesh?: boolean; geometry?: { dispose(): void }; material?: unknown }
    if (mesh.isMesh !== true) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials as ({ dispose(): void } & Record<string, unknown>)[]) {
      if (material === undefined || material === null) continue
      for (const value of Object.values(material)) {
        const texture = value as { isTexture?: boolean; dispose?: () => void } | null
        if (texture !== null && typeof texture === 'object' && texture.isTexture === true) texture.dispose?.()
      }
      material.dispose()
    }
  })
}

/** Mount a 3D pet into a container. */
export function mountGltf(options: GltfMountOptions): GltfHandle {
  const { container, phase } = options
  let disposed = false
  let ready = false
  let readyListener: (() => void) | undefined
  let layoutListener: ((headTopPx: number) => void) | undefined
  let headTop: number | undefined
  let errorListener: ((code: GltfErrorCode) => void) | undefined
  let motions = options.motions
  let lookAtCursor = options.lookAtCursor ?? true
  let tapAt: number | undefined
  let motion: PetMotion = motionForPhase(phase.get(), motions)
  let motionStart = performance.now()
  let renderFrame: (() => void) | undefined
  let canvas: HTMLCanvasElement | undefined
  const teardown: (() => void)[] = []

  const destroy = (): void => {
    for (const fn of teardown.splice(0).reverse()) {
      try { fn() } catch {}
    }
  }

  const applyPhase = (next: ActivityPhase): void => {
    motion = motionForPhase(next, motions)
    motionStart = performance.now()
  }

  const boot = async (): Promise<void> => {
    const vendor = await ensureGltfVendor()
    if (disposed) return
    if (vendor === undefined) {
      errorListener?.('vendor-missing')
      return
    }
    const gltf = await new vendor.GLTFLoader().loadAsync(options.modelUrl)
    if (disposed) {
      disposeScene(gltf.scene)
      return
    }
    teardown.push(() => disposeScene(gltf.scene))

    // Bottom-center of the model sits on the pivot origin, so squash and hop
    // read as if the pet stands on the ground.
    const box = new vendor.Box3().setFromObject(gltf.scene)
    const size = box.getSize(new vendor.Vector3())
    const center = box.getCenter(new vendor.Vector3())
    const height = Math.max(size.y, 1e-6)
    gltf.scene.position.set(-center.x, -box.min.y, -center.z)
    const pivot = new vendor.Group()
    pivot.add(gltf.scene)

    const scene: Scene = new vendor.Scene()
    scene.add(pivot)

    // Contact shadow: a radial gradient on a ground quad (not a child of the
    // pivot, so it stays down while the pet hops).
    const shadowCanvas = document.createElement('canvas')
    shadowCanvas.width = shadowCanvas.height = 64
    const sg = shadowCanvas.getContext('2d')
    if (sg !== null) {
      const gradient = sg.createRadialGradient(32, 32, 0, 32, 32, 32)
      gradient.addColorStop(0, 'rgba(0,0,0,1)')
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      sg.fillStyle = gradient
      sg.fillRect(0, 0, 64, 64)
    }
    const shadowTexture = new vendor.CanvasTexture(shadowCanvas)
    const shadowMaterial = new vendor.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: SHADOW_ALPHA })
    const shadowGeometry = new vendor.PlaneGeometry(1, 1)
    const shadow = new vendor.Mesh(shadowGeometry, shadowMaterial)
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = height * 0.002
    const footprint = Math.max(size.x, size.z) * 0.95
    shadow.scale.set(footprint, footprint * 0.7, 1)
    shadow.renderOrder = -1
    scene.add(shadow)
    teardown.push(() => {
      shadowGeometry.dispose()
      shadowMaterial.dispose()
      shadowTexture.dispose()
    })
    scene.add(new vendor.HemisphereLight(0xffffff, 0x888888, 2))
    const key = new vendor.DirectionalLight(0xffffff, 1.5)
    key.position.set(1, 2, 3)
    scene.add(key)

    const renderer: Renderer = new vendor.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    teardown.push(() => {
      renderer.domElement.remove()
      renderer.dispose()
    })
    renderer.outputColorSpace = vendor.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    // Fit the model height (plus headroom) into the vertical field of view.
    const camera: Camera = new vendor.PerspectiveCamera(30, 1, 0.01, 100)
    const layout = (): void => {
      const width = Math.max(1, Math.round(container.clientWidth || 160))
      const heightPx = Math.max(1, Math.round(container.clientHeight || 180))
      renderer.setSize(width, heightPx, false)
      camera.aspect = width / heightPx
      const vFov = (camera.fov * Math.PI) / 180
      const byHeight = (height * (HEADROOM + FOOTROOM)) / 2 / Math.tan(vFov / 2)
      const byWidth = (Math.max(size.x, size.z) * 0.6) / (Math.tan(vFov / 2) * camera.aspect)
      const aim = (height * (HEADROOM - FOOTROOM)) / 2
      camera.position.set(0, aim, Math.max(byHeight, byWidth))
      camera.lookAt(0, aim, 0)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      // The top-front edge of the model is its highest point on screen.
      const top = new vendor.Vector3(0, height, size.z / 2).project(camera)
      headTop = Math.max(0, ((1 - top.y) / 2) * heightPx)
      layoutListener?.(headTop)
    }
    layout()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => layout())
      observer.observe(container)
      teardown.push(() => observer.disconnect())
    }

    applyPhase(phase.get())
    teardown.push(phase.subscribe(applyPhase))

    let lookTarget = 0
    let look = 0
    const onPointerMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect()
      const dx = event.clientX - (rect.left + rect.width / 2)
      lookTarget = (dx / (Math.abs(dx) + LOOK_HALF)) * LOOK_YAW
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    teardown.push(() => window.removeEventListener('pointermove', onPointerMove))

    let last = 0
    const draw = (now: number, dt: number): void => {
      const pose = motionPose(motion, (now - motionStart) / 1000)
      const squash = tapSquash(tapAt === undefined ? -1 : (now - tapAt) / 1000)
      look += ((lookAtCursor ? lookTarget : 0) - look) * Math.min(1, dt * 4)
      pivot.position.y = pose.y * height
      pivot.rotation.set(pose.pitch, pose.yaw + look, pose.roll)
      pivot.scale.set(pose.sx * squash.sx, pose.sy * squash.sy, pose.sz * squash.sx)
      const lifted = Math.min(1, Math.max(0, pose.y) / SHADOW_LIFT)
      const shrink = 1 - lifted * 0.45
      shadow.scale.set(footprint * shrink, footprint * 0.7 * shrink, 1)
      shadowMaterial.opacity = SHADOW_ALPHA * (1 - lifted * 0.6)
      renderer.render(scene, camera)
    }
    renderFrame = () => draw(performance.now(), 0)
    let frame = 0
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      if (now - last < FRAME_MS) return
      const dt = last === 0 ? 0 : (now - last) / 1000
      last = now
      draw(now, dt)
    }
    frame = requestAnimationFrame(tick)
    teardown.push(() => cancelAnimationFrame(frame))
    ready = true
    readyListener?.()
  }

  void boot().catch(() => {
    destroy()
    if (!disposed) errorListener?.('load-failed')
  })

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
    snapshot() {
      if (!ready || renderFrame === undefined || canvas === undefined) return undefined
      // Render and read back in the same task: the drawing buffer is still
      // intact, so no preserveDrawingBuffer (and its per-frame cost) is needed.
      renderFrame()
      return canvas.toDataURL('image/png')
    },
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
      destroy()
    },
  }
}
