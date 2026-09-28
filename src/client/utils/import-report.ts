/**
 * Import helpers: accepted files, error copy, the step list shown after an
 * import, and the thumbnail cropper for freshly imported 3D models.
 * @module dsh-dpet/client/utils/import-report
 */

import type { ImportReport } from '../../shared/types.ts'
import { formatBytes, formatCount, t, type I18nKey } from '../i18n/index.ts'

/** File types the import button accepts. */
export const ACCEPT = '.glb,.png,.jpg,.jpeg,.webp,.gif'

/** Pictures that go through the before / after review (GIFs keep their animation, models skip it). */
export const REVIEWABLE = /\.(png|jpe?g|webp)$/i

/** Default pet name: the file name without its extension. */
export function nameOf(file: File): string {
  return file.name.replace(/\.[^.]+$/, '').slice(0, 32)
}

/** Localized text for a host error code (the code itself when unknown). */
export function errorText(code: string): string {
  const key = ('error.' + code) as I18nKey
  const text = t(key)
  return text === key ? code : text
}

/** The "what the import did" list. */
export function reportSteps(report: ImportReport): string[] {
  const steps = [t('import.step.format', { format: report.format.toUpperCase() })]
  if (report.kind === '3d') {
    if (report.originalTriangles !== undefined && report.finalTriangles !== undefined) {
      steps.push(t('import.step.mesh', { from: formatCount(report.originalTriangles), to: formatCount(report.finalTriangles) }))
    }
    if (report.textureSize !== undefined) steps.push(t('import.step.texture', { size: report.textureSize }))
  } else if (report.format === 'gif') {
    steps.push(t('import.step.gif'))
  } else {
    if (report.background === 'removed') steps.push(t('import.step.bgRemoved', { color: report.backgroundColor ?? '' }))
    else if (report.background === 'transparent') steps.push(t('import.step.bgTransparent'))
    else if (report.background === 'not-uniform') steps.push(t('import.step.bgComplex'))
    else if (report.background === 'kept') steps.push(t('import.step.bgKept'))
    steps.push(t('import.step.trim'))
  }
  steps.push(t('import.step.bytes', { from: formatBytes(report.originalBytes), to: formatBytes(report.finalBytes) }))
  steps.push(t('import.step.ready'))
  return steps
}

/** Crop a transparent PNG data URL to its content and bound it for a thumbnail. */
export async function thumbnailFrom(dataUrl: string, maxEdge = 256): Promise<Blob | undefined> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const src = document.createElement('canvas')
  src.width = image.naturalWidth
  src.height = image.naturalHeight
  const g = src.getContext('2d')
  if (g === null) return undefined
  g.drawImage(image, 0, 0)
  const { data, width, height } = g.getImageData(0, 0, src.width, src.height)
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return undefined
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * scale))
  out.height = Math.max(1, Math.round(h * scale))
  out.getContext('2d')?.drawImage(src, minX, minY, w, h, 0, 0, out.width, out.height)
  return new Promise(resolve => out.toBlob(blob => resolve(blob ?? undefined), 'image/png'))
}
