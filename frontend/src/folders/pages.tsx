/**
 * The pages of the folders (NOTES-4): a folder with its path at the top (every step a link, AC-13) and its notes below,
 * or the empty state of NOTES-6 EC-1 (EC-5); the inbox with where each note came from (AC-7), "File" (AC-14) and its
 * own empty state (EC-6); and on the phone the list of all folders (drawing "Handy-Ordner").
 */
import { ChevronDown, ChevronRight, FileText, Inbox, LayoutGrid, Mic, MoreHorizontal, NotebookText, PenLine, Plug, Plus, Share2, StickyNote, Users, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'

import { LogoMark } from '../components/Logo'
import { NoteIcon } from '../components/NoteIcon'
import { notesApi } from '../notes/api'
import { NoteList } from '../notes/NoteList'
import { ago } from '../lib/time'
import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { PhoneBack, PhoneNewNote } from '../pwa/phone'
import { foldersApi, type Folder, type InboxNote } from './api'
import { draggedNow, droppedFrom, endDrag, NOTES_MOVED_EVENT, startNoteDrag, useNoteActions } from './actions'
import { useFolderActions } from './useFolderActions'
import { drop } from './drop'
import { FolderMark } from './FolderMark'
import { FolderMenu } from './FolderMenu'
import { colorOf } from './palette'
import { originText } from './origin'
import { flatten, pathOf, revealFolder, setFolderOpen, useFolders, useOpenFolders } from './store'

// The open folder for "New note" (AC-9) follows the list on show: the notes' workspace sets it (`NotesPage`), whether
// the list has room beside the notes or not.

// ---- A folder --------------------------------------------------------------------------------------------------------

export function FolderPage() {
  const { t } = useTranslation()
  const id = useParams().id ?? ''
  const tree = useFolders()
  const actions = useFolderActions()
  const { newNote } = useNoteActions()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [over, setOver] = useState(false)
  const folder = tree.byId.get(id)
  const location = useLocation()
  const padding = useListPadding()
  useListTitle(folder?.name ?? t('folders.section'))
  useEffect(() => {
    if (tree.status === 'ready' && tree.byId.has(id)) revealFolder(id)
  }, [id, tree.status, tree.byId])

  if (tree.inbox?.id === id) return <Navigate to={`/inbox${location.search}`} replace state={location.state} />
  if (tree.status !== 'ready' && !folder) return null
  if (!folder)
    return (
      <div className="p-6 text-sm text-mist-400" data-testid="folder-gone">
        {t('folders.page.gone')}
      </div>
    )

  const path = pathOf(tree, id)
  // On a phone: back to the folder above, or to all folders (NOTES-23 AC-1).
  const parent = path.length > 1 ? path[path.length - 2] : null
  const takeNotes = (event: DragEvent) => {
    if (draggedNow()?.kind !== 'notes') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }

  return (
    <div className={'flex min-h-full flex-col gap-4 ' + padding} data-testid="folder-page">
      <PhoneBack to={parent ? `/folder/${parent.id}` : '/folders'} label={parent ? parent.name : t('folders.section')} />
      <nav aria-label={t('folders.page.path')} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-mist-500">
        {path.map((step, index) =>
          index < path.length - 1 ? (
            <span key={step.id} className="flex min-w-0 items-center gap-1.5">
              <Link to={`/folder/${step.id}`} className="max-w-[16ch] truncate text-mist-300 hover:text-accent-400 hover:underline" title={step.name}>
                {step.name}
              </Link>
              <span aria-hidden>›</span>
            </span>
          ) : (
            <span key={step.id} aria-current="page" className="max-w-[24ch] truncate" title={step.name}>
              {step.name}
            </span>
          ),
        )}
      </nav>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]" style={{ background: `color-mix(in srgb, ${colorOf(folder.color)} 16%, transparent)` }}>
          <FolderMark folder={folder.icon ? folder : { ...folder, icon: 'folder' }} size={18} />
        </span>
        <h1 className="min-w-0 truncate text-2xl font-bold" title={folder.name}>
          {folder.name}
        </h1>
        <span className="shrink-0 text-[13px] text-mist-500">{t('folders.count.notes', { count: folder.count })}</span>
        <button type="button" aria-label={t('folders.menu.label', { name: folder.name })} onClick={(event) => setMenu(event.currentTarget)} className="nn-btn nn-btn-ghost ml-auto h-9 w-9 shrink-0 px-0">
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </button>
      </div>
      {folder.count === 0 ? (
        <div
          data-testid="folder-empty"
          onDragOver={takeNotes}
          onDragEnter={takeNotes}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            const dragged = droppedFrom(event)
            endDrag()
            if (dragged?.kind === 'notes') void drop(tree, dragged, folder.id, 'into')
          }}
          className={'flex min-h-[420px] flex-1 flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed p-6 text-center ' + (over ? 'border-accent-500 bg-[var(--color-accent-wash)]' : 'border-ink-600')}
        >
          <FileText aria-hidden className="h-12 w-12 text-accent-400" strokeWidth={1.3} />
          <p className="text-lg font-semibold">{t('folders.page.emptyTitle', { name: folder.name })}</p>
          <p className="max-w-sm text-sm leading-relaxed text-mist-500">{t('folders.page.emptyText')}</p>
          {newNote && (
            <button type="button" className="nn-btn nn-btn-accent" onClick={() => newNote(folder.id)}>
              {t('folders.page.newNote', { name: folder.name })}
            </button>
          )}
        </div>
      ) : (
        <NoteList folderId={folder.id} />
      )}
      {newNote && <PhoneNewNote onClick={() => newNote(folder.id)} label={t('folders.page.newNote', { name: folder.name })} />}
      {menu && <FolderMenu folder={folder} anchor={menu} onClose={() => setMenu(null)} onAction={(action) => actions.act(action, folder)} />}
      {actions.node}
    </div>
  )
}

