/**
 * Import pipeline — turns an uploaded file into a pet-ready asset.
 *
 * 3D (.glb): AI image-to-3D tools emit meshes with a million-plus triangles
 * and 4K textures (the Dongdong model arrived at 76 MB). A desktop pet is a
 * few hundred pixels tall, so the pipeline welds and decimates the mesh to
 * about 50k triangles and re-encodes textures as 1024 px WebP. The output
 * stays uncompressed geometry (no Draco / meshopt) because the browser
 * vendor bundle ships no decoders.
 *
 * 2D (.png/.jpg/.webp): a uniform backdrop (white paper, a studio color) is
 * cleared to transparency (./background.ts), then transparent borders are
 * trimmed and the image is bounded to 512 px. The caller may keep the
 * backdrop instead. GIFs are kept byte-for-byte so their animation survives.
 * @module dsh-dpet/server/service/importer
 */

import { removeUniformBackground } from './background.ts'
import type { BackgroundMode, ImportReport, PetKind } from '../../shared/types.ts'

/** Accepted upload formats. */
export type ImportFormat = ImportReport['format']

/** Upload ceilings per kind. */
export const IMPORT_LIMITS = {
  glb: 300 * 1024 * 1024,
  image: 20 * 1024 * 1024,
} as const

/** Target triangle budget for imported models. */
export const TARGET_TRIANGLES = 50_000
/** Texture edge length after import. */
export const TEXTURE_SIZE = 1024
/** Longest edge of an imported flat image. */
export const IMAGE_EDGE = 512
/** Working resolution for backdrop removal (twice the final edge, for clean rims). */
const WORK_EDGE = IMAGE_EDGE * 2

/** Identify an upload by its magic bytes (the file name is only a hint). */
export function sniffFormat(data: Uint8Array): ImportFormat | undefined {
  const at = (i: number): number => data[i] ?? -1
  const ascii = (from: number, text: string): boolean => [...text].every((c, i) => at(from + i) === c.charCodeAt(0))
  if (ascii(0, 'glTF')) return 'glb'
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (ascii(0, 'GIF8')) return 'gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp'
  return undefined
}

/** The pet kind a format produces. */
export function kindOf(format: ImportFormat): PetKind {
  return format === 'glb' ? '3d' : '2d'
}

/** Decimation ratio that brings a mesh to the triangle budget (1 = keep). */
export function simplifyRatio(triangles: number, target: number = TARGET_TRIANGLES): number {
  if (triangles <= target * 1.2) return 1
  return target / triangles
}

/** Result of processing one upload. */
export interface ProcessedAsset {
  data: Uint8Array
  /** File name to store the asset under. */
  file: string
  report: ImportReport
}

/** Count rendered triangles of a glTF document. */
async function countTriangles(doc: import('@gltf-transform/core').Document): Promise<number> {
  let total = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue // TRIANGLES
      const indices = prim.getIndices()
      const position = prim.getAttribute('POSITION')
      total += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3)
    }
  }
  return total
}

/** Optimize a binary glTF for real-time display. */
export async function processGlb(input: Uint8Array): Promise<ProcessedAsset> {
  const [{ NodeIO }, { ALL_EXTENSIONS }, fns, { MeshoptSimplifier }, sharpModule] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('@gltf-transform/functions'),
    import('meshoptimizer'),
    import('sharp'),
  ])
  await MeshoptSimplifier.ready
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  let doc
  try {
    doc = await io.readBinary(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(/draco|meshopt/i.test(message) ? 'compressed-glb-unsupported' : 'invalid-glb')
  }
  const originalTriangles = await countTriangles(doc)
  const ratio = simplifyRatio(originalTriangles)
  const steps = [fns.dedup(), fns.prune()]
  if (ratio < 1) {
    steps.push(fns.weld(), fns.simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002 }))
  }
  if (doc.getRoot().listTextures().length > 0) {
    steps.push(fns.textureCompress({
      encoder: sharpModule.default,
      targetFormat: 'webp',
      resize: [TEXTURE_SIZE, TEXTURE_SIZE],
    }))
  }
  steps.push(fns.prune())
  await doc.transform(...steps)
  const data = await io.writeBinary(doc)
  return {
    data,
    file: 'model.glb',
    report: {
      kind: '3d',
      format: 'glb',
      originalBytes: input.byteLength,
      finalBytes: data.byteLength,
      originalTriangles,
      finalTriangles: await countTriangles(doc),
      textureSize: TEXTURE_SIZE,
    },
  }
}

/** Normalize a flat image (GIFs pass through to keep their animation). */
export async function processImage(
  input: Uint8Array,
  format: Exclude<ImportFormat, 'glb'>,
  background: BackgroundMode = 'remove',
): Promise<ProcessedAsset> {
  if (format === 'gif') {
    return {
      data: input,
      file: 'image.gif',
      report: { kind: '2d', format, originalBytes: input.byteLength, finalBytes: input.byteLength },
    }
  }
  const sharp = (await import('sharp')).default
  let data: Uint8Array
  let verdict: NonNullable<ImportReport['background']> = 'kept'
  let color: string | undefined
  try {
    const raw = await sharp(input)
      .rotate()
      .resize({ width: WORK_EDGE, height: WORK_EDGE, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength)
    if (background === 'remove') {
      const result = removeUniformBackground(pixels, raw.info.width, raw.info.height)
      verdict = result.verdict
      color = result.color
    }
    data = await sharp(pixels, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
      .trim({ threshold: 8 })
      .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer()
  } catch {
    throw new Error('invalid-image')
  }
  return {
    data,
    file: 'image.png',
    report: {
      kind: '2d',
      format,
      originalBytes: input.byteLength,
      finalBytes: data.byteLength,
      background: verdict,
      ...(color === undefined || verdict !== 'removed' ? {} : { backgroundColor: color }),
    },
  }
}

/** Sniff, bound, and process one upload. */
export async function processUpload(input: Uint8Array, background: BackgroundMode = 'remove'): Promise<ProcessedAsset> {
  const format = sniffFormat(input)
  if (format === undefined) throw new Error('unsupported-format')
  const limit = format === 'glb' ? IMPORT_LIMITS.glb : IMPORT_LIMITS.image
  if (input.byteLength > limit) throw new Error('file-too-large')
  return format === 'glb' ? processGlb(input) : processImage(input, format, background)
}
