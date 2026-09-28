import { describe, expect, it } from 'vitest'
import { bubbleLayout } from './bubble.ts'

describe('bubbleLayout', () => {
  it('sits a gap above the reported head, not above the box', () => {
    // A 2D picture filling the whole 180px box: head at the very top.
    expect(bubbleLayout(180, 0, 24, 900)).toMatchObject({ bottom: 180 + 9 })
    // A 3D model with headroom: head 40px below the box top.
    expect(bubbleLayout(180, 40, 24, 900)).toMatchObject({ bottom: 140 + 9 })
  })

  it('scales gap, text and width with the pet size', () => {
    const small = bubbleLayout(80, 0, 24, 900)
    const large = bubbleLayout(480, 0, 24, 900)
    expect(small).toMatchObject({ bottom: 80 + 8, fontSize: 11, maxWidth: 180 })
    expect(large).toMatchObject({ bottom: 480 + 20, fontSize: 14, maxWidth: 768 })
  })

  it('assumes typical headroom before the first layout', () => {
    expect(bubbleLayout(200, undefined, 24, 900)).toMatchObject({ bottom: 160 + 10 })
  })

  it('flips below the pet when the pet is dragged to the top edge', () => {
    expect(bubbleLayout(180, 0, 900 - 190, 900)).toEqual({ top: 180 + 9, fontSize: 13, maxWidth: 288 })
  })
})
