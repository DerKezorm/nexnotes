/**
 * One open note (NOTES-3, NOTES-12): title, the line under it (path, created, changed, by whom, saved), the toolbar,
 * the text, the others in the note, and what the connection says.
 *
 * - Everything is saved as it is typed; "gespeichert" once the room confirmed it, the number of waiting changes while
 *   the connection is away, and an orange bar (NOTES-12 AC-8). Closing the tab with changes waiting asks first (EC-4).
 * - The title is required: leaving inside nexnotes without one asks, with a suggestion from the first words (AC-9).
 *   A note left with neither title nor text goes (EC-4); one left otherwise without a title (the back button, a
 *   closed tab) gets the suggestion with "Titel prüfen" (AC-10).
 * - Deleting moves the note to the trash and offers "Rückgängig" for ten seconds (AC-6).
 */
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Copy, Ellipsis, Trash2, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import * as Y from 'yjs'

import { Dialog } from '../components/Dialog'
import { showNotice } from '../folders/notice'
import { refreshFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { useTitle } from '../lib/title'
import { notesApi, notesChanged, type NoteHead } from '../notes/api'
import { setLeaveGuard } from '../notes/context'
import { noteHref } from '../notes/newNote'
import { useAuth } from '../state/auth'
import './editor.css'
import { bodyIsEmpty, editorExtensions, editorProps, safeHref } from './extensions'
import { presenceFromAwareness, presenceUser, type Presence } from './presence'
import { PresenceBar } from './PresenceBar'
import { NoteProvider } from './provider'
import { cleanTitle, suggestTitle } from './title'
import { whenText } from './when'
import { TitleField, type TitleFieldHandle } from './TitleField'
import { Toolbar } from './Toolbar'

type Props = {
  noteId: string
  /** Just made: the cursor goes into the title (AC-1). */
  fresh?: boolean
  /** After deleting: where to go (the list by default). */
  onDeleted?: () => void
}

/** Leaving a note runs a moment later: React's strict mode unmounts and mounts again at once, which is no leaving. */
const leaving = new Map<string, ReturnType<typeof setTimeout>>()

export function NoteEditor(props: Props) {
  return <OneNote key={props.noteId} {...props} />
}

function OneNote({ noteId, fresh, onDeleted }: Props) {
  const [provider, setProvider] = useState<NoteProvider | null>(null)
  useEffect(() => {
    const made = new NoteProvider(noteId, new Y.Doc())
    made.connect()
    setProvider(made)
    return () => {
      made.destroy()
      setProvider(null)
    }
  }, [noteId])
  if (!provider) return null
  return <LiveNote provider={provider} noteId={noteId} fresh={fresh} onDeleted={onDeleted} />
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

function LiveNote({ provider, noteId, fresh, onDeleted }: Props & { provider: NoteProvider }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { me } = useAuth()
  const myId = me?.id ?? 0
  const myName = me?.display_name || me?.name || ''
  const [head, setHead] = useState<NoteHead | null>(null)
  const [problem, setProblem] = useState('')
  const [title, setTitle] = useState('')
  const [askLeave, setAskLeave] = useState<null | (() => void)>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const titleField = useRef<TitleFieldHandle>(null)
  const titleRef = useRef('')
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
        me: presenceUser(myId, myName),
        t,
        placeholder: t('editor.placeholder'),
        hooks: { onLink: () => setLinkOpen(true) },
      }),
    // The editor is made once per note; the language of its few words follows on the next note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  )
  const editor = useEditor({ extensions, editorProps: { ...editorProps, attributes: { 'aria-label': t('editor.textLabel'), class: 'nn-prose', 'data-testid': 'note-body' } } }, [extensions])

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (provider.synced && titleAtSync.current === null) titleAtSync.current = provider.doc.getText('title').toString()
  }, [live, provider])

  useTitle(cleanTitle(title) || t('notes.untitled'))

  const onTitle = useCallback((value: string) => {
    titleRef.current = value
    setTitle(value)
  }, [])

  // --- leaving --------------------------------------------------------------------------------------------------

  const needsTitle = useCallback(() => !deleted.current && !cleanTitle(titleRef.current) && !bodyIsEmpty(editor), [editor])

  useEffect(() => {
    const pendingLeave = leaving.get(noteId)
    if (pendingLeave) {
      clearTimeout(pendingLeave)
      leaving.delete(noteId)
    }
    setLeaveGuard((proceed) => {
      if (!needsTitle()) return false
      setAskLeave(() => proceed)
      return true
    })
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || editor?.view.dom.contains(anchor)) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
      if (!needsTitle()) return
      event.preventDefault()
      event.stopPropagation()
      setAskLeave(() => () => navigate(url.pathname + url.search + url.hash))
    }
    document.addEventListener('click', onClick, true)
    return () => {
      setLeaveGuard(null)
      document.removeEventListener('click', onClick, true)
      const emptyTitle = !cleanTitle(titleRef.current)
      const emptyBody = bodyIsEmpty(editor)
      if (deleted.current || !emptyTitle || !provider.synced) return
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
  }, [noteId, editor, needsTitle, navigate, provider])

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
      {status === 'offline' && (
        <div role="status" data-testid="offline-bar" className="flex items-center gap-2.5 px-5 py-2.5 text-[13.5px] font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }}>
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          {t('editor.offline')}
        </div>
      )}
      {stopped && (
        <div role="alert" data-testid="stopped-bar" className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-[13.5px] font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }}>
          <span>{t(`editor.stopped.${status}`)}</span>
          {status === 'gone' && head?.can_write && (
            <button type="button" className="nn-btn nn-btn-ghost h-8 px-3" onClick={() => void restore()}>
              {t('editor.restore')}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-2 md:px-5">
        <div className="hidden min-w-0 md:block">{editor && <Toolbar editor={editor} onLink={() => setLinkOpen(true)} />}</div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <PresenceBar presence={presence} />
          <span className="relative">
            <button
              type="button"
              className="nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0"
              aria-label={t('editor.more')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="note-menu"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Ellipsis className="h-4 w-4" aria-hidden />
            </button>
            {menuOpen && (
              <div role="menu" className="nn-menu absolute top-full right-0 mt-1" onKeyDown={(event) => event.key === 'Escape' && setMenuOpen(false)}>
                {titleCheck && (
                  <button type="button" role="menuitem" className="nn-menu-item" onClick={() => void titleOk()}>
                    {t('notes.titleOk')}
                  </button>
                )}
                <button type="button" role="menuitem" className="nn-menu-item" data-testid="note-duplicate" onClick={() => void duplicate()}>
                  <Copy className="h-4 w-4" aria-hidden />
                  {t('editor.duplicate')}
                </button>
                <button type="button" role="menuitem" className="nn-menu-item text-bad-500" data-testid="note-delete" onClick={() => void remove()} disabled={!head?.can_write}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('editor.delete')}
                </button>
              </div>
            )}
          </span>
        </div>
      </div>

      <article className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-3 px-5 pt-6 pb-28 md:px-10 md:pb-10">
        <TitleField
          ref={titleField}
          doc={provider.doc}
          editable={editable}
          autoFocus={fresh}
          onValue={onTitle}
          invalid={askLeave !== null}
          describedBy={askLeave ? 'nn-title-required' : undefined}
          onEnter={() => editor?.commands.focus('start')}
        />
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
        <EditorContent editor={editor} className="nn-editor mt-1 flex-1" />
      </article>

      {editor && (
        <div className="fixed inset-x-0 z-30 md:hidden" style={{ bottom: inset }}>
          <Toolbar editor={editor} onLink={() => setLinkOpen(true)} compact />
        </div>
      )}

      {linkOpen && editor && <LinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
      {askLeave && (
        <LeaveDialog
          suggestion={suggestion}
          onTake={async () => {
            const proceed = askLeave
            try {
              await notesApi.suggestTitle(noteId, suggestion)
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
