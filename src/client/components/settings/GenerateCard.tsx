/**
 * Settings, "桌宠" tab: "AI 生成 3D 形象" — pick a picture, generate with
 * Tencent Hunyuan, and follow the jobs until the new pet lands in the
 * gallery. The key itself is managed on the "Key 密钥" tab (./KeyPanel.tsx);
 * without one, this card only points there.
 * @module dsh-dpet/client/components/settings/GenerateCard
 */

import { useEffect, useState, type DragEvent, type ReactElement, type Ref } from 'react'
import { GENERATE_MODELS, type GenerateJobView, type PetView } from '../../../shared/types.ts'
import { GENERATE_ACCEPT, isActive, type GenerateError, type GenerateFlow } from '../../hooks/useGenerate.ts'
import { formatBytes, formatCount, t, type I18nKey } from '../../i18n/index.ts'
import { errorText } from '../../utils/import-report.ts'
import css from '../../styles/dpet.module.css'

/** Localized text for an error code (generation codes first, then import codes). */
export function generateErrorText(code: string): string {
  const key = ('gen.error.' + code) as I18nKey
  const text = t(key)
  return text === key ? errorText(code) : text
}

export function ErrorLine(props: { error: GenerateError }): ReactElement {
  return (
    <div className={`${css.small} ${css.importError}`}>
      {generateErrorText(props.error.code)}
      {props.error.detail !== undefined && <span className={css.genDetail}>{props.error.detail}</span>}
    </div>
  )
}

/** mm:ss since a moment. */
function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

