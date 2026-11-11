/**
 * Prepare a picture for Hunyuan image-to-3D. The API takes jpg / png / webp
 * with each side between 128 and 5000 px and at most 6 MB once base64
 * encoded. Pictures are upright-rotated by their EXIF orientation, bounded to
 * 2048 px, kept as PNG when they have transparency (a cut-out subject gives
 * the cleanest model) and as JPEG otherwise, and shrunk further until they
 * fit. A small thumbnail is made at the same time for the job list.
 * @module dsh-dpet/server/service/hunyuan/image
 */

import { sniffFormat } from '../importer.ts'

/** Accepted upload size for a generation picture. */
export const GENERATE_UPLOAD_LIMIT = 20 * 1024 * 1024
/** Raw size that stays under 6 MB after base64 (+33%). */
export const GENERATE_IMAGE_BYTES = 4_400_000
/** Side bounds of the Hunyuan API. */
export const GENERATE_MIN_EDGE = 128
export const GENERATE_MAX_EDGE = 5000
/** Edges tried, largest first. */
const EDGES = [2048, 1536, 1024, 768] as const
/** Edge of the job-list thumbnail. */
const THUMB_EDGE = 192

export interface PreparedImage {
  data: Uint8Array
  base64: string
  format: 'png' | 'jpg'
  width: number
  height: number
  /** PNG thumbnail for the job list. */
  thumbnail: Uint8Array
}

/** Output size for an upright picture: long side at most `edge`, short side at least the API minimum. */
export function fitEdges(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  let scale = Math.min(1, edge / long)
  if (short * scale < GENERATE_MIN_EDGE) scale = GENERATE_MIN_EDGE / short
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  if (Math.min(w, h) < GENERATE_MIN_EDGE || Math.max(w, h) > GENERATE_MAX_EDGE) throw new Error('image-bad-shape')
  return { width: w, height: h }
}

export async function prepareGenerateImage(input: Uint8Array): Promise<PreparedImage> {
  const format = sniffFormat(input)
  if (format === undefined || format === 'glb') throw new Error('unsupported-format')
  const { default: sharp } = await import('sharp')
  let meta
  try {
    meta = await sharp(input, { animated: false }).metadata()
  } catch {
    throw new Error('invalid-image')
  }
  if (meta.width === undefined || meta.height === undefined) throw new Error('invalid-image')
  // EXIF orientations 5-8 swap width and height once rotated upright.
  const swapped = (meta.orientation ?? 1) >= 5
  const upright = swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height }
  const alpha = meta.hasAlpha === true

  for (const edge of EDGES) {
    const size = fitEdges(upright.width, upright.height, edge)
    const pipeline = sharp(input, { animated: false }).rotate().resize(size.width, size.height, { fit: 'fill' })
    const data = alpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer()
    if (data.byteLength > GENERATE_IMAGE_BYTES) continue
    const thumbnail = await sharp(data).resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside' }).png().toBuffer()
    return {
      data,
      base64: data.toString('base64'),
      format: alpha ? 'png' : 'jpg',
      width: size.width,
      height: size.height,
      thumbnail,
    }
  }
  throw new Error('image-too-large')
}
