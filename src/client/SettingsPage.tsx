/**
 * The "桌宠" settings page: live preview stage, pet gallery with drag-and-drop
 * import, per-state motion editor, and placement / appearance controls.
 * @module dsh-dpet/client/SettingsPage
 */

import { useEffect, useRef, useState, type DragEvent, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { ACTIVITY_PHASES, PET_MOTIONS, SETTINGS_LIMITS, type ActivityLine, type ActivityPhase, type BackgroundMode, type DpetSettings, type ImportReport, type PetMotion, type PetView } from '../types.ts'
import { api } from './api.ts'
import { useDpet, type DpetStore } from './store.ts'
import { PetStage } from './PetStage.tsx'
import type { PetHandle } from './renderers/flat.ts'
import { motionForPhase } from './renderers/motion.ts'
import { activityLine } from './lines.ts'
import { formatBytes, formatCount, t, type I18nKey } from './i18n.ts'
import { PET_ASPECT } from './FloatingPet.tsx'
import css from './dpet.module.css'

/** The line a previewed phase shows in the stage bubble. */
const PREVIEW_LINES: Record<ActivityPhase, { line?: ActivityLine; tool?: string }> = {
  idle: {},
  waiting: { line: 'prepare' },
  thinking: { line: 'thinking' },
  tool: { line: 'tool', tool: 'bash' },
  review: { line: 'writing' },
  done: { line: 'done' },
  failed: { line: 'failed' },
}

const ACCEPT = '.glb,.png,.jpg,.jpeg,.webp,.gif'

function isGif(pet: PetView): boolean {
  return pet.kind === '2d' && /\.gif(\?|$)/i.test(pet.fileUrl)
}

function kindBadge(pet: PetView): string {
  return pet.kind === '3d' ? '3D' : isGif(pet) ? 'GIF' : '2D'
}

function thumbOf(pet: PetView): string | undefined {
  return pet.previewUrl ?? (pet.kind === '2d' ? pet.fileUrl : undefined)
}

function errorText(code: string): string {
  const key = ('error.' + code) as I18nKey
  const text = t(key)
  return text === key ? code : text
}

/** Import progress shown under the gallery. */
interface ImportState {
  status: 'uploading' | 'processing' | 'done' | 'error'
  file: string
  size: number
  progress: number
  steps: string[]
  error?: string
  name?: string
}

/** A still picture waiting for the user to pick original vs background-removed. */
interface ReviewState {
  file: File
  name: string
  originalUrl: string
  cleanedUrl?: string
  report?: ImportReport
  error?: string
  choice: BackgroundMode
}

/** Pictures that go through the before / after review (GIFs keep their animation, models skip it). */
const REVIEWABLE = /\.(png|jpe?g|webp)$/i

function nameOf(file: File): string {
  return file.name.replace(/\.[^.]+$/, '').slice(0, 32)
}

function reportSteps(report: ImportReport): string[] {
  const steps = [t('import.step.format', { format: report.format.toUpperCase() })]
  if (report.kind === '3d') {
    if (report.originalTriangles !== undefined && report.finalTriangles !== undefined) {
      steps.push(t('import.step.mesh', { from: formatCount(report.originalTriangles), to: formatCount(report.finalTriangles) }))
    }
    if (report.textureSize !== undefined) steps.push(t('import.step.texture', { size: report.textureSize }))
  } else if (report.format === 'gif') {
    steps.push(t('import.step.gif'))
  } else {
    if (report.background === 'removed') steps.push(t('import.step.bgRemoved', { color: report.backgroundColor ?? '' }))
    else if (report.background === 'transparent') steps.push(t('import.step.bgTransparent'))
    else if (report.background === 'not-uniform') steps.push(t('import.step.bgComplex'))
    else if (report.background === 'kept') steps.push(t('import.step.bgKept'))
    steps.push(t('import.step.trim'))
  }
  steps.push(t('import.step.bytes', { from: formatBytes(report.originalBytes), to: formatBytes(report.finalBytes) }))
  steps.push(t('import.step.ready'))
  return steps
}

/** Crop a transparent PNG data URL to its content and bound it for a thumbnail. */
async function thumbnailFrom(dataUrl: string, maxEdge = 256): Promise<Blob | undefined> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const src = document.createElement('canvas')
  src.width = image.naturalWidth
  src.height = image.naturalHeight
  const g = src.getContext('2d')
  if (g === null) return undefined
  g.drawImage(image, 0, 0)
  const { data, width, height } = g.getImageData(0, 0, src.width, src.height)
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return undefined
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * scale))
  out.height = Math.max(1, Math.round(h * scale))
  out.getContext('2d')?.drawImage(src, minX, minY, w, h, 0, 0, out.width, out.height)
  return new Promise(resolve => out.toBlob(blob => resolve(blob ?? undefined), 'image/png'))
}

