/**
 * The color of a folder (NOTES-4 AC-10): the twelve fixed ones, the own colors used last on this device, and any other
 * through the system's color picker or as `#rrggbb`. The chosen one carries a check mark in black or white, whichever
 * reads on it; the ring of the keyboard focus is a separate outline, so focus never looks like a choice.
 */
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { hexOf, inkOn } from '../lib/color'
import { useDevicePref } from '../lib/devicePref'
import { FOLDER_COLORS } from './palette'

/** How many own colors the device keeps at hand. */
export const RECENT_COLORS = 6

function parseRecent(raw: string | null): string[] {
  try {
    const list = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list.map((item) => hexOf(String(item))).filter((item): item is string => item !== null).slice(0, RECENT_COLORS) : []
  } catch {
    return []
  }
}

function Swatch({ hex, label, chosen, onChoose }: { hex: string; label: string; chosen: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={chosen}
      title={label}
      onClick={onChoose}
      className={
        'flex h-8 items-center justify-center rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent-500 ' +
        (chosen ? 'ring-2 ring-mist-100 ring-offset-2 ring-offset-ink-850' : 'border border-ink-600')
      }
      style={{ background: hex }}
      data-color={hex}
    >
      {chosen && <Check aria-hidden className="h-4 w-4" strokeWidth={3} style={{ color: inkOn(hex) }} data-testid="color-chosen" />}
    </button>
  )
}

export function ColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  const [recentRaw, setRecent] = useDevicePref('folder.colors', (raw) => raw)
  const recent = parseRecent(recentRaw)
  const own = hexOf(value) && value.startsWith('#') ? value : null
  const [draft, setDraft] = useState(own ?? '')
  const [wrong, setWrong] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(own ?? ''), [own])

  /** An own color is chosen: it goes first in the row of recent ones. */
  const takeOwn = (hex: string) => {
    setWrong(false)
    setRecent(JSON.stringify([hex, ...recent.filter((item) => item !== hex)].slice(0, RECENT_COLORS)))
    onChange(hex)
  }

  // The system's picker reports every move while it is open ("input") and the result when it closes ("change"): the
  // preview follows the moves, the choice is the result.
  useEffect(() => {
    const input = picker.current
    if (!input) return
    const done = () => {
      const hex = hexOf(input.value)
      if (hex) takeOwn(hex)
    }
    input.addEventListener('change', done)
    return () => input.removeEventListener('change', done)
  })

  const typed = () => {
    if (!draft.trim()) return
    const hex = hexOf(draft)
    if (hex) takeOwn(hex)
    else setWrong(true)
  }

  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">{t('folders.style.color')}</legend>
      <div className="grid grid-cols-6 gap-2">
        {FOLDER_COLORS.map((color) => (
          <Swatch key={color.key} hex={color.hex} label={t(`folders.colors.${color.key}`)} chosen={value === color.key} onChoose={() => onChange(color.key)} />
        ))}
        {recent.map((hex) => (
          <Swatch key={hex} hex={hex} label={t('folders.style.ownColor', { hex })} chosen={value === hex} onChoose={() => takeOwn(hex)} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-mist-300">
          <input
            ref={picker}
            type="color"
            value={own ?? '#7a8890'}
            aria-label={t('folders.style.pickColor')}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-10 cursor-pointer rounded-lg border border-ink-600 bg-transparent p-0.5"
            data-testid="color-picker"
          />
          {t('folders.style.custom')}
        </label>
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setWrong(false)
          }}
          onBlur={typed}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            typed()
          }}
          placeholder="#rrggbb"
          aria-label={t('folders.style.hex')}
          aria-invalid={wrong || undefined}
          aria-describedby={wrong ? 'color-hex-wrong' : undefined}
          maxLength={7}
          spellCheck={false}
          className="nn-field w-28 font-mono"
          data-testid="color-hex"
        />
        <button type="button" aria-pressed={!value} onClick={() => onChange('')} className="nn-btn-quiet text-sm">
          {t('folders.style.noColor')}
        </button>
      </div>
      {wrong && (
        <p id="color-hex-wrong" role="alert" className="mt-1 text-xs text-bad-500">
          {t('folders.style.hexWrong')}
        </p>
      )}
    </fieldset>
  )
}
