/**
 * Settings: the live preview stage and the AI-state buttons under it.
 * @module dsh-dpet/client/components/settings/PreviewStage
 */

import { useRef, type ReactElement } from 'react'
import { ACTIVITY_PHASES, type ActivityLine, type ActivityPhase, type PetMotion, type PetView } from '../../../shared/types.ts'
import { PetStage } from '../PetStage.tsx'
import type { PetHandle } from '../../engine/flat.ts'
import { activityLine } from '../../utils/lines.ts'
import { t, type I18nKey } from '../../i18n/index.ts'
import css from '../../styles/dpet.module.css'

/** The bubble line each previewed state shows. */
const PREVIEW_LINES: Record<ActivityPhase, { line?: ActivityLine; tool?: string }> = {
  idle: {},
  waiting: { line: 'prepare' },
  thinking: { line: 'thinking' },
  tool: { line: 'tool', tool: 'bash' },
  review: { line: 'writing' },
  done: { line: 'done' },
  failed: { line: 'failed' },
}

export function PreviewStage(props: {
  pet: PetView
  phase: ActivityPhase
  onPhase: (phase: ActivityPhase) => void
  motions: Partial<Record<ActivityPhase, PetMotion>>
  lookAtCursor: boolean
  onReady: (handle: PetHandle) => void
}): ReactElement {
  const handle = useRef<PetHandle | undefined>(undefined)
  const line = activityLine(PREVIEW_LINES[props.phase], props.pet.name)
  return (
    <div>
      <div className={css.stageBox}>
        <PetStage
          className={css.stage}
          pet={props.pet}
          phase={props.phase}
          motions={props.motions}
          lookAtCursor={props.lookAtCursor}
          onHandle={(h) => { handle.current = h }}
          onReady={props.onReady}
        />
        {line !== undefined && <div key={props.phase} className={css.stageBubble}>{line}</div>}
        <div className={css.stageTip}>{t('stage.tip')}</div>
        <button
          type="button"
          aria-label={t('stage.tip')}
          style={{ position: 'absolute', inset: '36px 0 0', background: 'none', border: 0, cursor: 'pointer' }}
          onClick={() => handle.current?.tap()}
        />
      </div>
      <div className={css.chips}>
        <span className={`${css.muted} ${css.small}`}>{t('stage.previewState')}</span>
        {ACTIVITY_PHASES.map(phase => (
          <button key={phase} type="button" className={css.chip} aria-pressed={phase === props.phase} onClick={() => props.onPhase(phase)}>
            {t(('phase.' + phase) as I18nKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
