/**
 * One open note (NOTES-3, NOTES-12): title, the line under it (path, created, changed, by whom, saved), the toolbar,
 * the text, the others in the note, and what the connection says.
 *
 * - Everything is saved as it is typed; "gespeichert" once the room confirmed it, the number of waiting changes while
 *   the connection is away, and an orange bar (NOTES-12 AC-8). Closing the tab with changes waiting asks first (EC-4).
 * - The title is required: leaving inside nexnotes without one asks, with a suggestion from the first words (AC-9),
 *   by a link, an action of the app or the browser's back and forward buttons. A note left with neither title nor
 *   text goes (EC-4); one left otherwise without a title (a closed tab) gets the suggestion with "Titel prüfen"
 *   (AC-10).
 * - Deleting moves the note to the trash and offers "Rückgängig" for ten seconds (AC-6).
 * - Attachments (NOTES-10): "Anhängen" in the head, the area for dropped files, files refused for their size or a full
 *   storage, and the way from the gallery to one of them (`attachments/NoteParts.tsx`).
 * - Beside another note (NOTES-8) only the side used last guards the ways out of the page and names the browser tab;
 *   the other hands its guard to the page (`onGuard`), which asks it before closing that side. The connection comes
 *   from `tabs/live.ts`, which keeps it open while changes still wait and bridges two editors of the same note.
 */
import { Selection } from '@tiptap/pm/state'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Copy, Ellipsis, History, Trash2, Upload, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useFileDrag, useJumpToAttachment } from '../attachments/hooks'
import { AttachButton, DropHint, RefusalList } from '../attachments/NoteParts'
import { Dialog } from '../components/Dialog'
import { Menu } from '../components/Menu'
import { ExportDialog } from '../export'
import { showNotice } from '../folders/notice'
import { refreshFolders } from '../folders/store'
import { historyHref } from '../history/href'
import { RestoreWatch } from '../history/RestoreWatch'
import { problemText } from '../lib/errors'
import { pageTitle } from '../lib/title'
import { notesApi, notesChanged, type NoteHead } from '../notes/api'
import { setLeaveGuard, setOpenNote, setPopGuard, type LeaveGuard } from '../notes/context'
import { NoteColorRow, NotePinButton } from '../notes/list/EditorMarks'
import { noteHref } from '../notes/newNote'
import { useAuth } from '../state/auth'
import { acquireProvider, othersOpen, releaseProvider } from '../tabs/live'
import { noteTitle } from '../tabs/meta'
import './editor.css'
import { bodyIsEmpty, editorExtensions, editorProps, safeHref } from './extensions'
import { presenceFromAwareness, presenceUser, type Presence } from './presence'
import { PresenceBar } from './PresenceBar'
import type { LiveStatus, NoteProvider } from './provider'
import { cleanTitle, suggestTitle } from './title'
import { whenText } from './when'
import { TitleField, type TitleFieldHandle } from './TitleField'
import { Outline } from './Outline'
import { TableControls } from './TableControls'
import { TitleIcon } from './TitleIcon'
import { paperOf } from './paper'
import { PaperPicker } from './PaperPicker'
import { OUTLINE_FROM, useOutlineShown } from './outlineData'
import { TEXT_MAX, useTextWidth } from './textWidth'
import { Toolbar } from './Toolbar'

type Props = {
  noteId: string
  /** Just made: the cursor goes into the title (AC-1). */
  fresh?: boolean
  /** After deleting: where to go (the list by default). */
  onDeleted?: () => void
  /** The note on the side used last (the only one, without a second side): it guards leaving the page and names the
   * browser tab. True by default. */
  guarded?: boolean
  /** Hands the editor's guard to the page, to be asked before this side closes (NOTES-8). */
  onGuard?: (guard: LeaveGuard | null) => void
  /** More in the bar of a note that stopped (the way to the trash, closing the tab). */
  stoppedExtra?: (status: LiveStatus) => ReactNode
}

