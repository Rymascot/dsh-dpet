/**
 * Settings, "Key 密钥" tab: connect Tencent Hunyuan with the user's own key
 * (saved on this computer only), check it, change or remove it, plus how to
 * get one. Generating lives on the "桌宠" tab (./GenerateCard.tsx).
 * @module dsh-dpet/client/components/settings/KeyPanel
 */

import { useState, type ReactElement } from 'react'
import type { HunyuanMethod, HunyuanStatus } from '../../../shared/types.ts'
import type { GenerateError, GenerateFlow } from '../../hooks/useGenerate.ts'
import { t, type I18nKey } from '../../i18n/index.ts'
import { ErrorLine } from './GenerateCard.tsx'
import css from '../../styles/dpet.module.css'

/** Where users get keys (official Tencent Cloud pages). */
const LINKS: Readonly<Record<HunyuanMethod, string>> = {
  tokenhub: 'https://console.cloud.tencent.com/tokenhub/apikey',
  tencentcloud: 'https://console.cloud.tencent.com/cam/capi',
}

function ConnectForm(props: { flow: GenerateFlow; canCancel: boolean; onClose: () => void }): ReactElement {
  const [method, setMethod] = useState<HunyuanMethod>('tokenhub')
  const [apiKey, setApiKey] = useState('')
  const [secretId, setSecretId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const ready = method === 'tokenhub' ? apiKey.trim() !== '' : secretId.trim() !== '' && secretKey.trim() !== ''

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    const failed = await props.flow.saveCredentials(method === 'tokenhub'
      ? { method, apiKey: apiKey.trim() }
      : { method, secretId: secretId.trim(), secretKey: secretKey.trim() })
    setSaving(false)
    if (failed !== undefined) {
      setError(failed)
      return
    }
    setApiKey('')
    setSecretId('')
    setSecretKey('')
    props.onClose()
  }

  const secretInput = (value: string, set: (v: string) => void, label: I18nKey): ReactElement => (
    <label className={css.field}>
      <span>{t(label)}</span>
      <input
        className={css.input}
        type="password"
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-label={t(label)}
        onChange={e => set(e.target.value)}
      />
    </label>
  )

  return (
    <div className={css.genBox}>
      <b>{t('gen.connect.title')}</b>
      <div className={css.methods} role="radiogroup">
        {(['tokenhub', 'tencentcloud'] as const).map(m => (
          <button key={m} type="button" role="radio" aria-checked={method === m} aria-pressed={method === m} className={css.option} onClick={() => setMethod(m)}>
            <b>{t(('gen.method.' + m) as I18nKey)}</b>
            <small>{t(('gen.method.' + m + 'Note') as I18nKey)}</small>
          </button>
        ))}
      </div>
      <div className={css.fields}>
        {method === 'tokenhub'
          ? secretInput(apiKey, setApiKey, 'gen.field.apiKey')
          : <>
              {secretInput(secretId, setSecretId, 'gen.field.secretId')}
              {secretInput(secretKey, setSecretKey, 'gen.field.secretKey')}
            </>}
      </div>
      <a className={css.small} href={LINKS[method]} target="_blank" rel="noreferrer">
        {t(method === 'tokenhub' ? 'gen.connect.howTokenhub' : 'gen.connect.howCloud')} ↗
      </a>
      {error !== undefined && <ErrorLine error={{ code: error }} />}
      <div className={css.btns}>
        <button type="button" className={css.btn} disabled={!ready || saving} onClick={() => { void save() }}>
          {t(saving ? 'gen.connect.saving' : 'gen.connect.save')}
        </button>
        {props.canCancel && <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={props.onClose}>{t('gen.connect.cancel')}</button>}
      </div>
    </div>
  )
}

function ConnectedBar(props: { flow: GenerateFlow; status: HunyuanStatus; onChange: () => void; onGoGenerate: () => void }): ReactElement {
  const { status, flow } = props
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<'ok' | GenerateError | undefined>(undefined)
  const goGenerate = (
    <button type="button" className={css.btn} onClick={props.onGoGenerate}>{t('key.goGenerate')}</button>
  )

  if (status.method === 'mock') {
    return (
      <div className={css.genBar}>
        <div className={`${css.grow} ${css.small}`}><span className={css.dot} />{t('gen.connected.mock')}</div>
        <div className={css.btns}>{goGenerate}</div>
      </div>
    )
  }
  const method = status.method === 'tencentcloud' ? 'tencentcloud' : 'tokenhub'
  const check = async (): Promise<void> => {
    setChecking(true)
    setResult(undefined)
    const error = await flow.check()
    setChecking(false)
    setResult(error ?? 'ok')
  }
  const remove = (): void => {
    if (window.confirm(t('gen.confirmRemove'))) void flow.clearCredentials()
  }
  return (
    <div className={css.genBar}>
      <div className={css.grow}>
        <div><span className={css.dot} />{t('gen.connected', { method: t(('gen.method.' + method) as I18nKey), hint: status.hint ?? '' })}</div>
        {status.source === 'env' && <div className={`${css.small} ${css.muted}`}>{t('gen.connected.env')}</div>}
        {result === 'ok' && <div className={`${css.small} ${css.okText}`}>{t('gen.checkOk')}</div>}
        {result !== undefined && result !== 'ok' && <ErrorLine error={result} />}
      </div>
      <div className={css.btns}>
        <button type="button" className={`${css.btn} ${css.btnGhost}`} disabled={checking} onClick={() => { void check() }}>
          {t(checking ? 'gen.checking' : 'gen.check')}
        </button>
        <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={props.onChange}>{t('gen.change')}</button>
        {status.source === 'local' && (
          <button type="button" className={`${css.btn} ${css.btnGhost} ${css.btnDanger}`} onClick={remove}>{t('gen.remove')}</button>
        )}
        {goGenerate}
      </div>
    </div>
  )
}

export function KeyPanel(props: { flow: GenerateFlow; onGoGenerate: () => void }): ReactElement {
  const { flow } = props
  const [editing, setEditing] = useState(false)
  const status = flow.state?.hunyuan

  return (
    <section className={css.section}>
      <h3 className={css.genTitle}>{t('key.hunyuan')}<span className={css.pill}>{t('key.usedFor')}</span></h3>
      <p className={css.hint}>{t('key.hint')}</p>
      {status === undefined
        ? <p className={css.muted}>…</p>
        : <div className={css.genStack}>
            {!status.configured || editing
              ? <ConnectForm flow={flow} canCancel={status.configured} onClose={() => setEditing(false)} />
              : <ConnectedBar flow={flow} status={status} onChange={() => setEditing(true)} onGoGenerate={props.onGoGenerate} />}
            <div className={css.genBox}>
              <b>{t('key.howTitle')}</b>
              <ol className={css.steps}>
                <li>{t('key.how1')}</li>
                <li>
                  {t('key.how2')}{' '}
                  <a href={LINKS.tokenhub} target="_blank" rel="noreferrer">{t('gen.connect.howTokenhub')} ↗</a>
                </li>
                <li>
                  {t('key.how3')}{' '}
                  <a href={LINKS.tencentcloud} target="_blank" rel="noreferrer">{t('gen.connect.howCloud')} ↗</a>
                </li>
                <li>{t('key.how4')}</li>
              </ol>
            </div>
            <p className={`${css.small} ${css.muted}`} style={{ margin: 0 }}>{t('key.privacy')}</p>
          </div>}
    </section>
  )
}
