/**
 * The "桌宠" settings page. It only holds page-level state (which tab is
 * open, which pet is previewed, which AI state is previewed, drag-and-drop)
 * and lays out the section components under ../components/settings/.
 *
 * Two tabs under the header: "桌宠" (the pet itself: preview, gallery,
 * image-to-3D, motions, placement) and "Key 密钥" (the Tencent Hunyuan key,
 * a one-time setup kept out of the everyday settings).
 * @module dsh-dpet/client/views/SettingsPage
 */

import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type { ActivityPhase, DpetSettings } from '../../shared/types.ts'
import { useDpet, type DpetStore } from '../store/dpet.ts'
import { useImportFlow } from '../hooks/useImportFlow.ts'
import { useGenerate } from '../hooks/useGenerate.ts'
import { Switch } from '../components/common/Switch.tsx'
import { Tabs } from '../components/common/Tabs.tsx'
import { PreviewStage } from '../components/settings/PreviewStage.tsx'
import { PetInfoCard } from '../components/settings/PetInfoCard.tsx'
import { PetGallery } from '../components/settings/PetGallery.tsx'
import { ImportPanel } from '../components/settings/ImportPanel.tsx'
import { MotionEditor } from '../components/settings/MotionEditor.tsx'
import { PlacementPanel } from '../components/settings/PlacementPanel.tsx'
import { GenerateCard } from '../components/settings/GenerateCard.tsx'
import { KeyPanel } from '../components/settings/KeyPanel.tsx'
import { t } from '../i18n/index.ts'
import css from '../styles/dpet.module.css'

type Tab = 'pet' | 'key'

export function SettingsPage(props: { store: DpetStore }): ReactElement {
  const { store } = props
  const { state, pets } = useDpet(store)
  const [tab, setTab] = useState<Tab>('pet')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [previewPhase, setPreviewPhase] = useState<ActivityPhase>('idle')
  const [dropping, setDropping] = useState(false)
  const flow = useImportFlow(store, setSelectedId)
  const topRef = useRef<HTMLDivElement | null>(null)
  const heroRef = useRef<HTMLDivElement | null>(null)
  const generateRef = useRef<HTMLElement | null>(null)
  /** Show a pet on the preview stage and bring the stage into view. */
  const showOnStage = (petId: string): void => {
    setSelectedId(petId)
    heroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  const generate = useGenerate(store, showOnStage)

  /** Switch tabs from a button inside the page, then bring the right spot into view. */
  const jump = (next: Tab, target: 'top' | 'generate'): void => {
    setTab(next)
    window.requestAnimationFrame(() => {
      const element = target === 'generate' ? generateRef.current : topRef.current
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  useEffect(() => { store.refresh(); void store.refreshPets() }, [store])

  if (state === undefined || pets === undefined) {
    return <div className={css.page}><p className={css.muted}>…</p></div>
  }
  const { settings } = state
  const selected = pets.find(p => p.id === selectedId) ?? state.pet
  const patch = (value: Partial<DpetSettings>): void => store.patchSettings(value)

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    if (file === undefined) return
    // A file dropped on the key tab is still an import: show it where it happens.
    if (tab !== 'pet') setTab('pet')
    flow.start(file)
  }

  return (
    <div
      className={css.page}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
      onDrop={onDrop}
    >
      <div className={css.top} ref={topRef}>
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
        <Tabs
          value={tab}
          label={t('settings.tabs')}
          items={[{ id: 'pet', label: t('tabs.pet') }, { id: 'key', label: t('tabs.key') }]}
          onChange={setTab}
        />
      </div>

      {tab === 'key'
        ? <KeyPanel flow={generate} onGoGenerate={() => jump('pet', 'generate')} />
        : <>
            <div className={css.hero} ref={heroRef}>
              <PreviewStage
                pet={selected}
                phase={previewPhase}
                onPhase={setPreviewPhase}
                motions={settings.motions}
                lookAtCursor={settings.lookAtCursor}
                onReady={handle => flow.stageReady(handle, selected)}
              />
              <PetInfoCard
                key={selected.id}
                pet={selected}
                inUse={selected.id === state.pet.id}
                store={store}
                onUse={() => patch({ petId: selected.id, enabled: true })}
                onDeleted={() => setSelectedId(undefined)}
              />
            </div>

            <section className={css.section}>
              <h3>{t('gallery.title')}</h3>
              <p className={css.hint}>{t('gallery.hint')}</p>
              <PetGallery
                pets={pets}
                selectedId={selected.id}
                currentId={state.pet.id}
                dropping={dropping}
                onSelect={setSelectedId}
                onFile={file => flow.start(file)}
              />
              <ImportPanel flow={flow} />
            </section>

            <GenerateCard
              flow={generate}
              pets={pets}
              currentId={state.pet.id}
              sectionRef={generateRef}
              onView={showOnStage}
              onUse={(petId) => patch({ petId, enabled: true })}
              onOpenKeys={() => jump('key', 'top')}
            />

            <MotionEditor
              motions={settings.motions}
              livePhase={previewPhase}
              onPick={(phase, motion) => {
                patch({ motions: { ...settings.motions, [phase]: motion } })
                setPreviewPhase(phase)
              }}
              onReset={() => patch({ motions: {} })}
            />

            <PlacementPanel pet={state.pet} settings={settings} patch={patch} />
          </>}
    </div>
  )
}