function Switch(props: { checked: boolean; onChange: (value: boolean) => void; label: string }): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={css.switch}
      onClick={() => props.onChange(!props.checked)}
    />
  )
}

export function SettingsPage(props: { store: DpetStore }): ReactElement {
  const { store } = props
  const { state, pets } = useDpet(store)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [previewPhase, setPreviewPhase] = useState<ActivityPhase>('idle')
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [importing, setImporting] = useState<ImportState | undefined>(undefined)
  const [review, setReview] = useState<ReviewState | undefined>(undefined)
  const [dropping, setDropping] = useState(false)
  const stageHandle = useRef<PetHandle | undefined>(undefined)
  const pendingPreview = useRef<string | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => { store.refresh(); void store.refreshPets() }, [store])

  if (state === undefined || pets === undefined) {
    return <div className={css.page}><p className={css.muted}>…</p></div>
  }
  const { settings } = state
  const selected = pets.find(p => p.id === selectedId) ?? state.pet
  const patch = (value: Partial<DpetSettings>): void => store.patchSettings(value)

  const closeReview = (current: ReviewState | undefined): void => {
    if (current === undefined) return
    URL.revokeObjectURL(current.originalUrl)
    if (current.cleanedUrl !== undefined) URL.revokeObjectURL(current.cleanedUrl)
  }

  const startReview = async (file: File): Promise<void> => {
    closeReview(review)
    setImporting(undefined)
    const originalUrl = URL.createObjectURL(file)
    setReview({ file, name: nameOf(file), originalUrl, choice: 'remove' })
    const result = await api.previewImport(file)
    setReview((current) => {
      if (current === undefined || current.originalUrl !== originalUrl) return current
      if (!result.ok) return { ...current, error: result.error, choice: 'keep' }
      return {
        ...current,
        cleanedUrl: URL.createObjectURL(result.image),
        report: result.report,
        choice: result.report.background === 'removed' ? 'remove' : 'keep',
      }
    })
  }

  const runImport = (file: File): void => {
    if (REVIEWABLE.test(file.name)) void startReview(file)
    else void upload(file, nameOf(file), 'remove')
  }

  const upload = async (file: File, name: string, background: BackgroundMode): Promise<void> => {
    const base: ImportState = { status: 'uploading', file: file.name, size: file.size, progress: 0, steps: [] }
    setImporting(base)
    const result = await api.importFile(file, name, background, (progress) => {
      setImporting(current => current === undefined ? current : { ...current, progress, status: progress >= 1 ? 'processing' : 'uploading' })
    })
    if (!result.ok) {
      setImporting({ ...base, status: 'error', progress: 1, error: errorText(result.error) })
      return
    }
    setImporting({ ...base, status: 'done', progress: 1, steps: reportSteps(result.report), name: result.pet.name })
    await store.refreshPets()
    setSelectedId(result.pet.id)
    if (result.pet.kind === '3d') pendingPreview.current = result.pet.id
  }

  const onStageReady = (handle: PetHandle): void => {
    const id = pendingPreview.current
    if (id === undefined || id !== selected.id) return
    pendingPreview.current = undefined
    const dataUrl = handle.snapshot()
    if (dataUrl === undefined) return
    void thumbnailFrom(dataUrl).then(async (blob) => {
      if (blob === undefined) return
      const saved = await api.setPreview(id, blob)
      if (saved.ok) {
        await store.refreshPets()
        setImporting(current => current === undefined ? current : { ...current, steps: [...current.steps, t('import.step.preview')] })
      }
    })
  }

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    if (file !== undefined) void runImport(file)
  }

  const previewLine = activityLine(PREVIEW_LINES[previewPhase], selected.name)

  return (
    <div
      className={css.page}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
      onDrop={onDrop}
    >
      <div className={css.head}>
        <div className={css.grow}>
          <h2>{t('settings.title')}</h2>
          <p className={css.sub}>{t('settings.subtitle')}</p>
        </div>
        <div className={css.switchRow}>
          {t('settings.enabled')}
          <Switch checked={settings.enabled} label={t('settings.enabled')} onChange={enabled => patch({ enabled })} />
        </div>
      </div>

      {/* hero: live stage + selected pet */}
      <div className={css.hero}>
        <div>
          <div className={css.stageBox}>
            <PetStage
              className={css.stage}
              pet={selected}
              phase={previewPhase}
              motions={settings.motions}
              lookAtCursor={settings.lookAtCursor}
              onHandle={(h) => { stageHandle.current = h }}
              onReady={onStageReady}
            />
            {previewLine !== undefined && <div key={previewPhase} className={css.stageBubble}>{previewLine}</div>}
            <div className={css.stageTip}>{t('stage.tip')}</div>
            <button
              type="button"
              aria-label={t('stage.tip')}
              style={{ position: 'absolute', inset: '36px 0 0', background: 'none', border: 0, cursor: 'pointer' }}
              onClick={() => stageHandle.current?.tap()}
            />
          </div>
          <div className={css.chips}>
            <span className={`${css.muted} ${css.small}`}>{t('stage.previewState')}</span>
            {ACTIVITY_PHASES.map(phase => (
              <button key={phase} type="button" className={css.chip} aria-pressed={phase === previewPhase} onClick={() => setPreviewPhase(phase)}>
                {t(('phase.' + phase) as I18nKey)}
              </button>
            ))}
          </div>
        </div>

        <div className={css.info}>
          <div>
            {renaming === undefined
              ? <div className={css.infoName}>{selected.name}</div>
              : (
                  <form
                    className={css.btns}
                    onSubmit={(e) => {
                      e.preventDefault()
                      void api.rename(selected.id, renaming).then(async () => {
                        setRenaming(undefined)
                        await store.refreshPets()
                        store.refresh()
                      })
                    }}
                  >
                    <input className={css.input} value={renaming} maxLength={32} autoFocus onChange={e => setRenaming(e.target.value)} />
                    <button type="submit" className={css.btn}>{t('info.renameSave')}</button>
                    <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => setRenaming(undefined)}>{t('info.renameCancel')}</button>
                  </form>
                )}
            <div className={`${css.muted} ${css.small}`}>{selected.description ?? t(selected.builtin ? 'info.builtin' : 'info.imported')}</div>
          </div>
          <dl className={css.kv}>
            <dt>{t('info.type')}</dt>
            <dd>{selected.kind === '3d' ? t('info.kind3d') : isGif(selected) ? t('info.kindGif') : t('info.kind2d')}</dd>
            {(selected.bytes !== undefined || selected.triangles !== undefined) && (
              <>
                <dt>{t('info.detail')}</dt>
                <dd>
                  {[selected.bytes === undefined ? undefined : formatBytes(selected.bytes),
                    selected.triangles === undefined ? undefined : t('info.triangles', { n: formatCount(selected.triangles) })]
                    .filter(Boolean).join(' · ')}
                </dd>
              </>
            )}
            {selected.source !== undefined && (<><dt>{t('info.source')}</dt><dd>{selected.source}</dd></>)}
            {selected.author !== undefined && (<><dt>{t('info.author')}</dt><dd>{selected.author}</dd></>)}
          </dl>
          <div className={css.btns}>
            <button type="button" className={css.btn} disabled={selected.id === state.pet.id} onClick={() => patch({ petId: selected.id, enabled: true })}>
              {selected.id === state.pet.id ? t('info.using') : t('info.use')}
            </button>
            {!selected.builtin && (
              <>
                <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => setRenaming(selected.name)}>{t('info.rename')}</button>
                <button
                  type="button"
                  className={`${css.btn} ${css.btnGhost} ${css.btnDanger}`}
                  onClick={() => {
                    if (!window.confirm(t('info.confirmDelete', { name: selected.name }))) return
                    void api.remove(selected.id).then(async () => {
                      setSelectedId(undefined)
                      await store.refreshPets()
                      store.refresh()
                    })
                  }}
                >
                  {t('info.delete')}
                </button>
              </>
            )}
          </div>
          <ul className={css.highlights}>
            <li>{t('info.highlight3d')}</li>
            <li>{t('info.highlightAgent')}</li>
            <li>{t('info.highlight2d')}</li>
          </ul>
        </div>
      </div>

      {/* gallery + import */}
      <section className={css.section}>
        <h3>{t('gallery.title')}</h3>
        <p className={css.hint}>{t('gallery.hint')}</p>
        <div className={css.gallery}>
          {pets.map(pet => {
            const thumb = thumbOf(pet)
            return (
              <button key={pet.id} type="button" className={css.card} aria-selected={pet.id === selected.id} onClick={() => setSelectedId(pet.id)}>
                <div className={css.thumb}>
                  {thumb === undefined ? <span className={css.thumbEmpty}>3D</span> : <img src={thumb} alt="" draggable={false} />}
                </div>
                <div className={css.cardBody}>
                  <div className={css.cardTitle}><span>{pet.name}</span><span className={css.badge}>{kindBadge(pet)}</span></div>
                  <div className={css.cardMeta}>{pet.bytes === undefined ? t(pet.builtin ? 'info.builtin' : 'info.imported') : formatBytes(pet.bytes)}</div>
                </div>
                {pet.id === state.pet.id && <span className={css.using}>{t('info.using')}</span>}
              </button>
            )
          })}
          <button type="button" className={`${css.card} ${css.add} ${dropping ? css.addActive : ''}`} onClick={() => fileInput.current?.click()}>
            <div className={css.plus}>+</div>
            <div className={css.cardTitle}>{dropping ? t('gallery.drop') : t('gallery.add')}</div>
            <div className={css.cardMeta}>{t('gallery.addHint')}<br />{t('gallery.formats')}</div>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file !== undefined) void runImport(file)
            }}
          />
        </div>
        {review !== undefined && (
          <div className={css.import}>
            <div className={css.importHead}><b>{t('import.review', { file: review.file.name })}</b></div>
            <p className={css.hint} style={{ margin: '4px 0 10px' }}>{t('import.reviewHint')}</p>
            <div className={css.review}>
              <button type="button" className={css.tile} aria-pressed={review.choice === 'keep'} onClick={() => setReview({ ...review, choice: 'keep' })}>
                <div className={css.checker}><img src={review.originalUrl} alt="" draggable={false} /></div>
                <span>{t('import.original')}</span>
              </button>
              {(review.report === undefined ? review.error === undefined : review.report.background === 'removed') && (
                <button
                  type="button"
                  className={css.tile}
                  aria-pressed={review.choice === 'remove'}
                  disabled={review.cleanedUrl === undefined}
                  onClick={() => setReview({ ...review, choice: 'remove' })}
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
                onChange={e => setReview({ ...review, name: e.target.value })}
              />
              <button
                type="button"
                className={css.btn}
                disabled={review.error !== undefined || review.report === undefined || review.name.trim() === ''}
                onClick={() => {
                  const current = review
                  closeReview(current)
                  setReview(undefined)
                  void upload(current.file, current.name.trim(), current.choice)
                }}
              >
                {t('import.create')}
              </button>
              <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => { closeReview(review); setReview(undefined) }}>
                {t('import.cancel')}
              </button>
            </div>
          </div>
        )}
        {importing !== undefined && (
          <div className={css.import}>
            <div className={css.importHead}>
              <b className={importing.status === 'error' ? css.importError : undefined}>
                {importing.status === 'uploading' && t('import.uploading', { file: importing.file, size: formatBytes(importing.size) })}
                {importing.status === 'processing' && t('import.processing')}
                {importing.status === 'done' && t('import.done', { name: importing.name ?? importing.file })}
                {importing.status === 'error' && t('import.failed', { reason: importing.error ?? '' })}
              </b>
              {(importing.status === 'done' || importing.status === 'error') && (
                <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => setImporting(undefined)}>{t('import.close')}</button>
              )}
            </div>
            {(importing.status === 'uploading' || importing.status === 'processing') && (
              <div className={css.progress}><div style={{ width: Math.round(importing.progress * 100) + '%' }} /></div>
            )}
            {importing.steps.length > 0 && (
              <ol className={css.importSteps}>{importing.steps.map(step => <li key={step}>{step}</li>)}</ol>
            )}
          </div>
        )}
      </section>

      {/* motion editor */}
      <section className={css.section}>
        <div className={css.head}>
          <div className={css.grow}>
            <h3>{t('mapping.title')}</h3>
          </div>
          <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => patch({ motions: {} })}>{t('mapping.reset')}</button>
        </div>
        <div className={css.mapping}>
          {ACTIVITY_PHASES.map(phase => {
            const current = motionForPhase(phase, settings.motions)
            return (
              <div key={phase} className={css.mapRow} data-live={phase === previewPhase}>
                <div className={css.mapState}>{t(('phase.' + phase) as I18nKey)}</div>
                <div className={css.mapMotions}>
                  {PET_MOTIONS.map((motion: PetMotion) => (
                    <button
                      key={motion}
                      type="button"
                      className={css.chip}
                      aria-pressed={motion === current}
                      onClick={() => {
                        patch({ motions: { ...settings.motions, [phase]: motion } })
                        setPreviewPhase(phase)
                      }}
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

      {/* placement + appearance */}
      <section className={css.section}>
        <h3>{t('place.title')}</h3>
        <p className={css.hint}>{t('place.hint')}</p>
        <div className={css.place}>
          <MiniScreen pet={state.pet} settings={settings} onMove={(right, bottom) => patch({ right, bottom })} />
          <div className={css.controls}>
            <div>{t('place.position', { right: settings.right, bottom: settings.bottom })}</div>
            <div className={css.row}>
              <label htmlFor="dpet-size">{t('place.size')}</label>
              <input
                id="dpet-size"
                type="range"
                min={SETTINGS_LIMITS.size.min}
                max={SETTINGS_LIMITS.size.max}
                value={settings.size}
                onChange={e => patch({ size: Number(e.target.value) })}
              />
              <output>{settings.size} px</output>
            </div>
            <div className={css.row}>
              <label htmlFor="dpet-opacity">{t('place.opacity')}</label>
              <input
                id="dpet-opacity"
                type="range"
                min={SETTINGS_LIMITS.opacity.min * 100}
                max={100}
                value={Math.round(settings.opacity * 100)}
                onChange={e => patch({ opacity: Number(e.target.value) / 100 })}
              />
              <output>{Math.round(settings.opacity * 100)}%</output>
            </div>
            <div className={css.toggle}>
              <div>{t('place.look')}<small>{t('place.lookHint')}</small></div>
              <Switch checked={settings.lookAtCursor} label={t('place.look')} onChange={lookAtCursor => patch({ lookAtCursor })} />
            </div>
            <div className={css.toggle}>
              <div>{t('place.bubbles')}<small>{t('place.bubblesHint')}</small></div>
              <Switch checked={settings.bubbles} label={t('place.bubbles')} onChange={bubbles => patch({ bubbles })} />
            </div>
          </div>
        </div>
      </section>

      {/* roadmap */}
      <section className={css.road}>
        <div className={css.roadHead}>{t('roadmap.title')}<span className={css.tag}>{t('roadmap.tag')}</span></div>
        <p className={css.hint} style={{ margin: '6px 0 0' }}>{t('roadmap.hint')}</p>
        <div className={css.flow}>
          {(['1', '2', '3', '4'] as const).map((n, i) => (
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
    </div>
  )
}

/** A scaled-down window where the pet can be dragged into place. */
function MiniScreen(props: { pet: PetView; settings: DpetSettings; onMove: (right: number, bottom: number) => void }): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null)
  const [box, setBox] = useState({ w: 400, h: 200 })

  useEffect(() => {
    const el = boxRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const vw = Math.max(1, window.innerWidth)
  const vh = Math.max(1, window.innerHeight)
  const sx = box.w / vw
  const sy = box.h / vh
  const height = Math.max(20, props.settings.size * sy)
  const width = height * PET_ASPECT
  const thumb = props.pet.previewUrl ?? (props.pet.kind === '2d' ? props.pet.fileUrl : undefined)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, right: props.settings.right, bottom: props.settings.bottom }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d === null) return
    const petW = props.settings.size * PET_ASPECT
    const right = Math.min(Math.max(0, d.right - (e.clientX - d.x) / sx), Math.max(0, vw - petW))
    const bottom = Math.min(Math.max(0, d.bottom - (e.clientY - d.y) / sy), Math.max(0, vh - props.settings.size))
    props.onMove(Math.round(right), Math.round(bottom))
  }

  return (
    <div ref={boxRef} className={css.screen}>
      <span className={css.screenLabel}>{t('place.window')}</span>
      <div className={css.fakeLines} />
      <div
        className={css.miniPet}
        style={{
          right: props.settings.right * sx,
          bottom: props.settings.bottom * sy,
          width,
          height,
          opacity: props.settings.opacity,
          ...(thumb === undefined
            ? { background: 'var(--dsw-alias-label-dimmed, #98a2b3)', borderRadius: 8 }
            : { backgroundImage: `url("${thumb}")` }),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
      />
    </div>
  )
}
