import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { fitEdges, prepareGenerateImage } from './image.ts'

describe('fitEdges', () => {
  it('bounds the long side and keeps small pictures', () => {
    expect(fitEdges(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitEdges(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })

  it('enlarges a picture whose short side is under 128 px', () => {
    expect(fitEdges(100, 100, 2048)).toEqual({ width: 128, height: 128 })
  })

  it('refuses shapes the API cannot take', () => {
    expect(() => fitEdges(6000, 100, 2048)).toThrow('image-bad-shape')
  })
})

describe('prepareGenerateImage', () => {
  it('keeps transparency as PNG and makes a thumbnail', async () => {
    const input = await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const out = await prepareGenerateImage(input)
    expect(out.format).toBe('png')
    expect([out.width, out.height]).toEqual([600, 400])
    expect(Buffer.from(out.base64, 'base64').equals(Buffer.from(out.data))).toBe(true)
    const thumb = await sharp(out.thumbnail).metadata()
    expect(thumb.format).toBe('png')
    expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBe(192)
  })

  it('re-encodes an opaque picture as JPEG and enlarges tiny ones', async () => {
    const input = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3366ff' } }).webp().toBuffer()
    const out = await prepareGenerateImage(input)
    expect(out.format).toBe('jpg')
    expect([out.width, out.height]).toEqual([128, 128])
  })

  it('rejects models and unknown data', async () => {
    await expect(prepareGenerateImage(new TextEncoder().encode('glTF....'))).rejects.toThrow('unsupported-format')
    await expect(prepareGenerateImage(new Uint8Array([1, 2, 3]))).rejects.toThrow('unsupported-format')
  })
})
