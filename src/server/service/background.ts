/**
 * Uniform-background removal for imported pictures.
 *
 * Mascot art and product shots usually sit on a plain white or colored
 * backdrop. The backdrop color is estimated from the image border; when the
 * border agrees on one color, a flood fill from the border clears every
 * connected pixel close to it. The fill only travels through near-exact
 * matches, so it cannot creep into the character, and enclosed light areas
 * (an eye highlight, a white belly) survive because they do not touch the
 * border. The one-pixel rim where the fill meets the character gets a soft
 * alpha, and its color is un-mixed from the backdrop so no light halo
 * remains.
 *
 * Pure: operates on a straight (non-premultiplied) RGBA buffer in place.
 * @module dsh-dpet/server/service/background
 */

/** What the remover decided. */
export type BackgroundVerdict =
  /** A uniform backdrop was found and cleared. */
  | 'removed'
  /** The picture already has a transparent backdrop; nothing to do. */
  | 'transparent'
  /** The border has no single dominant color (photo, gradient, scene). */
  | 'not-uniform'

export interface BackgroundResult {
  verdict: BackgroundVerdict
  /** The estimated backdrop color, as #rrggbb. */
  color?: string
  /** Share of all pixels that became (partly) transparent. */
  clearedRatio?: number
}

export interface BackgroundOptions {
  /** Color distance the fill travels through (fully cleared). */
  fill?: number
  /** Extra distance over which rim pixels fade from clear to opaque. */
  feather?: number
  /** Share of border pixels that must match the backdrop color. */
  agreement?: number
}

const ALPHA_SOLID = 16

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

function hex(rgb: readonly number[]): string {
  return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/**
 * Clear a uniform backdrop connected to the image border.
 * @param rgba - straight RGBA pixels, modified in place.
 * @param width - image width in px.
 * @param height - image height in px.
 */
export function removeUniformBackground(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: BackgroundOptions = {},
): BackgroundResult {
  const fill = options.fill ?? 32
  const feather = options.feather ?? 40
  const agreement = options.agreement ?? 0.6
  const total = width * height
  if (width < 3 || height < 3) return { verdict: 'not-uniform' }

  // Border pixel indices (each once).
  const border: number[] = []
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x)
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1)

  const solid = border.filter(i => rgba[i * 4 + 3]! >= ALPHA_SOLID)
  if (solid.length < border.length * 0.8) return { verdict: 'transparent' }

  const bg = [0, 1, 2].map(c => median(solid.map(i => rgba[i * 4 + c]!)))
  const distance = (i: number): number => {
    const o = i * 4
    const dr = rgba[o]! - bg[0]!
    const dg = rgba[o + 1]! - bg[1]!
    const db = rgba[o + 2]! - bg[2]!
    return Math.sqrt(dr * dr + dg * dg + db * db)
  }
  const matching = solid.filter(i => distance(i) <= fill).length
  if (matching < border.length * agreement) return { verdict: 'not-uniform', color: hex(bg) }

  // Flood fill through near-exact backdrop pixels (4-neighborhood).
  const state = new Uint8Array(total) // 0 unvisited, 1 cleared, 2 rim
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  for (const i of border) {
    if (state[i] === 0 && distance(i) <= fill) {
      state[i] = 1
      queue[tail++] = i
    }
  }
  const rim: number[] = []
  const visit = (n: number): void => {
    if (state[n] !== 0) return
    if (distance(n) <= fill) {
      state[n] = 1
      queue[tail++] = n
    } else {
      state[n] = 2
      rim.push(n)
    }
  }
  while (head < tail) {
    const i = queue[head++]!
    const x = i % width
    if (x > 0) visit(i - 1)
    if (x < width - 1) visit(i + 1)
    if (i >= width) visit(i - width)
    if (i < total - width) visit(i + width)
  }

  for (let k = 0; k < tail; k++) rgba[queue[k]! * 4 + 3] = 0
  // Soft rim: fade by distance, and un-mix the backdrop from the color.
  for (const i of rim) {
    const a = Math.min(1, (distance(i) - fill) / feather)
    if (a >= 1) continue
    const o = i * 4
    for (let c = 0; c < 3; c++) {
      const value = (rgba[o + c]! - bg[c]! * (1 - a)) / Math.max(a, 0.05)
      rgba[o + c] = Math.min(255, Math.max(0, Math.round(value)))
    }
    rgba[o + 3] = Math.round(rgba[o + 3]! * a)
  }
  return { verdict: 'removed', color: hex(bg), clearedRatio: (tail + rim.length) / total }
}
