/**
 * Settings: the pet gallery cards and the import card.
 * @module dsh-dpet/client/components/settings/PetGallery
 */

import { useRef, type ReactElement } from 'react'
import type { PetView } from '../../../shared/types.ts'
import { formatBytes, t } from '../../i18n/index.ts'
import { kindBadge, thumbOf } from '../../utils/pet-view.ts'
import { ACCEPT } from '../../utils/import-report.ts'
import css from '../../styles/dpet.module.css'

export function PetGallery(props: {
  pets: PetView[]
  selectedId: string
  currentId: string
  /** A file is being dragged over the page. */
  dropping: boolean
  onSelect: (petId: string) => void
  onFile: (file: File) => void
}): ReactElement {
  const fileInput = useRef<HTMLInputElement | null>(null)
  return (
    <div className={css.gallery}>
      {props.pets.map((pet) => {
        const thumb = thumbOf(pet)
        return (
          <button key={pet.id} type="button" className={css.card} aria-selected={pet.id === props.selectedId} onClick={() => props.onSelect(pet.id)}>
            <div className={css.thumb}>
              {thumb === undefined ? <span className={css.thumbEmpty}>3D</span> : <img src={thumb} alt="" draggable={false} />}
            </div>
            <div className={css.cardBody}>
              <div className={css.cardTitle}><span>{pet.name}</span><span className={css.badge}>{kindBadge(pet)}</span></div>
              <div className={css.cardMeta}>{pet.bytes === undefined ? t(pet.builtin ? 'info.builtin' : 'info.imported') : formatBytes(pet.bytes)}</div>
            </div>
            {pet.id === props.currentId && <span className={css.using}>{t('info.using')}</span>}
          </button>
        )
      })}
      <button type="button" className={`${css.card} ${css.add} ${props.dropping ? css.addActive : ''}`} onClick={() => fileInput.current?.click()}>
        <div className={css.plus}>+</div>
        <div className={css.cardTitle}>{props.dropping ? t('gallery.drop') : t('gallery.add')}</div>
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
          if (file !== undefined) props.onFile(file)
        }}
      />
    </div>
  )
}
