/**
 * glTF vendor bundle config — the three.js slice the gltf renderer uses
 * ships as ONE self-contained IIFE (lib/gltf-vendor.js) exposed as
 * 'window.__dshDpetGltf'. It rides the companions slot of both tsdown configs
 * so git installs (prepare) and dev builds emit the identical artifact. The
 * main client bundle stays untouched: installations without a gltf pet never
 * download or parse three.js.
 */
import type { UserConfig } from 'tsdown'

export function gltfVendorBundle(): UserConfig {
  return {
    name: 'dsh-dpet/gltf-vendor',
    entry: { 'gltf-vendor': 'src/client/renderers/gltf/vendor-entry.ts' },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    // Third-party stable code: minify to keep the published tarball lean.
    minify: true,
    clean: false,
    // Self-contained: the vendor file loads as a plain script tag with no
    // module table, so every dependency inlines (three.js is MIT).
    external: [],
    noExternal: [/.*/],
    outputOptions: {
      entryFileNames: 'gltf-vendor.js',
      // Classic-script top-level var: becomes window.__dshDpetGltf.
      name: '__dshDpetGltf',
    },
  }
}
