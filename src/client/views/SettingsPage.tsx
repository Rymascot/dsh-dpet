/**
 * The "桌宠" settings page. It only holds page-level state (which pet is
 * previewed, which AI state is previewed, drag-and-drop) and lays out the
 * section components under ../components/settings/.
 * @module dsh-dpet/client/views/SettingsPage
 */

import { useEffect, useState, type DragEvent, type ReactElement } from 'react'
import type { ActivityPhase, DpetSettings } from '../../shared/types.ts'
import { useDpet, type DpetStore } from '../store/dpet.ts'
import { useImportFlow } from '../hooks/useImportFlow.ts'
import { Switch } from '../components/common/Switch.tsx'
import { PreviewStage } from '../components/settings/PreviewStage.tsx'
import { PetInfoCard } from '../components/settings/PetInfoCard.tsx'
import { PetGallery } from '../components/settings/PetGallery.tsx'
import { ImportPanel } from '../components/settings/ImportPanel.tsx'
import { MotionEditor } from '../components/settings/MotionEditor.tsx'
import { PlacementPanel } from '../components/settings/PlacementPanel.tsx'
import { ComingSoonCard } from '../components/settings/ComingSoonCard.tsx'
import { t } from '../i18n/index.ts'
import css from '../styles/dpet.module.css'

export function SettingsPage(props: { store: DpetStore }): ReactElement {
  const { store } = props
  const { state, pets } = useDpet(store)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [previewPhase, setPreviewPhase] = useState<ActivityPhase>('idle')
  const [dropping, setDropping] = useState(false)
  const flow = useImportFlow(store, setSelectedId)

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
    if (file !== undefined) flow.start(file)
  }

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

      <div className={css.hero}>
        <PreviewStage
          pet={selected}
          phase={previewPhase}
          onPhase={setPreviewPhase}
          motions={settings.motions}
          lookAtCursor={settings.lookAtCursor}
          onReady={handle => flow.stageReady(handle, selected.id)}
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

      <ComingSoonCard />
    </div>
  )
}
