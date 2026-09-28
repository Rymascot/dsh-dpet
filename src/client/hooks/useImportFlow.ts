/**
 * The import flow of the settings page, as a hook (the React counterpart of
 * a Vue composable): still pictures first go through a before / after review
 * of the background removal; models and GIFs upload directly; a freshly
 * imported 3D model gets its gallery thumbnail captured from the preview
 * stage once it is on screen.
 * @module dsh-dpet/client/hooks/useImportFlow
 */

import { useRef, useState } from 'react'
import type { BackgroundMode, ImportReport } from '../../shared/types.ts'
import { api } from '../api/dpet.ts'
import type { DpetStore } from '../store/dpet.ts'
import type { PetHandle } from '../engine/flat.ts'
import { t } from '../i18n/index.ts'
import { REVIEWABLE, errorText, nameOf, reportSteps, thumbnailFrom } from '../utils/import-report.ts'

/** Upload progress shown under the gallery. */
export interface ImportProgress {
  status: 'uploading' | 'processing' | 'done' | 'error'
  file: string
  size: number
  progress: number
  steps: string[]
  error?: string
  name?: string
}

/** A still picture waiting for the user to pick original vs background-removed. */
export interface ImportReview {
  file: File
  name: string
  originalUrl: string
  cleanedUrl?: string
  report?: ImportReport
  error?: string
  choice: BackgroundMode
}

export interface ImportFlow {
  review: ImportReview | undefined
  progress: ImportProgress | undefined
  /** Start importing a file chosen or dropped by the user. */
  start(file: File): void
  /** Review: pick the original or the cleaned picture. */
  choose(choice: BackgroundMode): void
  /** Review: edit the pet name. */
  rename(name: string): void
  /** Review: create the pet with the current choice. */
  confirm(): void
  /** Review: drop the picture. */
  cancel(): void
  /** Hide the finished progress panel. */
  dismiss(): void
  /** The preview stage finished loading `petId`; capture a thumbnail if it was just imported. */
  stageReady(handle: PetHandle, petId: string): void
}

/**
 * @param store - the client store (refreshed after imports).
 * @param onImported - called with the new pet id so the page can select it.
 */
export function useImportFlow(store: DpetStore, onImported: (petId: string) => void): ImportFlow {
  const [review, setReview] = useState<ImportReview | undefined>(undefined)
  const [progress, setProgress] = useState<ImportProgress | undefined>(undefined)
  const pendingThumbnail = useRef<string | undefined>(undefined)

  const release = (current: ImportReview | undefined): void => {
    if (current === undefined) return
    URL.revokeObjectURL(current.originalUrl)
    if (current.cleanedUrl !== undefined) URL.revokeObjectURL(current.cleanedUrl)
  }

  const upload = async (file: File, name: string, background: BackgroundMode): Promise<void> => {
    const base: ImportProgress = { status: 'uploading', file: file.name, size: file.size, progress: 0, steps: [] }
    setProgress(base)
    const result = await api.importFile(file, name, background, (ratio) => {
      setProgress(current => current === undefined ? current : { ...current, progress: ratio, status: ratio >= 1 ? 'processing' : 'uploading' })
    })
    if (!result.ok) {
      setProgress({ ...base, status: 'error', progress: 1, error: errorText(result.error) })
      return
    }
    setProgress({ ...base, status: 'done', progress: 1, steps: reportSteps(result.report), name: result.pet.name })
    await store.refreshPets()
    onImported(result.pet.id)
    if (result.pet.kind === '3d') pendingThumbnail.current = result.pet.id
  }

  const startReview = async (file: File): Promise<void> => {
    release(review)
    setProgress(undefined)
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

  return {
    review,
    progress,
    start(file) {
      if (REVIEWABLE.test(file.name)) void startReview(file)
      else void upload(file, nameOf(file), 'remove')
    },
    choose(choice) {
      setReview(current => current === undefined ? current : { ...current, choice })
    },
    rename(name) {
      setReview(current => current === undefined ? current : { ...current, name })
    },
    confirm() {
      const current = review
      if (current === undefined) return
      release(current)
      setReview(undefined)
      void upload(current.file, current.name.trim(), current.choice)
    },
    cancel() {
      release(review)
      setReview(undefined)
    },
    dismiss() {
      setProgress(undefined)
    },
    stageReady(handle, petId) {
      if (pendingThumbnail.current === undefined || pendingThumbnail.current !== petId) return
      pendingThumbnail.current = undefined
      const dataUrl = handle.snapshot()
      if (dataUrl === undefined) return
      void thumbnailFrom(dataUrl).then(async (blob) => {
        if (blob === undefined) return
        const saved = await api.setPreview(petId, blob)
        if (!saved.ok) return
        await store.refreshPets()
        setProgress(current => current === undefined ? current : { ...current, steps: [...current.steps, t('import.step.preview')] })
      })
    },
  }
}