// ---- The inbox -------------------------------------------------------------------------------------------------------

/** A quiet sign of where a note came from (AC-7): shared, dictated, via MCP, a shortcut, nexdeck, made here. Never the
 * inbox's tray, which would only repeat the page. */
export function OriginIcon({ origin }: { origin: string }) {
  const kind = origin.split(':')[0]
  const Icon = !origin
    ? PenLine
    : kind === 'share'
      ? Share2
      : kind === 'dictation'
        ? Mic
        : kind === 'mcp'
          ? Plug
          : kind === 'shortcut'
            ? Zap
            : kind === 'nexdeck'
              ? LayoutGrid
              : StickyNote
  return <Icon aria-hidden className="h-4 w-4 text-mist-500" strokeWidth={2} data-testid="inbox-origin-icon" data-origin={origin ? kind : 'here'} />
}

/** The sign before a card's title: the note's symbol in its colour (NOTES-3 AC-18), as in the lists; without one,
 * where it came from. */
export function InboxMark({ note }: { note: Pick<InboxNote, 'icon' | 'color' | 'origin'> }) {
  const tint = note.color ? `color-mix(in srgb, ${colorOf(note.color)} 16%, transparent)` : undefined
  return (
    <span className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ' + (tint ? '' : 'bg-ink-800')} style={tint ? { background: tint } : undefined} data-testid="inbox-mark">
      {note.icon ? <NoteIcon icon={note.icon} color={note.color} size={18} /> : <OriginIcon origin={note.origin} />}
    </span>
  )
}