function GenerateForm(props: { flow: GenerateFlow }): ReactElement {
  const { flow } = props
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent<HTMLElement>): void => {
    // Keep the page-level drop (plain import) out of this zone.
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file !== undefined) flow.pick(file)
  }
  return (
    <div className={css.genForm}>
      <label
        className={css.pick}
        data-active={over}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept={GENERATE_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file !== undefined) flow.pick(file)
            e.target.value = ''
          }}
        />
        {flow.picked === undefined
          ? <span><span className={css.plus}>+</span><b>{t('gen.pick')}</b><small>{t('gen.pickHint')}</small></span>
          : <img src={flow.picked.url} alt="" draggable={false} />}
      </label>
      <div className={css.genFields}>
        <p className={`${css.small} ${css.muted}`} style={{ margin: 0 }}>{t('gen.pickTips')}</p>
        <label className={css.field}>
          <span>{t('gen.name')}</span>
          <input className={css.input} value={flow.name} maxLength={32} aria-label={t('gen.name')} onChange={e => flow.setName(e.target.value)} />
        </label>
        <div className={css.methods} role="radiogroup">
          {GENERATE_MODELS.map(m => (
            <button key={m} type="button" role="radio" aria-checked={flow.model === m} aria-pressed={flow.model === m} className={css.option} onClick={() => flow.setModel(m)}>
              <b>{t(('gen.model.' + m) as I18nKey)}</b>
              <small>{t(('gen.model.' + m + 'Hint') as I18nKey)}</small>
            </button>
          ))}
        </div>
        {flow.error !== undefined && <ErrorLine error={flow.error} />}
        {flow.busy && <div className={`${css.small} ${css.muted}`}>{t('gen.busy')}</div>}
        <div className={css.btns}>
          <button
            type="button"
            className={css.btn}
            disabled={flow.picked === undefined || flow.submitting || flow.busy || flow.name.trim() === ''}
            onClick={() => { void flow.submit() }}
          >
            {t(flow.submitting ? 'gen.starting' : 'gen.start')}
          </button>
          {flow.picked !== undefined && !flow.submitting && (
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => flow.unpick()}>{t('gen.repick')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

function JobRow(props: {
  job: GenerateJobView
  now: number
  pet: PetView | undefined
  inUse: boolean
  onView: (petId: string) => void
  onUse: (petId: string) => void
  onDismiss: (id: string) => void
}): ReactElement {
  const { job, pet } = props
  const active = isActive(job)
  const report = job.report
  return (
    <div className={css.job}>
      {job.inputUrl === undefined ? <div className={css.jobThumb} /> : <img className={css.jobThumb} src={job.inputUrl} alt="" draggable={false} />}
      <div className={css.grow}>
        <div className={css.jobName}>
          <span>{job.name}</span>
          <span className={css.badge}>{t(('gen.model.' + job.model) as I18nKey)}</span>
        </div>
        <div className={`${css.jobMeta} ${job.status === 'failed' ? css.importError : ''}`}>
          {t(('gen.status.' + job.status) as I18nKey)}
          {active && ' · ' + elapsed(job.createdAt, props.now)}
          {job.status === 'failed' && job.error !== undefined && ' · ' + generateErrorText(job.error)}
          {job.status === 'done' && pet === undefined && ' · ' + t('gen.petGone')}
          {job.status === 'done' && pet !== undefined && report?.finalTriangles !== undefined && ' · ' + (
            report.originalTriangles !== undefined && report.originalTriangles > report.finalTriangles
              ? t('gen.reduced', { from: formatCount(report.originalTriangles), to: formatCount(report.finalTriangles), size: formatBytes(report.finalBytes) })
              : t('info.triangles', { n: formatCount(report.finalTriangles) }) + ' · ' + formatBytes(report.finalBytes)
          )}
        </div>
        {job.status === 'failed' && job.detail !== undefined && <div className={css.genDetail}>{job.detail}</div>}
        {active && <div className={`${css.progress} ${css.indeterminate}`}><div /></div>}
      </div>
      <div className={css.btns}>
        {job.status === 'done' && pet !== undefined && (
          <>
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => props.onView(pet.id)}>{t('gen.view')}</button>
            <button type="button" className={css.btn} disabled={props.inUse} onClick={() => props.onUse(pet.id)}>
              {t(props.inUse ? 'gen.inUse' : 'gen.use')}
            </button>
          </>
        )}
        {!active && (
          <button type="button" className={`${css.btn} ${css.btnGhost}`} aria-label={t('gen.dismiss')} title={t('gen.dismiss')} onClick={() => props.onDismiss(job.id)}>×</button>
        )}
      </div>
    </div>
  )
}

export function GenerateCard(props: {
  flow: GenerateFlow
  pets: PetView[]
  currentId: string
  sectionRef?: Ref<HTMLElement>
  onView: (petId: string) => void
  onUse: (petId: string) => void
  /** Switch to the "Key 密钥" tab. */
  onOpenKeys: () => void
}): ReactElement {
  const { flow } = props
  const [now, setNow] = useState(() => Date.now())
  const status = flow.state?.hunyuan
  const jobs = flow.state?.jobs ?? []

  // Tick the elapsed time while a job runs.
  useEffect(() => {
    if (!flow.busy) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [flow.busy])

  const method = status?.method === 'tencentcloud' ? 'tencentcloud' : 'tokenhub'
  return (
    <section className={css.section} ref={props.sectionRef}>
      <h3 className={css.genTitle}>{t('gen.title')}<span className={css.pill}>{t('gen.tag')}</span></h3>
      <p className={css.hint}>{t('gen.hint')}</p>
      {status === undefined
        ? <p className={css.muted}>…</p>
        : <div className={css.genStack}>
            {!status.configured
              ? <div className={css.needKey}>
                  <span className={css.grow}>{t('gen.needKey')}</span>
                  <button type="button" className={css.btn} onClick={props.onOpenKeys}>{t('gen.goKey')}</button>
                </div>
              : <>
                  <div className={`${css.small} ${css.muted}`}>
                    <span className={css.dot} />
                    {status.method === 'mock'
                      ? t('gen.connected.mock')
                      : t('gen.connected', { method: t(('gen.method.' + method) as I18nKey), hint: status.hint ?? '' })}
                    {' · '}
                    <button type="button" className={css.linkBtn} onClick={props.onOpenKeys}>{t('gen.manageKey')}</button>
                  </div>
                  <GenerateForm flow={flow} />
                </>}
            {jobs.length > 0 && (
              <div>
                <div className={`${css.small} ${css.muted}`} style={{ margin: '0 0 6px' }}>{t('gen.jobs')}</div>
                <div className={css.jobs}>
                  {jobs.map(job => (
                    <JobRow
                      key={job.id}
                      job={job}
                      now={now}
                      pet={job.petId === undefined ? undefined : props.pets.find(p => p.id === job.petId)}
                      inUse={job.petId === props.currentId}
                      onView={props.onView}
                      onUse={props.onUse}
                      onDismiss={(id) => { void flow.dismiss(id) }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>}
    </section>
  )
}
