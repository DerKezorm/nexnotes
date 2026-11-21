/**
 * "Anhänge" (NOTES-10 AC-7, drawing "N10-Galerie"): every attachment of the account's notes as a gallery with kind,
 * name, note and size; chips by kind with their numbers, newest or largest first, and a click leads into the note at
 * the attachment. An empty account says how to attach (EC-9). The order and kind stand in the address
 * (`?kind=pdf&sort=largest`), so "Große Anhänge ansehen" of a full storage (AC-11) leads straight to the largest.
 */
import { File as FileIcon, FileText, Image as ImageIcon, Mic, Paperclip, PenLine, ScanText, Video, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { bytes } from '../lib/format'
import { pageTitle } from '../lib/title'
import { altClickOpens } from '../tabs/links'
import { attachmentsApi, GALLERY_KINDS, thumbUrl, type Gallery, type GalleryItem, type GalleryKind, type GallerySort } from './api'

/** Entries read at a time; the next ones when the end of the list comes into view. */
export const PAGE = 120

const ICONS: Record<GalleryKind, LucideIcon> = { image: ImageIcon, scan: ScanText, pdf: FileText, recording: Mic, drawing: PenLine, video: Video, file: FileIcon }

export function GalleryPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const kind = (GALLERY_KINDS as string[]).includes(params.get('kind') ?? '') ? (params.get('kind') as GalleryKind) : undefined
  const sort: GallerySort = params.get('sort') === 'largest' ? 'largest' : 'newest'
  const [found, setFound] = useState<Gallery | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const asked = useRef(0)

  useEffect(() => {
    document.title = pageTitle(t('attachments.gallery.title'))
  }, [t])

  useEffect(() => {
    const ask = ++asked.current
    setBusy(true)
    attachmentsApi
      .gallery({ kind, sort, offset: 0, limit: PAGE })
      .then((answer) => {
        if (ask !== asked.current) return
        setFound(answer)
        setFailed(false)
      })
      .catch(() => ask === asked.current && setFailed(true))
      .finally(() => ask === asked.current && setBusy(false))
  }, [kind, sort])

  const more = useCallback(() => {
    if (!found || busy || found.items.length >= found.total) return
    const ask = asked.current
    setBusy(true)
    attachmentsApi
      .gallery({ kind, sort, offset: found.items.length, limit: PAGE })
      .then((answer) => {
        if (ask !== asked.current) return
        setFound({ ...answer, items: [...found.items, ...answer.items] })
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }, [found, busy, kind, sort])

  useEffect(() => {
    const element = end.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && more(), { rootMargin: '400px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [more])

  const choose = (next: { kind?: GalleryKind | null; sort?: GallerySort }) => {
    const query = new URLSearchParams(params)
    if (next.kind !== undefined) {
      if (next.kind) query.set('kind', next.kind)
      else query.delete('kind')
    }
    if (next.sort) {
      if (next.sort === 'largest') query.set('sort', 'largest')
      else query.delete('sort')
    }
    setParams(query, { replace: true })
  }

  const lang = i18n.language
  const chips: Array<{ key: GalleryKind | null; label: string; count: number }> = [
    { key: null, label: t('attachments.gallery.all'), count: found?.all ?? 0 },
    ...GALLERY_KINDS.map((each) => ({ key: each, label: t(`attachments.gallery.filter.${each}`), count: found?.counts[each] ?? 0 })),
  ]
  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-8 md:py-6" data-testid="gallery">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-mist-100">{t('attachments.gallery.title')}</h1>
        {found && (
          <span className="text-[13px] text-mist-500" data-testid="gallery-summary">
            {t('attachments.gallery.summary', { count: found.all, size: bytes(found.bytes, lang) })}
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-mist-400">
          <span className="sr-only">{t('attachments.gallery.sort.label')}</span>
          <select className="nn-field h-9 py-0 text-[13px]" value={sort} onChange={(event) => choose({ sort: event.target.value as GallerySort })} data-testid="gallery-sort">
            <option value="newest">{t('attachments.gallery.sort.newest')}</option>
            <option value="largest">{t('attachments.gallery.sort.largest')}</option>
          </select>
        </label>
      </div>
      {found && found.all > 0 && (
        <div role="radiogroup" aria-label={t('attachments.gallery.kinds')} className="flex flex-wrap gap-2" data-testid="gallery-kinds">
          {chips.map((chip) => {
            const chosen = (chip.key ?? undefined) === kind
            return (
              <button
                key={chip.key ?? 'all'}
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => choose({ kind: chip.key })}
                data-testid={`gallery-kind-${chip.key ?? 'all'}`}
                className={'flex h-[34px] items-center gap-1.5 rounded-full border px-3 text-[13px] ' + (chosen ? 'border-accent-500 bg-accent-wash text-accent-400' : 'border-ink-600 text-mist-100 hover:bg-ink-800')}
              >
                {chip.label}
                <span className="text-mist-500">{chip.count}</span>
              </button>
            )
          })}
        </div>
      )}
      {failed && <p className="text-sm text-bad-500">{t('attachments.gallery.failed')}</p>}
      {found && found.all === 0 && (
        <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 text-center" data-testid="gallery-empty">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-ink-800 text-mist-400">
            <Paperclip className="h-6 w-6" aria-hidden />
          </span>
          <h2 className="text-lg font-semibold text-mist-100">{t('attachments.gallery.emptyTitle')}</h2>
          <p className="text-sm leading-relaxed text-mist-400">{t('attachments.gallery.emptyText')}</p>
        </div>
      )}
      {found && found.all > 0 && found.total === 0 && <p className="text-sm text-mist-500">{t('attachments.gallery.noneOfKind')}</p>}
      {found && found.items.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 md:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" data-testid="gallery-items">
          {found.items.map((item) => (
            <li key={item.id}>
              <Tile
                item={item}
                onOpen={(event) => {
                  const path = `/notes/${encodeURIComponent(item.note.id)}?attachment=${encodeURIComponent(item.id)}`
                  // Alt-click (⌥-click): the note in a new tab while one is open (NOTES-8 AC-3).
                  if (!altClickOpens(event, item.note.id, path)) navigate(path)
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {found && found.items.length < found.total && (
        <div ref={end} className="flex justify-center py-4">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={more} disabled={busy} data-testid="gallery-more">
            {t('attachments.gallery.more')}
          </button>
        </div>
      )}
    </div>
  )
}

function Tile({ item, onOpen }: { item: GalleryItem; onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  const { t, i18n } = useTranslation()
  const kind = (GALLERY_KINDS as string[]).includes(item.kind) ? (item.kind as GalleryKind) : 'file'
  const Icon = ICONS[kind]
  const paper = kind === 'pdf' || kind === 'scan'
  const title = item.note.title || t('notes.untitled')
  return (
    <button type="button" onClick={onOpen} className="flex w-full flex-col overflow-hidden rounded-[12px] border border-ink-700 bg-ink-850 text-left hover:border-ink-600" data-testid="gallery-item" data-kind={kind}>
      <span className={'relative flex h-[120px] items-center justify-center overflow-hidden ' + (paper ? 'bg-white' : 'bg-ink-800')}>
        {item.thumb ? <img src={thumbUrl(item.id)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icon className={'h-7 w-7 ' + (paper ? 'text-ink-700' : 'text-mist-500')} aria-hidden />}
        <span className="absolute top-2 left-2 rounded-md bg-ink-950/75 px-1.5 py-0.5 text-[11px] font-semibold text-mist-300">{t(`attachments.kind.${kind}`)}</span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
        <span className="truncate text-[13px] font-semibold text-mist-100">{item.name}</span>
        <span className="truncate text-xs text-mist-500">{t('attachments.gallery.inNote', { title, size: bytes(item.size, i18n.language) })}</span>
      </span>
    </button>
  )
}
