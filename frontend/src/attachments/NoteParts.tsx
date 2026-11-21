/**
 * What an open note shows of attachments around its text (NOTES-10, drawings "N10-Notiz", "N10-Hochladen",
 * "Handy-Anhaenge"):
 *
 * - "Anhängen" in the head of the note: the system's file choice on a laptop; on a phone a sheet with "Foto", "Datei"
 *   and "Link" (photos only through the system's choice, NOTES-23);
 * - while files are dragged over the note, the area that takes them, with the limit per file (AC-1);
 * - files refused for their size or a full storage, with name, size and limit, each to put away (AC-6, EC-1);
 * - the way from the gallery to an attachment in the note (`?attachment=<id>`): scrolled into view and marked.
 */
import type { Editor } from '@tiptap/core'
import { AlertCircle, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { bytes } from '../lib/format'
import { attachFiles, dismissRefusal, insertLink, pastedLink, useRefusals } from './editing'
import { useLimits } from './info'

/** "Anhängen": the files go where the cursor stands. */
export function AttachButton({ editor, noteId }: { editor: Editor; noteId: string }) {
  const { t } = useTranslation()
  const anyFile = useRef<HTMLInputElement>(null)
  const photo = useRef<HTMLInputElement>(null)
  const [sheet, setSheet] = useState(false)
  const [link, setLink] = useState(false)
  const take = (input: HTMLInputElement | null) => {
    const files = input?.files ? Array.from(input.files) : []
    if (input) input.value = ''
    setSheet(false)
    if (files.length) void attachFiles(editor, noteId, files)
  }
  return (
    <>
      <input ref={anyFile} type="file" multiple hidden onChange={(event) => take(event.currentTarget)} data-testid="attach-input" aria-label={t('attachments.attachLabel')} />
      <input ref={photo} type="file" multiple hidden accept="image/*,video/*" onChange={(event) => take(event.currentTarget)} data-testid="attach-photo-input" aria-label={t('attachments.sheet.photo')} />
      <button
        type="button"
        className="hidden h-[34px] items-center gap-1.5 rounded-lg bg-accent-wash px-3 text-[13px] font-semibold text-accent-400 md:flex"
        onClick={() => anyFile.current?.click()}
        data-testid="attach"
      >
        <Paperclip className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        {t('attachments.attach')}
      </button>
      <button type="button" className="grid h-11 w-11 place-items-center rounded-lg text-accent-400 md:hidden" aria-label={t('attachments.attach')} onClick={() => setSheet(true)} data-testid="attach-phone">
        <Paperclip className="h-5 w-5" strokeWidth={2.2} aria-hidden />
      </button>
      {sheet && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-scrim md:hidden" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && setSheet(false)}>
          <div role="dialog" aria-modal="true" aria-label={t('attachments.sheet.title')} className="grid grid-cols-3 gap-2 border-t border-ink-700 bg-ink-900 px-4 pt-3 pb-7" data-testid="attach-sheet">
            <button type="button" className="h-[52px] rounded-[12px] border border-ink-700 bg-ink-850 text-[13px]" onClick={() => photo.current?.click()} data-testid="attach-sheet-photo">
              {t('attachments.sheet.photo')}
            </button>
            <button type="button" className="h-[52px] rounded-[12px] border border-ink-700 bg-ink-850 text-[13px]" onClick={() => anyFile.current?.click()} data-testid="attach-sheet-file">
              {t('attachments.sheet.file')}
            </button>
            <button
              type="button"
              className="h-[52px] rounded-[12px] border border-ink-700 bg-ink-850 text-[13px]"
              onClick={() => {
                setSheet(false)
                setLink(true)
              }}
              data-testid="attach-sheet-link"
            >
              {t('attachments.sheet.link')}
            </button>
          </div>
        </div>
      )}
      {link && <LinkAttachDialog onClose={() => setLink(false)} onAdd={(href) => insertLink(editor, noteId, href)} />}
    </>
  )
}

function LinkAttachDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (href: string) => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <Dialog title={t('attachments.link.title')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const typed = value.trim()
          const href = pastedLink(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`)
          if (!href) return setInvalid(true)
          onAdd(href)
          onClose()
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm text-mist-300">
          {t('attachments.link.address')}
          <input className="nn-field" value={value} inputMode="url" placeholder="https://" onChange={(event) => { setValue(event.target.value); setInvalid(false) }} data-testid="attach-link-input" aria-invalid={invalid || undefined} />
        </label>
        {invalid && <p className="text-sm text-bad-500">{t('attachments.link.invalid')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent">
            {t('attachments.link.add')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** The area files may be dropped on, with the limit (AC-1); a drop on it puts them at the end of the note. */
export function DropHint({ editor, noteId }: { editor: Editor; noteId: string }) {
  const { t } = useTranslation()
  const limits = useLimits()
  return (
    <div
      className="flex min-h-16 items-center justify-center gap-2 rounded-[12px] border-[1.5px] border-dashed border-accent-500 bg-accent-wash px-4 py-3 text-center text-[13.5px] text-accent-400"
      data-testid="attach-drop"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer.files.length) void attachFiles(editor, noteId, event.dataTransfer.files, editor.state.doc.content.size)
      }}
    >
      {t('attachments.dropHint', { max: limits?.max_mb ?? 100 })}
    </div>
  )
}

/** Files that did not become attachments (AC-6, EC-1), each with why, to be put away. */
export function RefusalList({ noteId }: { noteId: string }) {
  const { t, i18n } = useTranslation()
  const refused = useRefusals(noteId)
  if (!refused.length) return null
  return (
    <div className="flex flex-col gap-2" data-testid="attach-refusals">
      {refused.map((refusal) => (
        <div key={refusal.key} role="alert" className="flex items-center gap-3 rounded-[12px] border border-ink-600 bg-bad-500/8 p-3" data-testid="attach-refused" data-reason={refusal.reason}>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-bad-500">
            <AlertCircle className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm text-mist-100">
              {refusal.name} · {bytes(refusal.size, i18n.language)}
            </span>
            <span className="text-[12.5px] text-bad-500">
              {refusal.reason === 'too_large'
                ? t('attachments.refused.tooLarge', { max: refusal.maxMb })
                : t('attachments.refused.full', { used: bytes(refusal.used ?? 0, i18n.language), limit: bytes(refusal.limit ?? 0, i18n.language) })}
            </span>
          </span>
          <button type="button" className="nn-btn nn-btn-quiet h-9 shrink-0 px-3 text-[13px]" onClick={() => dismissRefusal(noteId, refusal.key)} data-testid="attach-refused-hide">
            <X className="h-3.5 w-3.5 md:hidden" aria-hidden />
            <span className="hidden md:inline">{t('attachments.refused.hide')}</span>
            <span className="sr-only md:hidden">{t('attachments.refused.hide')}</span>
          </button>
        </div>
      ))}
    </div>
  )
}
