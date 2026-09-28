/**
 * Settings: the card describing the selected pet, with use / rename / delete.
 * Render it with `key={pet.id}` so an unfinished rename never carries over
 * to another pet.
 * @module dsh-dpet/client/components/settings/PetInfoCard
 */

import { useState, type ReactElement } from 'react'
import type { PetView } from '../../../shared/types.ts'
import { api } from '../../api/dpet.ts'
import type { DpetStore } from '../../store/dpet.ts'
import { formatBytes, formatCount, t } from '../../i18n/index.ts'
import { isGif } from '../../utils/pet-view.ts'
import css from '../../styles/dpet.module.css'

export function PetInfoCard(props: {
  pet: PetView
  /** The pet currently shown as the floating pet. */
  inUse: boolean
  store: DpetStore
  onUse: () => void
  onDeleted: () => void
}): ReactElement {
  const { pet, store } = props
  const [renaming, setRenaming] = useState<string | undefined>(undefined)

  const saveName = (name: string): void => {
    void api.rename(pet.id, name).then(async () => {
      setRenaming(undefined)
      await store.refreshPets()
      store.refresh()
    })
  }
  const remove = (): void => {
    if (!window.confirm(t('info.confirmDelete', { name: pet.name }))) return
    void api.remove(pet.id).then(async () => {
      props.onDeleted()
      await store.refreshPets()
      store.refresh()
    })
  }
  const detail = [
    pet.bytes === undefined ? undefined : formatBytes(pet.bytes),
    pet.triangles === undefined ? undefined : t('info.triangles', { n: formatCount(pet.triangles) }),
  ].filter(Boolean).join(' · ')

  return (
    <div className={css.info}>
      <div>
        {renaming === undefined
          ? <div className={css.infoName}>{pet.name}</div>
          : (
              <form className={css.btns} onSubmit={(e) => { e.preventDefault(); saveName(renaming) }}>
                <input className={css.input} value={renaming} maxLength={32} autoFocus onChange={e => setRenaming(e.target.value)} />
                <button type="submit" className={css.btn}>{t('info.renameSave')}</button>
                <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => setRenaming(undefined)}>{t('info.renameCancel')}</button>
              </form>
            )}
        <div className={`${css.muted} ${css.small}`}>{pet.description ?? t(pet.builtin ? 'info.builtin' : 'info.imported')}</div>
      </div>
      <dl className={css.kv}>
        <dt>{t('info.type')}</dt>
        <dd>{pet.kind === '3d' ? t('info.kind3d') : isGif(pet) ? t('info.kindGif') : t('info.kind2d')}</dd>
        {detail !== '' && (<><dt>{t('info.detail')}</dt><dd>{detail}</dd></>)}
        {pet.source !== undefined && (<><dt>{t('info.source')}</dt><dd>{pet.source}</dd></>)}
        {pet.author !== undefined && (<><dt>{t('info.author')}</dt><dd>{pet.author}</dd></>)}
      </dl>
      <div className={css.btns}>
        <button type="button" className={css.btn} disabled={props.inUse} onClick={props.onUse}>
          {props.inUse ? t('info.using') : t('info.use')}
        </button>
        {!pet.builtin && (
          <>
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => setRenaming(pet.name)}>{t('info.rename')}</button>
            <button type="button" className={`${css.btn} ${css.btnGhost} ${css.btnDanger}`} onClick={remove}>{t('info.delete')}</button>
          </>
        )}
      </div>
      <ul className={css.highlights}>
        <li>{t('info.highlight3d')}</li>
        <li>{t('info.highlightAgent')}</li>
        <li>{t('info.highlight2d')}</li>
      </ul>
    </div>
  )
}
