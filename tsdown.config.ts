import { clientBundle } from './shared/tsdown.client.ts'
import { gltfVendorBundle } from './tsdown.gltf-vendor.ts'

export default clientBundle('dsh-dpet', ['src/server/index.ts'], {
  companions: [gltfVendorBundle()],
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-settings',
    /^@gltf-transform\//,
    'meshoptimizer',
    'sharp',
  ],
})
