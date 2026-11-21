/**
 * The large view of a picture, a scan or a PDF with its recognised text (NOTES-11, drawing "N11-Text"): the picture or
 * the page on the left, "Erkannter Text" beside it with the language of the page, "Kopieren" and "In die Notiz
 * einfügen" (AC-3). Pages still being read say so (AC-7); a page without text says "Kein Text erkannt" (EC-2, EC-3).
 * Opened from a hit of the search it shows the page of the hit with the place marked (AC-8).
 *
 * The text is always text, never markup. While pages are still read the view asks again every few seconds.
 */
import { ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl, viewUrl, type AttachmentInfo } from '../attachments/api'
import { noteEditor } from '../attachments/large'
import { downloadFile } from '../attachments/open'
import { copyText } from '../lib/copy'
import type { Jump } from '../search/api'
import { ocrApi, pageUrl, stillReading, type AttachmentText, type PageText } from './api'
import { insertText } from './insert'
import { ASK_EVERY_MS, askAgainIn, marked } from './marks'
import type { Opening } from './store'

function useAttachmentText(id: string): AttachmentText | null {
  const [text, setText] = useState<AttachmentText | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let round = 0
    const ask = () => {
      ocrApi
        .text(id)
        .then((answer) => {
          if (!alive) return
          setText(answer)
          round = answer.state === 'device' ? round + 1 : 0
          if (stillReading(answer)) timer = setTimeout(ask, askAgainIn(answer.state, round - 1))
        })
        .catch(() => {
          if (alive) timer = setTimeout(ask, ASK_EVERY_MS * 3)
        })
    }
    ask()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [id])
  return text
}

export function Viewer({ opening, onClose }: { opening: Opening; onClose: () => void }) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<AttachmentInfo | null>(opening.info)
  const [page, setPage] = useState(opening.page || 1)
  const [showText, setShowText] = useState(opening.showText)
  const text = useAttachmentText(opening.id)
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (opening.info) return
    let alive = true
    ocrApi
      .attachment(opening.id)
      .then((found) => alive && setInfo(found))
      .catch(() => alive && onClose())
    return () => {
      alive = false
    }
  }, [opening.id, opening.info, onClose])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [onClose])

  const pages = Math.max(1, info?.kind === 'pdf' ? (info.pages ?? text?.pages ?? 1) : 1)
  const isPdf = info?.kind === 'pdf'
  const kind = info ? t(`attachments.kind.${info.kind}`, { defaultValue: info.kind }) : ''
  const picture = !info ? null : isPdf ? pageUrl(info.id, page) : info.view ? viewUrl(info.id) : fileUrl(info.id)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950 text-mist-100" role="dialog" aria-modal="true" aria-label={info?.name ?? t('ocr.title')} data-testid="ocr-viewer" contentEditable={false}>
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-5 py-3.5">
        <button ref={close} type="button" className="grid h-[38px] w-[38px] place-items-center rounded-[9px] text-mist-300 hover:bg-ink-800 hover:text-mist-100" onClick={onClose} aria-label={t('common.close')} data-testid="ocr-close">
          <X className="h-5 w-5" aria-hidden />
        </button>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold" data-testid="ocr-name">{info?.name ?? t('ocr.loading')}</span>
          <span className="text-[12.5px] text-mist-400" data-testid="ocr-where">
            {[kind, isPdf ? t('ocr.pageOf', { page, pages }) : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {isPdf && pages > 1 && (
            <span className="flex items-center gap-1">
              <button type="button" className="nn-btn nn-btn-ghost h-9 w-9 px-0" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('ocr.previous')} data-testid="ocr-previous">
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <button type="button" className="nn-btn nn-btn-ghost h-9 w-9 px-0" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label={t('ocr.next')} data-testid="ocr-next">
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </span>
          )}
          {info && (
            <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" onClick={() => downloadFile(fileUrl(info.id, true))}>
              <Download className="h-4 w-4" aria-hidden />
              {t('attachments.download')}
            </button>
          )}
          <button
            type="button"
            aria-pressed={showText}
            onClick={() => setShowText(!showText)}
            data-testid="ocr-show-text"
            className={'h-9 rounded-[9px] border px-3 text-[13px] ' + (showText ? 'border-accent-500 bg-accent-500/15 font-semibold text-accent-400' : 'border-ink-600 text-mist-100 hover:bg-ink-800')}
          >
            {showText ? t('ocr.hideText') : t('ocr.showText')}
          </button>
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-wrap overflow-auto">
        <div className="flex min-w-0 flex-[999_1_520px] items-center justify-center p-7">
          {picture && <img src={picture} alt={t('ocr.picture')} className="max-h-[calc(100vh-140px)] max-w-full rounded bg-white object-contain shadow-2xl" data-testid="ocr-picture" />}
        </div>
        {showText && (
          <TextPanel
            text={text}
            page={isPdf ? page : 1}
            mark={page === opening.page ? opening.mark : null}
            attachmentId={opening.id}
            noteId={opening.noteId}
          />
        )}
      </div>
    </div>
  )
}

