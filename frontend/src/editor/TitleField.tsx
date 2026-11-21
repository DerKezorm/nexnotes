/**
 * The title of a note, its own field above the text (NOTES-3 AC-9), written together like the text: it is the
 * `title` of the Yjs document. At most 120 characters (EC-7); Enter goes into the text (AC-1).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type * as Y from 'yjs'

import { MAX_TITLE, mapCaret, writeTitle } from './title'

/** The origin of changes typed here, so that the field does not answer its own changes. */
const TYPED = Symbol('title typed')

export type TitleFieldHandle = { focus: () => void }

type Props = {
  doc: Y.Doc
  editable: boolean
  /** Enter, or the arrow down at the end: into the text. */
  onEnter: () => void
  /** The value when the field is drawn, then every new one, typed here or by someone else. */
  onValue?: (value: string) => void
  autoFocus?: boolean
  invalid?: boolean
  describedBy?: string
}

export const TitleField = forwardRef<TitleFieldHandle, Props>(function TitleField({ doc, editable, onEnter, onValue, autoFocus, invalid, describedBy }, ref) {
  const { t } = useTranslation()
  const text = doc.getText('title')
  const [value, setValue] = useState(() => text.toString())
  const input = useRef<HTMLInputElement>(null)
  const last = useRef(value)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])

  useEffect(() => {
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === TYPED) return
      const next = text.toString()
      const field = input.current
      const focused = field !== null && document.activeElement === field
      const start = field?.selectionStart ?? 0
      const end = field?.selectionEnd ?? 0
      last.current = next
      setValue(next)
      onValue?.(next)
      if (focused && field) {
        // Others typed in the title too: the caret stays where it was in the words.
        const delta = event.delta as Array<{ retain?: number; insert?: unknown; delete?: number }>
        const from = mapCaret(start, delta)
        const to = mapCaret(end, delta)
        requestAnimationFrame(() => field.setSelectionRange(from, to))
      }
    }
    text.observe(observer)
    // The value there is now, always: a document that has its title before the field is drawn (the same note on the
    // other side, a parked connection opened again) changes nothing afterwards, and the note must still know it.
    const now = text.toString()
    if (now !== last.current) {
      last.current = now
      setValue(now)
    }
    onValue?.(now)
    return () => text.unobserve(observer)
    // onValue is read when called; a new function each render does not need a new observer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  return (
    <input
      ref={input}
      type="text"
      value={value}
      maxLength={MAX_TITLE}
      readOnly={!editable}
      placeholder={t('editor.titlePlaceholder')}
      aria-label={t('editor.titleLabel')}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid="note-title"
      dir="auto"
      spellCheck
      onChange={(event) => {
        const next = event.target.value.replace(/[\r\n]+/g, ' ')
        writeTitle(text, last.current, next, TYPED)
        last.current = next
        setValue(next)
        onValue?.(next)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || (event.key === 'ArrowDown' && input.current?.selectionStart === value.length)) {
          event.preventDefault()
          onEnter()
        }
      }}
      className={
        // A large field without a box on the sheet (drawing "N3-Editor"); focus shows as a line under the title, a
        // missing title as a red one.
        'w-full border-0 border-b-2 bg-transparent px-0 pt-1 pb-1 text-[26px] leading-tight font-bold tracking-[-0.02em] text-mist-100 placeholder:text-mist-600 focus:outline-none md:text-[28px] ' +
        (invalid ? 'border-bad-500' : 'border-transparent focus-visible:border-accent-500/70 focus:border-accent-500/40')
      }
    />
  )
})
