import { describe, expect, it } from 'vitest'
import { removeUniformBackground } from './background.ts'

/** Build an RGBA image from a per-pixel color function. */
function image(w: number, h: number, color: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(color(x, y), (y * w + x) * 4)
  }
  return data
}
const alphaAt = (d: Uint8Array, w: number, x: number, y: number): number => d[(y * w + x) * 4 + 3]!

describe('removeUniformBackground', () => {
  it('clears a white backdrop and keeps the character', () => {
    // 20x20 white with a red 8x8 square in the middle.
    const d = image(20, 20, (x, y) => (x >= 6 && x < 14 && y >= 6 && y < 14 ? [220, 30, 30, 255] : [255, 255, 255, 255]))
    const result = removeUniformBackground(d, 20, 20)
    expect(result.verdict).toBe('removed')
    expect(result.color).toBe('#ffffff')
    expect(alphaAt(d, 20, 0, 0)).toBe(0)
    expect(alphaAt(d, 20, 5, 10)).toBe(0)
    expect(alphaAt(d, 20, 10, 10)).toBe(255)
  })

  it('tolerates JPEG-like noise in the backdrop', () => {
    let seed = 7
    const noise = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (seed % 13) - 6 }
    const d = image(24, 24, (x, y) => (x >= 8 && x < 16 && y >= 8 ? [20, 60, 200, 255] : [245 + noise(), 245 + noise(), 245 + noise(), 255]))
    expect(removeUniformBackground(d, 24, 24).verdict).toBe('removed')
    expect(alphaAt(d, 24, 2, 2)).toBe(0)
    // The character touches the bottom edge and stays.
    expect(alphaAt(d, 24, 12, 23)).toBe(255)
  })

  it('keeps a light area enclosed by the character', () => {
    // A blue ring with a white hole in the middle: the hole does not touch the border.
    const d = image(20, 20, (x, y) => {
      const inRing = x >= 4 && x < 16 && y >= 4 && y < 16
      const inHole = x >= 8 && x < 12 && y >= 8 && y < 12
      return inRing && !inHole ? [30, 60, 220, 255] : [255, 255, 255, 255]
    })
    removeUniformBackground(d, 20, 20)
    expect(alphaAt(d, 20, 0, 0)).toBe(0)
    expect(alphaAt(d, 20, 10, 10)).toBe(255)
  })

  it('feathers the rim and un-mixes the backdrop color', () => {
    // White backdrop, a light pink anti-aliased rim pixel next to a red body.
    const d = image(9, 9, (x, y) => {
      if (x >= 4 && y >= 3 && y < 6) return [200, 0, 0, 255]
      if (x === 3 && y === 4) return [245, 215, 215, 255]
      return [255, 255, 255, 255]
    })
    removeUniformBackground(d, 9, 9)
    const o = (4 * 9 + 3) * 4
    expect(d[o + 3]).toBeGreaterThan(0)
    expect(d[o + 3]).toBeLessThan(255)
    // Un-mixed toward the body color: the white share is taken out of green.
    expect(d[o + 1]).toBeLessThan(215)
  })

  it('leaves already transparent pictures alone', () => {
    const d = image(10, 10, (x, y) => (x > 2 && x < 7 && y > 2 && y < 7 ? [0, 0, 255, 255] : [0, 0, 0, 0]))
    const before = d.slice()
    expect(removeUniformBackground(d, 10, 10).verdict).toBe('transparent')
    expect(d).toEqual(before)
  })

  it('refuses busy backgrounds', () => {
    const d = image(16, 16, (x, y) => [(x * 37) % 256, (y * 53) % 256, ((x + y) * 29) % 256, 255])
    const before = d.slice()
    expect(removeUniformBackground(d, 16, 16).verdict).toBe('not-uniform')
    expect(d).toEqual(before)
  })
})
