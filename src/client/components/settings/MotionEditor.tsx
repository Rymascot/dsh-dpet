/**
 * Settings: choose which motion each AI state plays.
 * @module dsh-dpet/client/components/settings/MotionEditor
 */

import type { ReactElement } from 'react'
import { ACTIVITY_PHASES, PET_MOTIONS, type ActivityPhase, type PetMotion } from '../../../shared/types.ts'
import { motionForPhase } from '../../engine/motion.ts'
import { t, type I18nKey } from '../../i18n/index.ts'
import css from '../../styles/dpet.module.css'

export function MotionEditor(props: {
  motions: Partial<Record<ActivityPhase, PetMotion>>
  /** The state currently previewed on the stage (highlighted). */
  livePhase: ActivityPhase
  onPick: (phase: ActivityPhase, motion: PetMotion) => void
  onReset: () => void
}): ReactElement {
  return (
    <section className={css.section}>
      <div className={css.head}>
        <div className={css.grow}>
          <h3>{t('mapping.title')}</h3>
        </div>
        <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={props.onReset}>{t('mapping.reset')}</button>
      </div>
      <div className={css.mapping}>
        {ACTIVITY_PHASES.map((phase) => {
          const current = motionForPhase(phase, props.motions)
          return (
            <div key={phase} className={css.mapRow} data-live={phase === props.livePhase}>
              <div className={css.mapState}>{t(('phase.' + phase) as I18nKey)}</div>
              <div className={css.mapMotions}>
                {PET_MOTIONS.map(motion => (
                  <button
                    key={motion}
                    type="button"
                    className={css.chip}
                    aria-pressed={motion === current}
                    onClick={() => props.onPick(phase, motion)}
                  >
                    {t(('motion.' + motion) as I18nKey)}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
