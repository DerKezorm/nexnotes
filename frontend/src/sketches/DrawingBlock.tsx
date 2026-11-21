/**
 * A sketch in a note (NOTES-18, drawing "N18-Skizze-Aufnahme"): the picture the iOS app drew of it, sharp, on light
 * paper in both themes, at its place in the text; under it "im Browser nur ansehen, zeichnen auf iPhone und iPad" and
 * "Als Bild laden" (AC-1). A click opens it large, to zoom and move (EC-5). Changed on the iPad, the block names new
 * files; the old picture stays until the new one is known, then the new one stands there without reloading (AC-2).
 * Moving and removing are those of every attachment (AC-6); nobody draws here.
 */
import { PenLine, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl, viewUrl, type AttachmentInfo } from '../attachments/api'
import type { BlockActions } from '../attachments/blocks'
import { loadNote, useAttachment } from '../attachments/info'
import { downloadFile } from '../attachments/open'
import { SketchViewer } from './SketchViewer'
import './sketches.css'

export function DrawingBlock({ noteId, id, name, actions }: { noteId: string; id: string | null; name: string | null; actions: BlockActions }) {
  const { t } = useTranslation()
  const { info, loaded } = useAttachment(noteId, id)
  const [shown, setShown] = useState<AttachmentInfo | null>(info ?? null)
  const [large, setLarge] = useState(false)

  useEffect(() => {
    if (info) setShown(info)
  }, [info])
  useEffect(() => {
    // A new picture from the iPad: the app uploads it before it names it, so it is there to be asked for now.
    if (id && loaded && !info && noteId) void loadNote(noteId)
  }, [id, loaded, info, noteId])

  const remove = actions.editable && actions.onRemove ? (
    <button type="button" onClick={actions.onRemove} aria-label={t('attachments.remove')} title={t('attachments.remove')} data-testid="attachment-remove" className="nn-attachment-remove absolute top-2 right-2 z-10 grid h-7 w-7 place-items-center rounded-full bg-ink-900/85 text-mist-300 hover:text-mist-100">
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  ) : null

  if (!shown) {
    return (
      <div className="nn-attachment relative flex items-center gap-3 rounded-[12px] border border-ink-700 bg-ink-850 p-3" data-attachment-id={id ?? ''} data-kind="missing" data-testid="sketch-missing">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-mist-500">
          <PenLine className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm text-mist-100">{name || t('sketches.drawing.title')}</span>
          <span className="text-[12.5px] text-mist-500">{loaded ? t('attachments.missing') : t('attachments.loading')}</span>
        </span>
        {remove}
      </div>
    )
  }
  // Sharp in the note: the picture itself, or the view of a large one (up to 2048 px, more than the text is wide).
  const source = shown.view ? viewUrl(shown.id) : fileUrl(shown.id)
  return (
    <figure className="nn-attachment nn-sketch relative m-0 flex flex-col gap-1.5" data-attachment-id={id ?? ''} data-kind="drawing" data-shown={shown.id} data-testid="sketch">
      <button type="button" className="nn-sketch-paper flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-[12px] p-2" onClick={() => setLarge(true)} aria-label={t('sketches.drawing.open', { name: shown.name })} data-testid="sketch-open">
        <img src={source} alt={t('sketches.drawing.alt', { name: shown.name })} className="block h-auto max-h-[70vh] max-w-full object-contain" loading="lazy" width={shown.width ?? undefined} height={shown.height ?? undefined} draggable={false} data-testid="sketch-image" />
      </button>
      <figcaption className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-mist-500">
        <span data-testid="sketch-caption">
          {t('sketches.drawing.title')} · {t('sketches.drawing.viewOnly')}
        </span>
        <button type="button" className="rounded px-0.5 text-accent-400 hover:underline" onClick={() => downloadFile(fileUrl(shown.id, true))} data-testid="sketch-download">
          {t('sketches.drawing.download')}
        </button>
      </figcaption>
      {remove}
      {large && <SketchViewer info={shown} onClose={() => setLarge(false)} />}
    </figure>
  )
}