export function InboxPage() {
  const { t, i18n } = useTranslation()
  const tree = useFolders()
  const actions = useFolderActions()
  const { noteHref, newNote } = useNoteActions()
  const [notes, setNotes] = useState<InboxNote[] | null>(null)
  const [problem, setProblem] = useState('')
  const asked = useRef(0)
  const padding = useListPadding()
  useListTitle(t('folders.inbox.name'))

  const load = useCallback(async () => {
    const mine = ++asked.current
    try {
      const found = await foldersApi.inbox()
      if (mine === asked.current) {
        setNotes(found.notes)
        setProblem('')
      }
    } catch (error) {
      if (mine === asked.current) setProblem(problemText(error))
    }
  }, [])

  // Again whenever the inbox's count changes (a note captured on another device, one filed by dragging).
  const count = tree.inbox?.count
  useEffect(() => {
    void load()
  }, [load, count])
  useEffect(() => {
    const again = () => void load()
    window.addEventListener(NOTES_MOVED_EVENT, again)
    return () => window.removeEventListener(NOTES_MOVED_EVENT, again)
  }, [load])

  return (
    <div className={'flex min-h-full flex-col gap-4 ' + padding} data-testid="inbox-page">
      <PhoneBack to="/folders" label={t('folders.section')} />
      {newNote && tree.inbox && <PhoneNewNote onClick={() => newNote(tree.inbox!.id)} label={t('folders.page.newNote', { name: t('folders.inbox.name') })} />}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('folders.inbox.name')}</h1>
        <p className="text-[13.5px] text-mist-400">{t('folders.inbox.text')}</p>
      </div>
      {problem && <p className="text-sm text-bad-500">{problem}</p>}
      {notes && notes.length === 0 && (
        <div data-testid="inbox-empty" className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded-[16px] border border-dashed border-ink-600 p-6 text-center">
          <LogoMark size={44} />
          <p className="text-lg font-semibold">{t('folders.inbox.emptyTitle')}</p>
          <p className="max-w-md text-sm leading-relaxed text-mist-500">{t('folders.inbox.emptyText')}</p>
        </div>
      )}
      {notes && notes.length > 0 && (
        <>
          <ul className="flex max-w-[860px] flex-col gap-2.5">
            {notes.map((note) => {
              const title = note.title || t('folders.inbox.untitled')
              const href = noteHref?.(note.id)
              return (
                <li
                  key={note.id}
                  draggable
                  onDragStart={(event) => startNoteDrag(event, [note.id])}
                  onDragEnd={endDrag}
                  data-note={note.id}
                  className="nn-card flex flex-wrap items-center gap-3.5 px-4 py-3.5"
                  data-testid="inbox-card"
                >
                  <InboxMark note={note} />
                  <span className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      {href ? (
                        <Link to={href} className="truncate text-[15px] font-semibold hover:underline">
                          {title}
                        </Link>
                      ) : (
                        <span className="truncate text-[15px] font-semibold">{title}</span>
                      )}
                      {note.title_check && <span className="rounded-md bg-warn-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn-500">{t('folders.inbox.titleCheck')}</span>}
                      {note.title_check && (
                        <button
                          type="button"
                          data-testid="inbox-title-ok"
                          className="nn-btn nn-btn-quiet text-[12px]"
                          onClick={() =>
                            void notesApi
                              .titleOk(note.id)
                              .then(() => load())
                              .catch((error) => setProblem(problemText(error)))
                          }
                        >
                          {t('notes.titleOk')}
                        </button>
                      )}
                    </span>
                    {note.preview && <span className="truncate text-[13px] text-mist-500">{note.preview}</span>}
                    <span className="text-xs text-mist-500">
                      {originText(note.origin, t)} · {ago(new Date(note.created_at).getTime(), i18n.language)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]"
                    onClick={() => actions.moveNotes([note.id], tree.inbox?.id ?? null, { title, icon: note.icon, color: note.color, sortIn: true, onMoved: () => void load() })}
                  >
                    {t('folders.inbox.sortIn')}
                    <ChevronDown aria-hidden className="h-3 w-3 text-mist-500" strokeWidth={2.6} />
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="text-[12.5px] text-mist-500">{t('folders.inbox.tip')}</p>
        </>
      )}
      {actions.node}
    </div>
  )
}

// ---- All folders, the phone's way ------------------------------------------------------------------------------------

export function FoldersPage() {
  const { t } = useTranslation()
  const tree = useFolders()
  const open = useOpenFolders()
  const actions = useFolderActions()
  const { newNote } = useNoteActions()
  const [menu, setMenu] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null)
  useListTitle(t('folders.section'))
  const rows = flatten(tree, open)
  return (
    <div className="flex min-h-full flex-col" data-testid="folders-page">
      <div className="flex-1 space-y-3.5 px-4 pt-5 pb-4">
        <h1 className="text-[26px] font-bold tracking-tight">{t('folders.section')}</h1>
        <div className="nn-card overflow-hidden rounded-[14px]">
          <Link to="/inbox" className="flex min-h-[50px] items-center justify-between border-b border-ink-800 px-3.5 text-base hover:bg-ink-800">
            <span className="flex items-center gap-2.5">
              <Inbox aria-hidden className="h-4 w-4 text-mist-500" />
              {t('folders.inbox.name')}
            </span>
            <span className="text-[15px] text-mist-500">{tree.inbox?.count ?? ''} ›</span>
          </Link>
          {/* The places of the drawing "Handy-Ordner" (NOTES-23 AC-1): all notes and what others shared. */}
          <Link to="/" className="flex min-h-[50px] items-center justify-between border-b border-ink-800 px-3.5 text-base hover:bg-ink-800" data-testid="folders-all">
            <span className="flex items-center gap-2.5">
              <NotebookText aria-hidden className="h-4 w-4 text-mist-500" />
              {t('notes.all')}
            </span>
            <span className="text-[15px] text-mist-500">›</span>
          </Link>
          <Link to="/shared" className="flex min-h-[50px] items-center justify-between px-3.5 text-base hover:bg-ink-800" data-testid="folders-shared">
            <span className="flex items-center gap-2.5">
              <Users aria-hidden className="h-4 w-4 text-mist-500" />
              {t('shares.page.title')}
            </span>
            <span className="text-[15px] text-mist-500">›</span>
          </Link>
        </div>
        <p className="px-1 text-xs font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('folders.section')}</p>
        {rows.length > 0 && (
          <div className="nn-card overflow-hidden rounded-[14px]">
            {rows.map(({ folder, depth }) => {
              const hasChildren = (tree.children.get(folder.id) ?? []).length > 0
              const isOpen = open.has(folder.id)
              return (
                <div key={folder.id} className="flex min-h-[50px] items-center border-b border-ink-800 last:border-b-0" style={{ paddingLeft: 6 + Math.min(depth, 8) * 18 }}>
                  {hasChildren ? (
                    <button type="button" aria-label={isOpen ? t('folders.collapse') : t('folders.expand')} onClick={() => setFolderOpen(folder.id, !isOpen)} className="flex h-11 w-8 shrink-0 items-center justify-center text-mist-500">
                      {isOpen ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
                    </button>
                  ) : (
                    <span aria-hidden className="w-8 shrink-0" />
                  )}
                  <Link to={`/folder/${folder.id}`} className="flex min-h-[50px] min-w-0 flex-1 items-center justify-between gap-2 pr-1 text-base">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FolderMark folder={folder} size={16} />
                      <span className="truncate" title={folder.name}>
                        {folder.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-[15px] text-mist-500">{folder.count} ›</span>
                  </Link>
                  <button type="button" aria-label={t('folders.menu.label', { name: folder.name })} onClick={(event) => setMenu({ folder, anchor: event.currentTarget })} className="flex h-11 w-10 shrink-0 items-center justify-center text-mist-500">
                    <MoreHorizontal aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {tree.status === 'ready' && rows.length === 0 && <p className="px-1 text-sm text-mist-500">{t('folders.empty')}</p>}
      </div>
      <div className="sticky bottom-0 flex items-center justify-between border-t border-ink-700 bg-ink-900 px-4 pt-3 pb-7">
        <button type="button" onClick={() => actions.create(null)} className="h-11 px-1.5 text-[15px] text-accent-400">
          {t('folders.newFolder')}
        </button>
        {newNote && tree.inbox && (
          <button type="button" aria-label={t('folders.page.newNote', { name: t('folders.inbox.name') })} onClick={() => newNote(tree.inbox!.id)} className="flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-accent-500 text-on-accent">
            <Plus aria-hidden className="h-[22px] w-[22px]" strokeWidth={2.6} />
          </button>
        )}
      </div>
      {menu && <FolderMenu folder={menu.folder} anchor={menu.anchor} onClose={() => setMenu(null)} onAction={(action) => actions.act(action, menu.folder)} />}
      {actions.node}
    </div>
  )
}
