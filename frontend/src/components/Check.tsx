/**
 * On or off, everywhere in nexnotes: a tick in a box in the accent colour, as the settings show it ("Funktionen für alle
 * Konten"). Never a sliding switch beside it: one look for one kind of choice. A real checkbox, so the keyboard (space),
 * the focus ring and the reader's "checkbox, checked" come with it; its name comes from `aria-label`, `aria-labelledby`
 * or a `<label>` round it.
 */
import type { InputHTMLAttributes, Ref } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange' | 'className' | 'role'> & {
  checked: boolean
  onChange: (value: boolean) => void
  /** The box itself, e.g. to show it half ticked (`indeterminate`). */
  ref?: Ref<HTMLInputElement>
}

export function Check({ checked, onChange, ...rest }: Props) {
  return (
    <input
      {...rest}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="h-5 w-5 shrink-0 accent-[var(--color-accent-500)]"
    />
  )
}
