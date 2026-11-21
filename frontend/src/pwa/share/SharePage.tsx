/**
 * "Save to nexnotes" (NOTES-23 AC-5, drawing "Handy-Teilen-Android"): what another app shared on Android, with a
 * preview, the suggested title (a must), the folder (the inbox unless chosen) and the member's own words. "Save" makes
 * the note through the API like every other way (`POST /api/notes` from Markdown, then each file through
 * `POST /api/attachments`, checked there like every upload). Both use ids made here, so "Save" again after a broken
 * connection gives the same note and the same files (EC-3): nothing is lost, the form stays until it worked. A file
 * over the limit is refused with a message before anything is sent (EC-4).
 *
 * The page signs in by itself: without a session it goes to the sign-in and comes back here; what was shared waits in
 * this page and in the service worker meanwhile (`take.ts`).
 */
import { FileText, Link2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { newAttachmentId, sendFile } from '../../attachments/api'
import { isPicture } from '../../attachments/editing'
import { loadLimits } from '../../attachments/info'
import { flatten, refreshFolders, useFolders } from '../../folders/store'
import { bytes } from '../../lib/format'
import { problemText } from '../../lib/errors'
import { useTitle } from '../../lib/title'
import { notesApi, notesChanged } from '../../notes/api'
import { newNoteId, noteHref } from '../../notes/newNote'
import { cleanTitle, MAX_TITLE } from '../../editor/title'
import { unreachable, useAuth } from '../../state/auth'
import { hostOf, shareMarkdown, shareOrigin, splitShared, suggestShareTitle, type Shared } from './compose'
import { doneShared, takeShared } from './take'

const MB = 1024 * 1024

/** No connection: the request never reached the server, or a proxy says it is down. */
function offline(error: unknown): boolean {
  return unreachable(error) || (error instanceof ApiError && (error.status === 0 || error.code === 'network'))
}

type Phase = 'taking' | 'ready' | 'gone'

export function SharePage() {
  const { t, i18n } = useTranslation()
  const { status, ended } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const id = new URLSearchParams(location.search).get('shared') ?? ''
  const [phase, setPhase] = useState<Phase>('taking')
  const [shared, setShared] = useState<Shared | null>(null)
  useTitle(t('pwa.share.title'))

  // Taken at once, signed in or not: it waits in this page while the sign-in runs.
  useEffect(() => {
    let alive = true
    void takeShared(id).then((found) => {
      if (!alive) return
      setShared(found)
      setPhase(found ? 'ready' : 'gone')
    })
    return () => {
      alive = false
    }
  }, [id])

  if (status === 'loading' || phase === 'taking') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut')
    return <Navigate to={`/login?${ended ? 'ended=1&' : ''}next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (phase === 'gone' || !shared)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center" data-testid="share-gone">
        <p className="max-w-sm text-[15px] leading-relaxed text-mist-300">{t('pwa.share.lost')}</p>
        <Link to="/" className="nn-btn nn-btn-ghost min-h-11">
          {t('pwa.share.toApp')}
        </Link>
      </main>
    )
  return <ShareForm id={id} shared={shared} offlineNow={status === 'offline'} lang={i18n.language} onDone={(path) => navigate(path, { replace: true })} />
}

function ShareForm({ id, shared, offlineNow, lang, onDone }: { id: string; shared: Shared; offlineNow: boolean; lang: string; onDone: (path: string) => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const { link, text } = useMemo(() => splitShared(shared), [shared])
  const suggestion = useMemo(() => suggestShareTitle(shared, link, text), [shared, link, text])
  const [title, setTitle] = useState(suggestion)
  const [folder, setFolder] = useState<string>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [problem, setProblem] = useState('')
  const [noNetwork, setNoNetwork] = useState(false)
  const [maxMb, setMaxMb] = useState<number | null>(null)
  // Ids made once for this page: "Save" again is the same note and the same files (NOTES-3 EC-9, NOTES-10).
  const noteId = useRef(newNoteId()).current
  const files = useMemo(() => shared.files.map((file) => ({ file, id: newAttachmentId(), picture: isPicture(file) })), [shared])
  const sent = useRef(new Set<string>())
  const made = useRef(false)

  const pictures = useMemo(() => files.filter((item) => item.picture).map((item) => ({ id: item.id, url: URL.createObjectURL(item.file) })), [files])
  useEffect(() => () => pictures.forEach((picture) => URL.revokeObjectURL(picture.url)), [pictures])

  useEffect(() => {
    if (offlineNow) return
    void loadLimits(true).then((limits) => setMaxMb(limits?.max_mb ?? null))
  }, [offlineNow])

  const inbox = tree.inbox?.id ?? ''
  const target = folder || inbox
  const tooLarge = maxMb === null ? [] : files.filter((item) => item.file.size > maxMb * MB)
  const keep = files.filter((item) => !tooLarge.includes(item))
  const cleaned = cleanTitle(title)
  // The server keeps 120 characters of a title (`notedoc`): the field takes no more and says so before it is full.
  const titleLength = Array.from(title).length
  const nearFull = titleLength >= MAX_TITLE - 20

  const save = async () => {
    if (!cleaned) {
      setProblem(t('pwa.share.titleMissing'))
      return
    }
    setBusy(true)
    setProblem('')
    setNoNetwork(false)
    try {
      const limits = await loadLimits(true)
      if (!limits) throw new ApiError(0, 'network')
      setMaxMb(limits.max_mb)
      const accepted = keep.filter((item) => item.file.size <= limits.max_mb * MB)
      if (accepted.length && limits.full) throw new ApiError(507, 'storage_limit_reached', { used: limits.used, limit: limits.limit })
      if (!made.current) {
        setStep(t('pwa.share.saving'))
        await notesApi.create({
          id: noteId,
          folder_id: target || undefined,
          title: cleaned,
          // A title nobody typed is a suggestion: the note gets "Titel prüfen" (NOTES-3 AC-10, NOTES-4 AC-7).
          title_suggested: cleaned === cleanTitle(suggestion),
          markdown: shareMarkdown({ link, text, note, files: accepted.map((item) => ({ id: item.id, name: item.file.name || 'file', picture: item.picture })) }),
          origin: shareOrigin(navigator.userAgent),
        })
        made.current = true
      }
      let done = 0
      for (const item of accepted) {
        done += 1
        if (sent.current.has(item.id)) continue
        setStep(t('pwa.share.uploading', { done, count: accepted.length }))
        await sendFile(noteId, item.id, item.file, item.file.name || 'file', () => undefined).done
        sent.current.add(item.id)
      }
      notesChanged()
      void refreshFolders()
      doneShared(id)
      onDone(noteHref(noteId, target || null))
    } catch (error) {
      if (offline(error)) setNoNetwork(true)
      else setProblem(problemText(error))
      setBusy(false)
      setStep('')
    }
  }

  const cancel = () => {
    doneShared(id)
    onDone('/')
  }

  const rows = flatten(tree, null)
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col" data-testid="share-page">
      <header className="flex items-center justify-between gap-2 px-4 pt-4 pb-2.5">
        <button type="button" onClick={cancel} className="min-h-11 px-1 text-base text-accent-400" data-testid="share-cancel">
          {t('common.cancel')}
        </button>
        <h1 className="text-base font-bold">{t('pwa.share.title')}</h1>
        <span className="w-16" aria-hidden />
      </header>
      <div className="flex flex-1 flex-col gap-4 px-4 py-2">
        {(offlineNow || noNetwork) && (
          <p role="alert" className="rounded-xl border border-warn-500/40 bg-warn-500/10 px-3.5 py-3 text-sm text-mist-100" data-testid="share-offline">
            {t('pwa.share.offline')}
          </p>
        )}
        <section className="nn-card overflow-hidden rounded-[14px]" aria-label={t('pwa.share.preview')} data-testid="share-preview">
          {pictures.length > 0 && (
            <div className="flex gap-1 overflow-x-auto bg-ink-800">
              {pictures.map((picture) => (
                <img key={picture.id} src={picture.url} alt="" className="h-32 w-auto shrink-0 object-cover" />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1 p-3">
            {link && (
              <span className="flex items-center gap-2 text-[15px] font-semibold break-all" data-testid="share-link">
                <Link2 aria-hidden className="h-4 w-4 shrink-0 text-mist-500" />
                {shared.title && shared.title !== link ? shared.title : hostOf(link) || link}
              </span>
            )}
            {link && <span className="text-[13px] text-mist-500 break-all">{hostOf(link)}</span>}
            {text && <p className="line-clamp-4 text-[14px] whitespace-pre-line text-mist-300" data-testid="share-text">{text}</p>}
            {files
              .filter((item) => !item.picture)
              .map((item) => (
                <span key={item.id} className="flex items-center gap-2 text-[14px]">
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-mist-500" />
                  <span className="min-w-0 truncate">{item.file.name}</span>
                  <span className="shrink-0 text-mist-500">{bytes(item.file.size, lang)}</span>
                </span>
              ))}
          </div>
        </section>
        {tooLarge.map((item) => (
          <p key={item.id} role="alert" className="text-sm text-warn-500" data-testid="share-too-large">
            {t('pwa.share.tooLarge', { name: item.file.name, max_mb: maxMb })}
          </p>
        ))}
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          <span className="flex items-baseline justify-between gap-3">
            <span>
              {t('pwa.share.titleLabel')} <span className="font-normal text-mist-500">{t('pwa.share.titleHint')}</span>
            </span>
            {nearFull && (
              <span id="share-title-count" aria-live="polite" className={'shrink-0 font-normal tabular-nums ' + (titleLength >= MAX_TITLE ? 'text-warn-500' : 'text-mist-500')} data-testid="share-title-count">
                {t('pwa.share.titleCount', { chars: titleLength, max: MAX_TITLE })}
              </span>
            )}
          </span>
          <input
            type="text"
            required
            value={title}
            maxLength={MAX_TITLE}
            aria-describedby={nearFull ? 'share-title-count' : undefined}
            onChange={(event) => setTitle(event.target.value)}
            className="nn-field min-h-12 text-base"
            data-testid="share-title"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          {t('pwa.share.folder')}
          <select value={target} onChange={(event) => setFolder(event.target.value)} className="nn-field min-h-12 text-base font-normal" data-testid="share-folder">
            {inbox && <option value={inbox}>{t('folders.inbox.name')}</option>}
            {rows.map(({ folder: row, depth }) => (
              <option key={row.id} value={row.id}>
                {'  '.repeat(Math.min(depth, 8)) + row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          <span>
            {t('pwa.share.note')} <span className="font-normal text-mist-500">{t('pwa.share.noteHint')}</span>
          </span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} className="nn-field min-h-[84px] py-3 text-[15px] font-normal" data-testid="share-note" />
        </label>
        {problem && (
          <p role="alert" className="text-sm text-bad-500" data-testid="share-problem">
            {problem}
          </p>
        )}
      </div>
      <div className="sticky bottom-0 bg-ink-950 px-4 pt-3 pb-7">
        {step && (
          <p className="pb-2 text-center text-[13px] text-mist-400" role="status">
            {step}
          </p>
        )}
        <button type="button" disabled={busy || !cleaned} onClick={() => void save()} className="nn-btn nn-btn-accent h-[52px] w-full rounded-[14px] text-base" data-testid="share-save">
          {t('pwa.share.save')}
        </button>
      </div>
    </main>
  )
}
