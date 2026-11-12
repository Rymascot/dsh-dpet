/**
 * Underlined tabs ("横线" style): a row of labels with a line under the
 * selected one. Left / right arrow keys move between tabs.
 * @module dsh-dpet/client/components/common/Tabs
 */

import type { KeyboardEvent, ReactElement } from 'react'
import css from '../../styles/dpet.module.css'

export interface TabItem<T extends string> {
  id: T
  label: string
}

export function Tabs<T extends string>(props: {
  value: T
  items: readonly TabItem<T>[]
  label: string
  onChange: (id: T) => void
}): ReactElement {
  const { value, items, onChange } = props

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const index = items.findIndex(item => item.id === value)
    const next = items[(index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]
    if (next === undefined) return
    onChange(next.id)
    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  return (
    <div role="tablist" aria-label={props.label} className={css.tabs} onKeyDown={onKeyDown}>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          data-tab={item.id}
          aria-selected={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          className={css.tab}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