/** Leaving a note runs a moment later: React's strict mode unmounts and mounts again at once, which is no leaving. */
const leaving = new Map<string, ReturnType<typeof setTimeout>>()

export function NoteEditor(props: Props) {
  return <OneNote key={props.noteId} {...props} />
}

function OneNote(props: Props) {
  const { noteId } = props
  const [provider, setProvider] = useState<NoteProvider | null>(null)
  useEffect(() => {
    const made = acquireProvider(noteId)
    setProvider(made)
    return () => {
      releaseProvider(made)
      setProvider(null)
    }
  }, [noteId])
  if (!provider) return null
  return <LiveNote {...props} provider={provider} />
}

function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}

function LiveNote({ provider, noteId, fresh, onDeleted, guarded = true, onGuard, stoppedExtra }: Props & { provider: NoteProvider }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const here = useLocation().pathname
  const { me } = useAuth()
  const myId = me?.id ?? 0
  const myName = me?.display_name || me?.name || ''
  const [head, setHead] = useState<NoteHead | null>(null)
  const [problem, setProblem] = useState('')
  // The title the document has now (the same note on the other side, a parked connection): never "" for a moment,
  // which would ask for a title on leaving and show "Ohne Titel" in the tab (NOTES-8 EC-1).
  const [title, setTitle] = useState(() => provider.doc.getText('title').toString())
  const [askLeave, setAskLeave] = useState<null | (() => void)>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [textWidth] = useTextWidth()
  const [outlineShown] = useOutlineShown()
  // The free width of this note's side: the outline stands beside the text only where there is room (AC-15).
  const [paneWidth, setPaneWidth] = useState(0)
  const paneObserver = useRef<ResizeObserver | null>(null)
  const measurePane = useCallback((element: HTMLDivElement | null) => {
    paneObserver.current?.disconnect()
    paneObserver.current = null
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setPaneWidth(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    paneObserver.current = observer
  }, [])
  const titleField = useRef<TitleFieldHandle>(null)
  const sheet = useRef<HTMLElement>(null)
  const titleRef = useRef(title)
  const deleted = useRef(false)
  const titleAtSync = useRef<string | null>(null)
  const inset = useKeyboardInset()

  const live = useSyncExternalStore(
    (listener) => provider.subscribe(listener),
    () => `${provider.status}|${provider.pending}|${provider.synced}`,
  )
  const [status, pendingText] = live.split('|')
  const pending = Number(pendingText)

  const loadHead = useCallback(() => {
    notesApi
      .get(noteId)
      .then((found) => {
        setHead(found)
        setProblem('')
      })
      .catch((error) => setProblem(problemText(error)))
  }, [noteId])
  useEffect(loadHead, [loadHead])

  // Changes of others: the head follows ("geändert … von Anna", AC-9), a moment later.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(loadHead, 1500)
    }
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === provider) later()
    }
    provider.doc.on('update', onUpdate)
    return () => {
      provider.doc.off('update', onUpdate)
      if (timer) clearTimeout(timer)
    }
  }, [provider, loadHead])

  // What is no change of the text (the paper, AC-17) comes with the head: read again every 5 s while the page is seen.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadHead()
    }, 5000)
    return () => clearInterval(timer)
  }, [loadHead])

  // Own changes confirmed: the head says "geändert gerade eben".
  useEffect(() => {
    if (status !== 'online' || pending > 0) return
    const timer = setTimeout(loadHead, 1000)
    return () => clearTimeout(timer)
  }, [status, pending, loadHead])

  const presenceInfo = useSyncExternalStore(
    (listener) => {
      provider.awareness.on('change', listener)
      return () => provider.awareness.off('change', listener)
    },
    () => JSON.stringify(presenceFromAwareness(provider.awareness, myId)),
  )
  const presence = JSON.parse(presenceInfo) as Presence

  const stopped = ['gone', 'forbidden', 'tooLarge', 'broken'].includes(status)
  const editable = !stopped && (head?.can_write ?? true)

  const extensions = useMemo(
    () =>
      editorExtensions({
        doc: provider.doc,
        provider,
        me: presenceUser(myId, myName, me?.avatar ?? null),
        t,
        placeholder: t('editor.placeholder'),
        hooks: { onLink: () => setLinkOpen(true) },
        noteId,
      }),
    // The editor is made once per note; the language of its few words follows on the next note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  )
  const editor = useEditor({ extensions, editorProps: { ...editorProps, attributes: { 'aria-label': t('editor.textLabel'), class: 'nn-prose', 'data-testid': 'note-body' } } }, [extensions])

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  const canAttach = editable && Boolean(head?.can_write)
  const dragging = useFileDrag(sheet, canAttach)
  useJumpToAttachment(Boolean(editor) && provider.synced)

  useEffect(() => {
    if (provider.synced && titleAtSync.current === null) titleAtSync.current = provider.doc.getText('title').toString()
  }, [live, provider])

  const shownTitle = cleanTitle(title)
  useEffect(() => {
    if (guarded) document.title = pageTitle(shownTitle || t('notes.untitled'))
  }, [guarded, shownTitle, t])
  // The tab shows the title as it is typed.
  useEffect(() => {
    if (provider.synced) noteTitle(noteId, shownTitle)
  }, [noteId, shownTitle, provider.synced])

  const onTitle = useCallback((value: string) => {
    titleRef.current = value
    setTitle(value)
  }, [])

  // --- leaving --------------------------------------------------------------------------------------------------

  const needsTitle = useCallback(() => !deleted.current && !cleanTitle(titleRef.current) && !bodyIsEmpty(editor), [editor])

  const guard = useCallback<LeaveGuard>(
    (proceed) => {
      if (!needsTitle()) return false
      setAskLeave(() => proceed)
      return true
    },
    [needsTitle],
  )

  useEffect(() => {
    if (!onGuard) return
    onGuard(guard)
    return () => onGuard(null)
  }, [onGuard, guard])

  // "New note" asks the open note whether it is still quite empty and where it lies.
  const headFolder = head?.folder_id ?? ''
  useEffect(() => {
    if (!guarded || !headFolder) return
    setOpenNote({
      noteId,
      folderId: headFolder,
      isBlank: () => !cleanTitle(titleRef.current) && Boolean(editor && bodyIsEmpty(editor)),
      focusTitle: () => titleField.current?.focus(),
    })
    return () => setOpenNote(null)
  }, [guarded, headFolder, noteId, editor])

  // Leaving the note: the editor goes (another note, a tab closed, the page left).
  useEffect(() => {
    const pendingLeave = leaving.get(noteId)
    if (pendingLeave) {
      clearTimeout(pendingLeave)
      leaving.delete(noteId)
    }
    return () => {
      const emptyTitle = !cleanTitle(titleRef.current)
      const emptyBody = bodyIsEmpty(editor)
      // The same note still open on the other side: it is not left.
      if (deleted.current || !emptyTitle || !provider.synced || othersOpen(provider) > 0) return
      leaving.set(
        noteId,
        setTimeout(() => {
          leaving.delete(noteId)
          // Neither title nor text: nothing stays (EC-4). Text without a title: the suggestion, to be checked (AC-10).
          const done = emptyBody ? notesApi.discard(noteId) : notesApi.suggestTitle(noteId)
          void done
            .then(() => {
              notesChanged()
              void refreshFolders()
            })
            .catch(() => undefined)
        }, 50),
      )
    }
  }, [noteId, editor, provider])

  // The ways out of the page ask the note on the side used last.
  useEffect(() => {
    if (!guarded) return
    setLeaveGuard(guard)
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || editor?.view.dom.contains(anchor)) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname === here) return
      if (!needsTitle()) return
      event.preventDefault()
      event.stopPropagation()
      setAskLeave(() => () => navigate(url.pathname + url.search + url.hash))
    }
    document.addEventListener('click', onClick, true)
    // The browser's back and forward buttons ask too (`setPopGuard`): the step is taken back before the router sees
    // it, and only "Vorschlag übernehmen" makes the step the browser was asked for.
    const entry = window.history.state as { idx?: number } | null
    let returning = false
    setPopGuard((event) => {
      if (!event.isTrusted) return false // goTo() of the app's own actions, which asked before
      if (returning) {
        returning = false
        return true
      }
      if (!needsTitle()) return false
      const target = (event.state as { idx?: number } | null)?.idx
      const delta = typeof target === 'number' && typeof entry?.idx === 'number' ? target - entry.idx : -1
      if (delta === 0) return false
      returning = true
      window.history.go(-delta)
      setAskLeave(() => () => window.history.go(delta))
      return true
    })
    return () => {
      setLeaveGuard(null)
      document.removeEventListener('click', onClick, true)
      setPopGuard(null)
    }
  }, [guarded, guard, editor, needsTitle, navigate, here])

  // Closing the tab while changes wait: the browser asks (NOTES-12 EC-4).
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (provider.pending > 0) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [provider])

  // The list shows the new title soon after it was typed.
  useEffect(() => {
    const timer = setTimeout(notesChanged, 2500)
    return () => clearTimeout(timer)
  }, [title])

  // --- actions --------------------------------------------------------------------------------------------------

  const remove = async () => {
    setMenuOpen(false)
    try {
      deleted.current = true
      await notesApi.remove(noteId)
      notesChanged()
      void refreshFolders()
      showNotice({
        text: t('notes.deleted'),
        undo: async () => {
          await notesApi.restore(noteId)
          notesChanged()
          void refreshFolders()
          navigate(noteHref(noteId))
        },
      })
      if (onDeleted) onDeleted()
      else navigate('/')
    } catch (error) {
      deleted.current = false
      setProblem(problemText(error))
    }
  }

  const duplicate = async () => {
    setMenuOpen(false)
    try {
      const copy = await notesApi.duplicate(noteId)
      notesChanged()
      void refreshFolders()
      navigate(noteHref(copy.id))
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  const titleOk = async () => {
    setMenuOpen(false)
    try {
      setHead(await notesApi.titleOk(noteId))
      notesChanged()
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  const restore = async () => {
    try {
      await notesApi.restore(noteId)
      notesChanged()
      void refreshFolders()
      loadHead()
      provider.retryNow()
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  // --- what it says ---------------------------------------------------------------------------------------------

  const lang = i18n.language
  const titleCheck = Boolean(head?.title_check) && (titleAtSync.current === null || cleanTitle(title) === cleanTitle(titleAtSync.current))
  const path = head?.path.map((step) => (step.inbox ? t('notes.inbox') : step.name)).join(' › ') ?? ''
  const changedBy = head?.updated_by && head.updated_by.id !== myId ? head.updated_by.name : ''
  let saved: { text: string; tone: string }
  if (stopped) saved = { text: '', tone: '' }
  else if (pending > 0 && status !== 'online') saved = { text: t('editor.waiting', { count: pending }), tone: 'text-warn-500' }
  else if (pending > 0) saved = { text: t('editor.saving'), tone: 'text-mist-500' }
  else if (status === 'online') saved = { text: t('editor.saved'), tone: 'text-ok-500' }
  else saved = { text: t('editor.connecting'), tone: 'text-mist-500' }

  const suggestion = suggestTitle(editor?.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n') ?? '') || t('editor.leave.fallback', { date: new Date().toLocaleDateString(lang) })

  return (
    <div className="flex min-h-full flex-col" data-testid="note-editor" data-status={status}>
      <RestoreWatch noteId={noteId} doc={provider.doc} origin={provider} />
      {status === 'offline' && (
        <div role="status" data-testid="offline-bar" className="flex items-center gap-2.5 px-5 py-2.5 text-[13.5px] font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }}>
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          {t('editor.offline')}
        </div>
      )}
      {stopped && (
        <div role="alert" data-testid="stopped-bar" className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-[13.5px] font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }}>
          <span>{t(`editor.stopped.${status}`)}</span>
          {stoppedExtra?.(status as LiveStatus)}
          {status === 'gone' && head?.can_write && (
            <button type="button" className="nn-btn nn-btn-ghost h-8 px-3" onClick={() => void restore()}>
              {t('editor.restore')}
            </button>
          )}
        </div>
      )}
      {/* One row: the toolbar takes what is left and puts the rest into "More"; the others and the note's buttons are
          never cut off (NOTES-12 AC-5). */}
      <div className="@container flex items-center gap-3 border-b border-ink-700 px-4 py-2 md:px-5" data-testid="editor-head">
        <div className="hidden min-w-0 flex-1 md:block">{editor && <Toolbar editor={editor} onLink={() => setLinkOpen(true)} />}</div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {editor && canAttach && <AttachButton editor={editor} noteId={noteId} />}
          <PresenceBar presence={presence} />
          <NotePinButton noteId={noteId} head={head} disabled={!head?.can_write} />
          <span className="relative">
            <button
              type="button"
              className="nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0"
              aria-label={t('editor.more')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="note-menu"
              ref={menuButton}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Ellipsis className="h-4 w-4" aria-hidden />
            </button>
            {menuOpen && (
              <Menu anchor={menuButton.current!} onClose={() => setMenuOpen(false)} label={t('editor.more')} testId="note-menu-panel">
                {titleCheck && (
                  <button type="button" role="menuitem" className="nn-menu-item" onClick={() => void titleOk()}>
                    {t('notes.titleOk')}
                  </button>
                )}
                <button type="button" role="menuitem" className="nn-menu-item" data-testid="note-duplicate" onClick={() => void duplicate()}>
                  <Copy className="h-4 w-4" aria-hidden />
                  {t('editor.duplicate')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="nn-menu-item"
                  data-testid="note-export"
                  onClick={() => {
                    setMenuOpen(false)
                    setExportOpen(true)
                  }}
                >
                  <Upload className="h-4 w-4" aria-hidden />
                  {t('export.menu')}
                </button>
                <Link to={historyHref(noteId)} role="menuitem" className="nn-menu-item" data-testid="note-history" onClick={() => setMenuOpen(false)}>
                  <History className="h-4 w-4" aria-hidden />
                  {t('history.menu')}
                </Link>
                <button type="button" role="menuitem" className="nn-menu-item text-bad-500" data-testid="note-delete" onClick={() => void remove()} disabled={!head?.can_write}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('editor.delete')}
                </button>
                {head?.can_write && <NoteColorRow noteId={noteId} head={head} onDone={() => setMenuOpen(false)} />}
                {head?.can_write && (
                  <div className="border-t border-ink-700 px-2 pt-2 pb-1">
                    <p className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.paper.label')}</p>
                    <PaperPicker
                      value={paperOf(head.paper)}
                      role="menuitemradio"
                      onChange={(paper) => {
                        setMenuOpen(false)
                        setHead({ ...head, paper })
                        notesApi.setPaper(noteId, paper).then(setHead, (error) => setProblem(problemText(error)))
                      }}
                    />
                  </div>
                )}
              </Menu>
            )}
          </span>
        </div>
      </div>

      {/* The sheet: the note's own surface on the page (white on nex gray in light, a step lighter in dark), as wide as
          the text width says; a paper pattern is its background. */}
      <div ref={measurePane} className="flex min-h-0 w-full flex-1 items-start md:gap-6 md:px-6 md:pt-5 md:pb-8">
      <article
        ref={sheet}
        className="nn-sheet relative mx-auto flex w-full min-w-0 flex-1 flex-col gap-3 self-stretch bg-ink-850 px-5 pt-6 pb-28 md:rounded-[14px] md:border md:border-ink-700 md:px-10 md:pb-10 md:shadow-[0_1px_3px_rgb(0_0_0/0.08),0_8px_24px_-12px_rgb(0_0_0/0.18)]"
        style={{ maxWidth: TEXT_MAX[textWidth] ?? 'none' }}
        data-testid="note-page"
        data-width={textWidth}
      >
        <div className="group flex items-center gap-1.5">
        {head && (
          <TitleIcon
            icon={head.icon ?? ''}
            color={head.color ?? ''}
            editable={Boolean(head.can_write) && editable}
            onChange={(icon) => {
              setHead({ ...head, icon })
              notesApi.setIcon(noteId, icon).then(setHead, (error) => setProblem(problemText(error)))
              notesChanged()
            }}
          />
        )}
        <TitleField
          ref={titleField}
          doc={provider.doc}
          editable={editable}
          autoFocus={fresh}
          onValue={onTitle}
          invalid={askLeave !== null}
          describedBy={askLeave ? 'nn-title-required' : undefined}
          onEnter={() => focusTextStart(editor)}
        />
        </div>
        {askLeave && (
          <span id="nn-title-required" className="-mt-1 text-[13px] font-medium text-bad-500">
            {t('editor.titleRequired')}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-mist-500" data-testid="note-meta">
          {path && <span>{path}</span>}
          {head && (
            <>
              {path && <span aria-hidden>·</span>}
              <span>{t('editor.meta.created', { date: new Date(head.created_at).toLocaleDateString(lang) })}</span>
              <span aria-hidden>·</span>
              <span data-testid="note-changed">
                {changedBy
                  ? t('editor.meta.changedBy', { when: whenText(head.updated_at, lang, t), name: changedBy })
                  : t('editor.meta.changed', { when: whenText(head.updated_at, lang, t) })}
              </span>
            </>
          )}
          {saved.text && (
            <>
              <span aria-hidden>·</span>
              <span className={saved.tone} data-testid="note-saved" aria-live="polite">
                {saved.text}
              </span>
            </>
          )}
          {titleCheck && (
            <>
              <span aria-hidden>·</span>
              <span className="rounded-md bg-accent-wash px-1.5 py-0.5 text-accent-400" data-testid="title-check">
                {t('notes.titleCheck')}
              </span>
              <button type="button" className="nn-btn nn-btn-quiet text-[12.5px]" onClick={() => void titleOk()} data-testid="title-ok">
                {t('notes.titleOk')}
              </button>
            </>
          )}
        </div>
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
        <div className="nn-paper mt-1 flex flex-1 flex-col" data-paper={paperOf(head?.paper)} data-testid="note-paper">
          <EditorContent editor={editor} className="nn-editor flex-1" />
        </div>
        {editor && dragging && <DropHint editor={editor} noteId={noteId} />}
        <RefusalList noteId={noteId} />
        {editor && <TableControls editor={editor} frame={sheet} />}
      </article>
      {editor && outlineShown && paneWidth >= OUTLINE_FROM && (
        <Outline
          editor={editor}
          info={[
            ...(path ? [{ label: t('editor.outline.folder'), text: path }] : []),
            ...(head
              ? [
                  { label: t('editor.outline.created'), text: new Date(head.created_at).toLocaleString(lang) },
                  { label: t('editor.outline.changed'), text: changedBy ? `${new Date(head.updated_at).toLocaleString(lang)} · ${changedBy}` : new Date(head.updated_at).toLocaleString(lang) },
                ]
              : []),
          ]}
        />
      )}
      </div>

      {editor && (
        <div className="fixed inset-x-0 z-30 md:hidden" style={{ bottom: inset }}>
          <Toolbar editor={editor} onLink={() => setLinkOpen(true)} compact />
        </div>
      )}

      {linkOpen && editor && <LinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
      {exportOpen && head && (
        <ExportDialog
          note={{ id: noteId, title: head.title }}
          // The note's own folder, when it is one of the member's (a shared note's folder is not theirs to export).
          folder={head.owner?.id === me?.id && head.path.length ? exportFolder(head.path[head.path.length - 1]) : undefined}
          onClose={() => setExportOpen(false)}
        />
      )}
      {askLeave && (
        <LeaveDialog
          suggestion={suggestion}
          onTake={async () => {
            const proceed = askLeave
            try {
              // Seen and taken: a title like a typed one, no "Titel prüfen".
              await notesApi.suggestTitle(noteId, suggestion, true)
              titleRef.current = suggestion
              notesChanged()
              setAskLeave(null)
              proceed()
            } catch (error) {
              setProblem(problemText(error))
              setAskLeave(null)
            }
          }}
          onType={() => {
            setAskLeave(null)
            requestAnimationFrame(() => titleField.current?.focus())
          }}
        />
      )}
    </div>
  )
}

/** Enter in the title: the cursor at the start of the text, focus and selection in the same tick (AC-1). Tiptap's
 * `focus()` waits for the next frame, and a key typed at once would still land in the title. */
function focusTextStart(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return
  const { view } = editor
  view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).scrollIntoView())
  view.focus()
}

function LeaveDialog({ suggestion, onTake, onType }: { suggestion: string; onTake: () => void; onType: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog title={t('editor.leave.title')} onClose={onType}>
      <div className="flex flex-col gap-3.5" data-testid="leave-dialog">
        <p className="text-sm leading-relaxed text-mist-400">{t('editor.leave.text')}</p>
        <div className="flex flex-col gap-1 rounded-[10px] border border-ink-700 bg-ink-900 px-3.5 py-3">
          <span className="text-xs text-mist-500">{t('editor.leave.suggestion')}</span>
          <span className="text-[15px] font-semibold text-mist-100" data-testid="leave-suggestion">
            {suggestion}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onTake} data-testid="leave-take">
            {t('editor.leave.take')}
          </button>
          <button type="button" className="nn-btn nn-btn-accent" onClick={onType} data-testid="leave-type">
            {t('editor.leave.type')}
          </button>
        </div>
        <p className="text-[12.5px] text-mist-500">{t('editor.leave.hint')}</p>
      </div>
    </Dialog>
  )
}

/** A link on the selection, or a new one with the address as its text; only http, https and mailto (EC-8). */
export function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { t } = useTranslation()
  const [href, setHref] = useState<string>(() => (editor.getAttributes('link').href as string | undefined) ?? '')
  const [invalid, setInvalid] = useState(false)
  const save = () => {
    const value = href.trim()
    if (!value) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      onClose()
      return
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
    const safe = safeHref(withScheme)
    if (!safe) {
      setInvalid(true)
      return
    }
    const { empty } = editor.state.selection
    if (empty && !editor.isActive('link')) editor.chain().focus().insertContent({ type: 'text', text: safe, marks: [{ type: 'link', attrs: { href: safe } }] }).run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: safe }).run()
    onClose()
  }
  return (
    <Dialog title={t('editor.link.title')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm text-mist-300">
          {t('editor.link.address')}
          <input
            className="nn-field"
            value={href}
            onChange={(event) => {
              setHref(event.target.value)
              setInvalid(false)
            }}
            placeholder="https://"
            inputMode="url"
            aria-invalid={invalid || undefined}
            data-testid="link-input"
          />
        </label>
        {invalid && <p className="text-sm text-bad-500">{t('editor.link.invalid')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent">
            {t('editor.link.save')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function exportFolder(step: { id: string; name: string; inbox: boolean }) {
  return { id: step.id, name: step.name, inbox: step.inbox }
}
