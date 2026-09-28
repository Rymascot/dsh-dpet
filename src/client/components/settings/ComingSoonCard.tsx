/**
 * Settings: the "image to 3D" preview card (coming soon).
 * @module dsh-dpet/client/components/settings/ComingSoonCard
 */

import type { ReactElement } from 'react'
import { t, type I18nKey } from '../../i18n/index.ts'
import css from '../../styles/dpet.module.css'

const STEPS = ['1', '2', '3', '4'] as const

export function ComingSoonCard(): ReactElement {
  return (
    <section className={css.road}>
      <div className={css.roadHead}>{t('roadmap.title')}<span className={css.tag}>{t('roadmap.tag')}</span></div>
      <p className={css.hint} style={{ margin: '6px 0 0' }}>{t('roadmap.hint')}</p>
      <div className={css.flow}>
        {STEPS.map((n, i) => (
          <span key={n} style={{ display: 'contents' }}>
            {i > 0 && <span className={css.muted}>→</span>}
            <div className={css.step}>
              {t(('roadmap.step' + n) as I18nKey)}
              <small>{t(('roadmap.step' + n + 'Hint') as I18nKey)}</small>
            </div>
          </span>
        ))}
      </div>
    </section>
  )
}
