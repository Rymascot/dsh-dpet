/**
 * Bubble copy for an activity snapshot and for taps.
 * @module dsh-dpet/client/lines
 */

import type { ActivitySnapshot } from '../types.ts'
import { t, toolLabel, type I18nKey } from './i18n.ts'

/** The status line for an activity, or undefined when there is nothing to say. */
export function activityLine(activity: Pick<ActivitySnapshot, 'line' | 'tool'>, petName: string): string | undefined {
  if (activity.line === undefined) return undefined
  return t(('line.' + activity.line) as I18nKey, { name: petName, tool: toolLabel(activity.tool) })
}

const TAP_KEYS: readonly I18nKey[] = ['tap.1', 'tap.2', 'tap.3', 'tap.4']

/** A tap reaction, rotating through the pool. */
export function tapLine(petName: string, index: number): string {
  return t(TAP_KEYS[index % TAP_KEYS.length]!, { name: petName })
}
