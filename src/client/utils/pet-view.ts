/**
 * Small display helpers for a pet.
 * @module dsh-dpet/client/utils/pet-view
 */

import type { PetView } from '../../shared/types.ts'

export function isGif(pet: PetView): boolean {
  return pet.kind === '2d' && /\.gif(\?|$)/i.test(pet.fileUrl)
}

/** The gallery badge: 3D, 2D or GIF. */
export function kindBadge(pet: PetView): string {
  return pet.kind === '3d' ? '3D' : isGif(pet) ? 'GIF' : '2D'
}

/** The thumbnail URL: the captured preview, or the picture itself for 2D pets. */
export function thumbOf(pet: PetView): string | undefined {
  return pet.previewUrl ?? (pet.kind === '2d' ? pet.fileUrl : undefined)
}
