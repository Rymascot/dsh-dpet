/**
 * Settings: the before / after review of a picture, and the upload progress.
 * @module dsh-dpet/client/components/settings/ImportPanel
 */

import type { ReactElement } from 'react'
import type { ImportFlow } from '../../hooks/useImportFlow.ts'
import { formatBytes, t } from '../../i18n/index.ts'
import { errorText } from '../../utils/import-report.ts'
import css from '../../styles/dpet.module.css'

export function ImportPanel(props: { flow: ImportFlow }): ReactElement | null {
  const { review, progress } = props.flow
  return (
    <>
      {review !== undefined && (
        <div className={css.import}>
          <div className={css.importHead}><b>{t('import.review', { file: review.file.name })}</b></div>
          <p className={css.hint} style={{ margin: '4px 0 10px' }}>{t('import.reviewHint')}</p>
          <div className={css.review}>
            <button type="button" className={css.tile} aria-pressed={review.choice === 'keep'} onClick={() => props.flow.choose('keep')}>
              <div className={css.checker}><img src={review.originalUrl} alt="" draggable={false} /></div>
              <span>{t('import.original')}</span>
            </button>
            {(review.report === undefined ? review.error === undefined : review.report.background === 'removed') && (
              <button
                type="button"
                className={css.tile}
                aria-pressed={review.choice === 'remove'}
                disabled={review.cleanedUrl === undefined}
                onClick={() => props.flow.choose('remove')}
              >
                <div className={css.checker}>
                  {review.cleanedUrl === undefined
                    ? <span className={css.muted}>{t('import.bg.working')}</span>
                    : <img src={review.cleanedUrl} alt="" draggable={false} />}
                </div>
                <span>{t('import.cleaned')}</span>
              </button>
            )}
          </div>
          <div className={`${css.small} ${review.error === undefined ? css.muted : css.importError}`} style={{ marginTop: 8 }}>
            {review.error !== undefined
              ? errorText(review.error)
              : review.report === undefined
                ? t('import.bg.working')
                : review.report.background === 'removed'
                  ? t('import.bg.removed', { color: review.report.backgroundColor ?? '' })
                  : review.report.background === 'transparent'
                    ? t('import.bg.transparent')
                    : t('import.bg.not-uniform')}
          </div>
          <div className={css.btns} style={{ marginTop: 12 }}>
            <input
              className={css.input}
              value={review.name}
              maxLength={32}
              aria-label={t('import.name')}
              placeholder={t('import.name')}
              onChange={e => props.flow.rename(e.target.value)}
            />
            <button
              type="button"
              className={css.btn}
              disabled={review.error !== undefined || review.report === undefined || review.name.trim() === ''}
              onClick={() => props.flow.confirm()}
            >
              {t('import.create')}
            </button>
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => props.flow.cancel()}>{t('import.cancel')}</button>
          </div>
        </div>
      )}
      {progress !== undefined && (
        <div className={css.import}>
          <div className={css.importHead}>
            <b className={progress.status === 'error' ? css.importError : undefined}>
              {progress.status === 'uploading' && t('import.uploading', { file: progress.file, size: formatBytes(progress.size) })}
              {progress.status === 'processing' && t('import.processing')}
              {progress.status === 'done' && t('import.done', { name: progress.name ?? progress.file })}
              {progress.status === 'error' && t('import.failed', { reason: progress.error ?? '' })}
            </b>
            {(progress.status === 'done' || progress.status === 'error') && (
              <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => props.flow.dismiss()}>{t('import.close')}</button>
            )}
          </div>
          {(progress.status === 'uploading' || progress.status === 'processing') && (
            <div className={css.progress}><div style={{ width: Math.round(progress.progress * 100) + '%' }} /></div>
          )}
          {progress.steps.length > 0 && (
            <ol className={css.importSteps}>{progress.steps.map(step => <li key={step}>{step}</li>)}</ol>
          )}
        </div>
      )}
    </>
  )
}
