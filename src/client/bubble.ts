/**
 * Status bubble placement: just above the pet's head, scaled with the pet,
 * flipping below the pet when the viewport leaves no room above.
 * @module dsh-dpet/client/bubble
 */

/** Space a bubble needs above the pet before it flips below instead. */
const BUBBLE_ROOM = 48

/** Where the bubble goes, relative to the pet box, and how large its text is. */
export interface BubbleLayout {
  /** Distance from the box bottom to the bubble bottom (bubble above the pet). */
  bottom?: number
  /** Distance from the box top to the bubble top (bubble below the pet). */
  top?: number
  fontSize: number
  maxWidth: number
}

/**
 * Place the bubble just above the pet's head.
 * @param boxHeight - pet box height (the size setting), px.
 * @param headTop - distance from the box top to the head, px; undefined before the first layout.
 * @param bottomInset - box distance from the viewport bottom, px.
 * @param viewportHeight - window height, px.
 */
export function bubbleLayout(boxHeight: number, headTop: number | undefined, bottomInset: number, viewportHeight: number): BubbleLayout {
  const gap = Math.round(Math.min(20, Math.max(8, boxHeight * 0.05)))
  const fontSize = Math.round(Math.min(14, Math.max(11, boxHeight * 0.07)))
  const maxWidth = Math.max(180, Math.round(boxHeight * 1.6))
  const head = Math.min(boxHeight, Math.max(0, headTop ?? boxHeight * 0.2))
  const above = boxHeight - head + gap
  const roomAbove = viewportHeight - bottomInset - above
  return roomAbove < BUBBLE_ROOM
    ? { top: boxHeight + gap, fontSize, maxWidth }
    : { bottom: above, fontSize, maxWidth }
}
