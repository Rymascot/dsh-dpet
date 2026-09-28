import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TARGET_TRIANGLES, processUpload, simplifyRatio, sniffFormat } from './importer.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dongdongGlb = readFileSync(join(root, 'assets', 'pets', 'dongdong', 'dongdong.glb'))
const dongdongPng = readFileSync(join(root, 'assets', 'pets', 'dongdong-flat', 'dongdong.png'))

describe('sniffFormat', () => {
  it('identifies uploads by magic bytes', () => {
    expect(sniffFormat(dongdongGlb)).toBe('glb')
    expect(sniffFormat(dongdongPng)).toBe('png')
    expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffFormat(new TextEncoder().encode('GIF89a'))).toBe('gif')
    expect(sniffFormat(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('webp')
    expect(sniffFormat(new TextEncoder().encode('<html>'))).toBeUndefined()
  })
})

describe('simplifyRatio', () => {
  it('keeps small meshes and scales large ones to the budget', () => {
    expect(simplifyRatio(40_000)).toBe(1)
    expect(simplifyRatio(1_500_000)).toBeCloseTo(TARGET_TRIANGLES / 1_500_000)
  })
})

describe('processUpload', () => {
  it('rejects unknown formats', async () => {
    await expect(processUpload(new TextEncoder().encode('not a model'))).rejects.toThrow('unsupported-format')
  })

  it('optimizes a glb and reports what changed', async () => {
    const asset = await processUpload(dongdongGlb)
    expect(asset.file).toBe('model.glb')
    expect(sniffFormat(asset.data)).toBe('glb')
    expect(asset.report.kind).toBe('3d')
    expect(asset.report.originalTriangles).toBeGreaterThan(0)
    expect(asset.report.finalTriangles).toBeLessThanOrEqual(asset.report.originalTriangles!)
  }, 60_000)

  it('trims and bounds a flat image that is already transparent', async () => {
    const asset = await processUpload(dongdongPng)
    expect(asset.file).toBe('image.png')
    expect(sniffFormat(asset.data)).toBe('png')
    expect(asset.report).toMatchObject({ kind: '2d', background: 'transparent' })
  })

  it('removes a white backdrop from a JPEG and keeps the character opaque', async () => {
    const sharp = (await import('sharp')).default
    const jpeg = await sharp(dongdongPng).flatten({ background: '#ffffff' }).extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()
    const asset = await processUpload(jpeg)
    expect(asset.report).toMatchObject({ kind: '2d', format: 'jpg', background: 'removed' })
    expect(asset.report.backgroundColor).toMatch(/^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/)
    const { data, info } = await sharp(asset.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alpha = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3]!
    // The white margin is gone (trimmed away or transparent) and the body stays solid.
    expect(alpha(0, 0)).toBe(0)
    expect(alpha(Math.floor(info.width / 2), Math.floor(info.height * 0.6))).toBe(255)
  })

  it('keeps the backdrop when asked to', async () => {
    const sharp = (await import('sharp')).default
    const jpeg = await sharp(dongdongPng).flatten({ background: '#ffffff' }).jpeg().toBuffer()
    const asset = await processUpload(jpeg, 'keep')
    expect(asset.report.background).toBe('kept')
  })
})
