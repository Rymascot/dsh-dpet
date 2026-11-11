/**
 * Bubble copy for an activity snapshot and for taps.
 * @module dsh-dpet/client/utils/lines
 */

import type { ActivityPhase, ActivitySnapshot, GenerationBrief } from '../../shared/types.ts'
import { t, toolLabel, type I18nKey } from '../i18n/index.ts'

/** The status line for an activity, or undefined when there is nothing to say. */
export function activityLine(activity: Pick<ActivitySnapshot, 'line' | 'tool'>, petName: string): string | undefined {
  if (activity.line === undefined) return undefined
  return t(('line.' + activity.line) as I18nKey, { name: petName, tool: toolLabel(activity.tool) })
}

/** The pet's phase while an image-to-3D job runs or has just ended (only used when the agent is idle). */
export function generationPhase(brief: GenerationBrief | undefined): ActivityPhase | undefined {
  if (brief === undefined) return undefined
  if (brief.status === 'done') return 'done'
  if (brief.status === 'failed') return 'failed'
  return 'thinking'
}

/** Bubble copy for an image-to-3D job. */
export function generationLine(brief: GenerationBrief | undefined): string | undefined {
  if (brief === undefined) return undefined
  const key: I18nKey = brief.status === 'done' ? 'gen.line.done' : brief.status === 'failed' ? 'gen.line.failed' : 'gen.line.working'
  return t(key, { job: brief.name })
}

const TAP_KEYS: readonly I18nKey[] = ['tap.1', 'tap.2', 'tap.3', 'tap.4']

/** A tap reaction, rotating through the pool. */
export function tapLine(petName: string, index: number): string {
  return t(TAP_KEYS[index % TAP_KEYS.length]!, { name: petName })
}
