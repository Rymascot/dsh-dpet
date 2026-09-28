/**
 * 3D runtime loading — fetches the plugin-shipped three.js vendor bundle
 * lazily through the plugin's own runtime route. It loads at most once per
 * page; concurrent mounts share the in-flight promise, and a failure is
 * cached as 'absent' so a broken install stops retrying the network every
 * mount (the live2d runtime discipline).
 *
 * The vendor type is taken from the entry module as a type-only import, so
 * this module never pulls three.js into the client bundle.
 * @module dsh-dpet/client/engine/gltf/runtime
 */

/** The vendor bundle global (window.__dshDpetGltf). */
export type GltfVendor = typeof import('./vendor-entry.ts')

/** Runtime file URL the host serves ('/api/pet/runtime/<name>'). */
const VENDOR_URL = '/api/dpet/runtime/gltf-vendor.js'

declare global {
  interface Window {
    __dshDpetGltf?: GltfVendor
  }
}

/** Injects one classic script tag; resolves on load, rejects on error. */
type ScriptInjector = (src: string) => Promise<void>

const defaultInjector: ScriptInjector = (src) => new Promise<void>((resolve, reject) => {
  const tag = document.createElement('script')
  tag.src = src
  tag.onload = () => resolve()
  tag.onerror = () => reject(new Error('script failed to load: ' + src))
  document.head.appendChild(tag)
})

/** Test seam: swap the network for a stub injector. */
export interface GltfRuntimeProbe {
  inject?: ScriptInjector
}

let vendorPromise: Promise<GltfVendor | undefined> | undefined

/** Ensure the vendor bundle global exists, injecting the script once when absent. */
export function ensureGltfVendor(probe: GltfRuntimeProbe = {}): Promise<GltfVendor | undefined> {
  if (typeof window !== 'undefined' && window.__dshDpetGltf !== undefined) return Promise.resolve(window.__dshDpetGltf)
  if (probe.inject !== undefined) {
    return probe.inject(VENDOR_URL)
      .then(() => typeof window !== 'undefined' ? window.__dshDpetGltf : undefined)
      .catch(() => undefined)
  }
  vendorPromise ??= defaultInjector(VENDOR_URL)
    .then(() => typeof window !== 'undefined' ? window.__dshDpetGltf : undefined)
    .catch(() => undefined)
  return vendorPromise
}

/** Reset the cached script promise (tests). */
export function resetGltfRuntime(): void {
  vendorPromise = undefined
}
