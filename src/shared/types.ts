/**
 * Types shared by the host half and the browser half. Pure declarations and
 * constants only, so both bundles can import this module.
 * @module dsh-dpet/shared/types
 */

/** What the agent is doing, as the pet understands it. */
export type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'

/** Every activity phase, in display order. */
export const ACTIVITY_PHASES: readonly ActivityPhase[] = ['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed']

/** Whole-body motions shared by 2D and 3D pets (applied to the pet root). */
export type PetMotion = 'bob' | 'sway' | 'spin' | 'hop' | 'nod' | 'cheer' | 'droop' | 'still'

/** Every motion, in display order. */
export const PET_MOTIONS: readonly PetMotion[] = ['bob', 'sway', 'spin', 'hop', 'nod', 'cheer', 'droop', 'still']

/** How a pet is drawn: a binary glTF model or a flat image (PNG/JPG/WebP/GIF). */
export type PetKind = '3d' | '2d'

/** A pet as the browser sees it. */
export interface PetView {
  id: string
  name: string
  kind: PetKind
  /** Browser URL of the model or image. */
  fileUrl: string
  /** Browser URL of the gallery thumbnail, when one exists. */
  previewUrl?: string
  /** Shipped with the plugin (cannot be renamed or deleted). */
  builtin: boolean
  description?: string
  author?: string
  /** Where the asset came from, e.g. "腾讯混元 3D". */
  source?: string
  /** Final file size in bytes. */
  bytes?: number
  /** Triangle count of a 3D model. */
  triangles?: number
  /** Creation time (ms since epoch) of an imported pet. */
  createdAt?: number
}

/** User settings, persisted on the host. */
export interface DpetSettings {
  /** Show the floating pet. */
  enabled: boolean
  /** Selected pet id. */
  petId: string
  /** Pet height in px. */
  size: number
  /** Distance from the viewport's right edge, px. */
  right: number
  /** Distance from the viewport's bottom edge, px. */
  bottom: number
  /** Opacity, 0.3..1. */
  opacity: number
  /** Turn slightly toward the pointer. */
  lookAtCursor: boolean
  /** Show the status bubble. */
  bubbles: boolean
  /** Per-phase motion overrides; unmapped phases use the defaults. */
  motions: Partial<Record<ActivityPhase, PetMotion>>
}

/** Bounds for numeric settings. */
export const SETTINGS_LIMITS = {
  size: { min: 80, max: 480 },
  inset: { min: 0, max: 4000 },
  opacity: { min: 0.3, max: 1 },
} as const

/** Status copy keys the browser localizes (the host stays language-neutral). */
export type ActivityLine =
  | 'prepare'
  | 'waiting'
  | 'blocked'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'toolRetry'
  | 'done'
  | 'failed'
  | 'interrupted'

/** The agent activity snapshot. */
export interface ActivitySnapshot {
  phase: ActivityPhase
  line?: ActivityLine
  /** Tool name, for line 'tool'. */
  tool?: string
  /** When this phase started (ms since epoch). */
  since: number
}

/** GET /api/dpet/state. */
export interface StateResponse {
  activity: ActivitySnapshot
  settings: DpetSettings
  pet: PetView
}

/** What an import did, for the progress list. */
export interface ImportReport {
  kind: PetKind
  format: 'glb' | 'png' | 'jpg' | 'webp' | 'gif'
  originalBytes: number
  finalBytes: number
  originalTriangles?: number
  finalTriangles?: number
  /** Texture edge length after resizing, for 3D. */
  textureSize?: number
  /** What happened to a picture's backdrop, for 2D. */
  background?: 'removed' | 'transparent' | 'not-uniform' | 'kept'
  /** The backdrop color that was cleared, as #rrggbb. */
  backgroundColor?: string
}

/** How an imported picture's backdrop is handled. */
export type BackgroundMode = 'remove' | 'keep'

/** POST /api/dpet/import. */
export type ImportResponse =
  | { ok: true; pet: PetView; report: ImportReport }
  | { ok: false; error: string }
