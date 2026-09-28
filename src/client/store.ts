/**
 * Client store — polls the host state while the tab is visible and holds the
 * pet list. Settings edits apply locally at once (sliders stay smooth) and
 * reach the host through one debounced write.
 * @module dsh-dpet/client/store
 */

import { useSyncExternalStore } from 'react'
import type { DpetSettings, PetView, StateResponse } from '../types.ts'
import { api } from './api.ts'

/** Poll interval for the host snapshot. */
export const POLL_MS = 1000
/** Settings writes are coalesced over this window. */
const SAVE_DELAY_MS = 300

export interface DpetSnapshot {
  state?: StateResponse
  pets?: PetView[]
}

export interface DpetStore {
  getSnapshot(): DpetSnapshot
  subscribe(listener: () => void): () => void
  /** Fetch state now. */
  refresh(): void
  /** Fetch the pet list now. */
  refreshPets(): Promise<void>
  /** Apply a settings change locally and save it shortly after. */
  patchSettings(patch: Partial<DpetSettings>): void
  start(): void
  stop(): void
}

export function createDpetStore(): DpetStore {
  let snapshot: DpetSnapshot = {}
  const listeners = new Set<() => void>()
  let timer: number | undefined
  let seq = 0
  let pending: Partial<DpetSettings> = {}
  let saveTimer: number | undefined
  let saving: Promise<void> = Promise.resolve()

  const publish = (next: DpetSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  /** Local edits not yet confirmed by the host win over polled values. */
  const withPending = (state: StateResponse): StateResponse => {
    if (Object.keys(pending).length === 0) return state
    return { ...state, settings: { ...state.settings, ...pending } }
  }

  const refresh = (): void => {
    const mine = ++seq
    api.state().then((state) => {
      if (mine !== seq || state.settings === undefined) return
      const petChanged = snapshot.state?.pet.id !== state.pet.id
      publish({ ...snapshot, state: withPending(state) })
      if (petChanged || snapshot.pets === undefined) void refreshPets()
    }, () => {})
  }

  const refreshPets = async (): Promise<void> => {
    try {
      const pets = await api.pets()
      if (Array.isArray(pets)) publish({ ...snapshot, pets })
    } catch {}
  }

  const flush = (): void => {
    saveTimer = undefined
    const patch = pending
    saving = saving.then(async () => {
      try {
        await api.updateSettings(patch)
      } catch {}
      // Only drop the fields this write carried; newer edits stay pending.
      for (const key of Object.keys(patch) as (keyof DpetSettings)[]) {
        if (pending[key] === patch[key]) delete pending[key]
      }
      refresh()
    })
  }

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      refresh()
      if (timer === undefined) timer = window.setInterval(refresh, POLL_MS)
    } else if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    refreshPets,
    patchSettings(patch) {
      pending = { ...pending, ...patch }
      if (snapshot.state !== undefined) {
        const pet = patch.petId === undefined ? snapshot.state.pet : snapshot.pets?.find(p => p.id === patch.petId) ?? snapshot.state.pet
        publish({ ...snapshot, state: { ...snapshot.state, pet, settings: { ...snapshot.state.settings, ...patch } } })
      }
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(flush, SAVE_DELAY_MS)
    },
    start() {
      document.addEventListener('visibilitychange', onVisibility)
      onVisibility()
      void refreshPets()
    },
    stop() {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer)
        flush()
      }
    },
  }
}

/** React binding. */
export function useDpet(store: DpetStore): DpetSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
