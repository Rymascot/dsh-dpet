/**
 * An on/off switch in the DSH style.
 * @module dsh-dpet/client/components/common/Switch
 */

import type { ReactElement } from 'react'
import css from '../../styles/dpet.module.css'

export function Switch(props: { checked: boolean; onChange: (value: boolean) => void; label: string }): ReactElement {
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