function TextPanel({ text, page, mark, attachmentId, noteId }: { text: AttachmentText | null; page: number; mark: Jump | null; attachmentId: string; noteId: string }) {
  const { t } = useTranslation()
  const [done, setDone] = useState<'copied' | 'inserted' | null>(null)
  const markRef = useRef<HTMLDivElement>(null)
  const shown: PageText | undefined = text?.items.find((item) => item.page === page)
  const reading = stillReading(text)
  const pending = useMemo(
    () => (text?.items ?? []).filter((item) => item.state === 'pending' && item.page !== page).map((item) => item.page),
    [text, page],
  )
  const editor = noteEditor(noteId)
  const value = shown?.state === 'done' ? shown.text : ''

  useEffect(() => {
    setDone(null)
  }, [page])
  useEffect(() => {
    markRef.current?.querySelector('mark')?.scrollIntoView?.({ block: 'center' })
  }, [value, mark])

  let body: ReactNode
  if (!text) body = <p className="text-mist-400">{t('ocr.loading')}</p>
  else if (text.state === 'locked') body = <p className="text-mist-400" data-testid="ocr-locked">{t('ocr.locked')}</p>
  else if (value) body = marked(value, mark)
  else if (text.state === 'unavailable' && (!shown || shown.state === 'pending')) body = <p className="text-mist-400" data-testid="ocr-unavailable">{t('ocr.unavailable')}</p>
  else if ((!shown || shown.state === 'pending') && reading) body = <Reading text={t('ocr.pending')} />
  else body = <p className="text-mist-400" data-testid="ocr-none">{t('ocr.none')}</p>

  return (
    <aside aria-label={t('ocr.title')} className="flex min-w-[300px] flex-[0_1_400px] flex-col gap-3.5 border-l border-ink-800 bg-ink-900 p-5" data-testid="ocr-panel">
      <span className="flex items-center justify-between">
        <h2 className="m-0 text-base font-bold">{t('ocr.title')}</h2>
        {shown?.language ? (
          <span className="text-xs text-mist-400" data-testid="ocr-language">
            {t(`server.ocrLanguages.${shown.language}`, { defaultValue: shown.language })}
          </span>
        ) : null}
      </span>
      <div ref={markRef} className="min-h-[160px] flex-1 overflow-auto whitespace-pre-line rounded-[10px] border border-ink-700 bg-ink-850 p-3.5 text-sm leading-[1.7] text-mist-200 select-text" data-testid="ocr-text">
        {body}
      </div>
      {value && (
        <span className="flex gap-2">
          <button
            type="button"
            className="nn-btn nn-btn-ghost h-10 flex-1 text-[13.5px]"
            data-testid="ocr-copy"
            onClick={() => void copyText(value).then((ok) => ok && setDone('copied'))}
          >
            {done === 'copied' ? t('ocr.copied') : t('ocr.copy')}
          </button>
          {editor && editor.isEditable && (
            <button
              type="button"
              className="nn-btn nn-btn-accent h-10 flex-1 text-[13.5px]"
              data-testid="ocr-insert"
              onClick={() => {
                if (insertText(editor, attachmentId, value)) setDone('inserted')
              }}
            >
              {done === 'inserted' ? t('ocr.inserted') : t('ocr.insert')}
            </button>
          )}
        </span>
      )}
      {pending.length > 0 && text?.state !== 'unavailable' && (
        <div className="rounded-[10px] border border-ink-700 px-3 py-2.5 text-[12.5px] text-mist-400" data-testid="ocr-pending">
          <Reading text={t('ocr.pendingPages', { count: pending.length, pages: pending.join(', ') })} />
        </div>
      )}
    </aside>
  )
}

function Reading({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-2.5 text-mist-400" data-testid="ocr-reading">
      <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-400" />
      {text}
    </span>
  )
}
