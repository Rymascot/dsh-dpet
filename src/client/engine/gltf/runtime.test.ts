// @vitest-environment jsdom
/**
 * glTF runtime loader tests — global short-circuit, probe injection
 * success/failure, and the runtime-route URL the host serves.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ensureGltfVendor, resetGltfRuntime, type GltfVendor } from './runtime.ts'

afterEach(() => {
  resetGltfRuntime()
  delete window.__dshDpetGltf
})

describe('ensureGltfVendor', () => {
  it('short-circuits when the global already exists', async () => {
    const vendor = {} as GltfVendor
    window.__dshDpetGltf = vendor
    await expect(ensureGltfVendor({ inject: () => Promise.reject(new Error('must not inject')) })).resolves.toBe(vendor)
  })

  it('injects the runtime-route vendor URL and reads the global afterwards', async () => {
    const seen: string[] = []
    const vendor = {} as GltfVendor
    const loaded = await ensureGltfVendor({
      inject: (src) => {
        seen.push(src)
        window.__dshDpetGltf = vendor
        return Promise.resolve()
      },
    })
    expect(loaded).toBe(vendor)
    expect(seen).toEqual(['/api/dpet/runtime/gltf-vendor.js'])
  })

  it('resolves undefined when the script fails to load', async () => {
    await expect(ensureGltfVendor({ inject: () => Promise.reject(new Error('404')) })).resolves.toBeUndefined()
  })
})
