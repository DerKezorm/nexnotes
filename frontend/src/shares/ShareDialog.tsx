/**
 * "Teilen …" of an own note or folder (NOTES-13, drawing "N13-Teilen"): members of the server by name or address, each
 * with "lesen" or "bearbeiten" (AC-1), the sentence that only the owner decides (AC-1, AC-11), and for a note the link
 * to read it without an account, with its last day from the calendar (AC-9) while the operator allows links (AC-10).
 *
 * The link's address is shown only right after it was made: the server keeps nothing but its hash. Whoever needs it
 * again makes a new one, and the old one stops working.
 *
 * The field for people: when nobody on the server goes by what was typed, it says so right below (sharing reaches
 * only accounts here), and to the operator offers "Person einladen" (Einstellungen › Konten, the dialog open). "Fertig"
 * with a name typed but nobody chosen keeps the dialog open once and says so; a second "Fertig" closes it. The field
 * clears with an ✕ of its own, not the browser's.
 */
import { Copy, Link2, UserPlus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Avatar } from '../components/Avatar'
import { Dialog } from '../components/Dialog'
import { Problem } from '../components/Field'
import { copyText } from '../lib/copy'
import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { useMe } from '../state/auth'
import { dayFrom, LINK_DAYS, sharesApi, sharesChanged, type Level, type Person, type ShareKind, type Sharing } from './api'

export function ShareDialog({ kind, id, title, onClose }: { kind: ShareKind; id: string; title: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [problem, setProblem] = useState('')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Person[]>([])
  /** What the last answer of the search was for: only then does an empty answer mean nobody goes by it. */
  const [searched, setSearched] = useState('')
  /** "Fertig" was pressed once with a name typed and nobody chosen. */
  const [warned, setWarned] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const operator = useMe()?.role === 'operator'
  const [linkPath, setLinkPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const listId = useId()

  useEffect(() => {
    sharesApi.of(kind, id).then(setSharing, (error) => setProblem(problemText(error)))
  }, [kind, id])

  // Members as the owner types: from two letters on, a moment after the last key.
  const asked = useRef(0)
  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) {
      asked.current++
      setFound([])
      setSearched('')
      return
    }
    const mine = ++asked.current
    const timer = setTimeout(() => {
      const answer = (people: Person[]) => {
        if (mine !== asked.current) return
        setFound(people)
        setSearched(text)
      }
      sharesApi.people(text).then(answer, () => answer([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const act = async (action: () => Promise<Sharing | void>) => {
    setProblem('')
    try {
      const next = await action()
      if (next) setSharing(next)
      sharesChanged()
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  const add = (person: Person) => {
    setQuery('')
    setWarned(false)
    setFound([])
    void act(() => sharesApi.set(kind, id, person.id, 'read'))
  }

  const link = sharing?.link ?? null
  const makeLink = async (until: string) => {
    setProblem('')
    try {
      const made = await sharesApi.makeLink(id, until)
      setLinkPath(made.path ?? null)
      setCopied(false)
      setSharing((before) => (before ? { ...before, link: made } : before))
    } catch (error) {
      setProblem(problemText(error))
    }
  }
  const changeDay = async (until: string) => {
    if (!link || !until) return
    setProblem('')
    try {
      const changed = await sharesApi.changeLink(link.id, until)
      setSharing((before) => (before ? { ...before, link: changed } : before))
    } catch (error) {
      setProblem(problemText(error))
    }
  }
  const revoke = async () => {
    if (!link) return
    setProblem('')
    try {
      await sharesApi.revokeLink(link.id)
      setLinkPath(null)
      setSharing((before) => (before ? { ...before, link: null } : before))
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  const url = linkPath ? new URL(linkPath, window.location.origin).toString() : ''
  const shown = new Set(sharing?.people.map((person) => person.id) ?? [])
  const offered = found.filter((person) => !shown.has(person.id))
  const typed = query.trim()
  const nobody = typed.length >= 2 && searched === typed && found.length === 0
  const done = () => {
    if (typed && !warned) setWarned(true)
    else onClose()
  }
  const type = (text: string) => {
    setQuery(text)
    setWarned(false)
  }

  return (
    <Dialog title={t('shares.dialog.title', { title: title || t('notes.untitled') })} onClose={onClose} medium>
      <div className="flex flex-col gap-4" data-testid="share-dialog">
        <section className="flex flex-col gap-2.5">
          <h3 className="text-[13px] font-semibold">{t('shares.dialog.people')}</h3>
          <div className="relative">
            <input
              ref={field}
              className="nn-field pr-9"
              type="text"
              autoComplete="off"
              placeholder={t('shares.dialog.search')}
              aria-label={t('shares.dialog.searchLabel')}
              aria-controls={listId}
              aria-describedby={`${listId}-says`}
              value={query}
              data-testid="share-search"
              onChange={(event) => type(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && offered[0]) {
                  event.preventDefault()
                  add(offered[0])
                }
              }}
            />
            {query && (
              <button
                type="button"
                aria-label={t('shares.dialog.clear')}
                title={t('shares.dialog.clear')}
                data-testid="share-search-clear"
                onClick={() => {
                  type('')
                  field.current?.focus()
                }}
                className="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-mist-500 hover:bg-ink-700 hover:text-mist-100"
              >
                <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2.2} />
              </button>
            )}
            {offered.length > 0 && (
              <ul id={listId} role="listbox" aria-label={t('shares.dialog.found')} className="absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-[10px] border border-ink-700 bg-ink-850 shadow-xl">
                {offered.map((person) => (
                  <li key={person.id} role="option" aria-selected={false}>
                    <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-ink-800" onClick={() => add(person)} data-testid="share-found">
                      <Avatar accountId={person.id} name={person.name} stamp={person.avatar} size={26} className="bg-ink-600 text-mist-100" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{person.name}</span>
                        <span className="truncate text-xs text-mist-500">{person.email}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div id={`${listId}-says`} aria-live="polite" className="empty:hidden">
            {nobody && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-mist-400" data-testid="share-nobody">
                <span>{t('shares.dialog.nobody')}</span>
                {operator && (
                  <Link to="/settings/accounts?invite=1" onClick={onClose} className="inline-flex items-center gap-1 text-accent-400 hover:underline" data-testid="share-invite">
                    <UserPlus aria-hidden className="h-3.5 w-3.5" />
                    {t('shares.dialog.invite')}
                  </Link>
                )}
              </p>
            )}
            {warned && (
              <p className="text-[12.5px] font-medium text-warn-500" data-testid="share-none-chosen">
                {t('shares.dialog.noneChosen')}
              </p>
            )}
          </div>
          {sharing?.people.map((person) => (
            <div key={person.id} className="flex items-center gap-2.5" data-testid="share-person">
              <Avatar accountId={person.id} name={person.name} stamp={person.avatar} size={32} className="bg-ink-600 text-mist-100" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{person.name}</span>
                <span className="truncate text-xs text-mist-500">{person.email}</span>
              </span>
              <select
                className="nn-field h-[34px] w-auto py-0"
                value={person.level}
                aria-label={t('shares.dialog.right', { name: person.name })}
                onChange={(event) => void act(() => sharesApi.set(kind, id, person.id, event.target.value as Level))}
              >
                <option value="read">{t('shares.level.read')}</option>
                <option value="write">{t('shares.level.write')}</option>
              </select>
              <button
                type="button"
                className="nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0"
                aria-label={t('shares.dialog.remove', { name: person.name })}
                onClick={() => void act(() => sharesApi.remove(kind, id, person.id))}
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
          ))}
          {sharing?.through_folder.map((person) => (
            <p key={`${person.id}-${person.folder}`} className="text-xs text-mist-500" data-testid="share-through">
              {t('shares.dialog.through', { name: person.name, folder: person.folder, level: t(`shares.level.${person.level}`) })}
            </p>
          ))}
          <p className="text-[12.5px] text-mist-500" data-testid="share-hint">
            {kind === 'note' ? t('shares.dialog.onlyYouNote') : t('shares.dialog.onlyYouFolder')}
          </p>
        </section>

        {sharing?.links && (
          <section className="flex flex-col gap-2.5 border-t border-ink-700 pt-3.5" data-testid="share-link">
            <span className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <Link2 aria-hidden className="h-4 w-4" />
                {t('shares.link.title')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(link)}
                aria-label={t('shares.link.switch')}
                data-testid="share-link-switch"
                onClick={() => void (link ? revoke() : makeLink(dayFrom(LINK_DAYS)))}
                className={'flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 ' + (link ? 'justify-end bg-accent-500' : 'justify-start bg-ink-600')}
              >
                <span className={'h-[18px] w-[18px] rounded-full ' + (link ? 'bg-on-accent' : 'bg-mist-300')} />
              </button>
            </span>
            {link && (
              <>
                {url ? (
                  <div className="flex gap-2">
                    <input className="nn-field min-w-0 flex-1" readOnly value={url} aria-label={t('shares.link.address')} data-testid="share-link-url" onFocus={(event) => event.target.select()} />
                    <button
                      type="button"
                      className="nn-btn nn-btn-accent shrink-0"
                      onClick={() => void copyText(url).then(setCopied)}
                    >
                      <Copy aria-hidden className="h-4 w-4" />
                      {copied ? t('shares.link.copied') : t('shares.link.copy')}
                    </button>
                  </div>
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-mist-500" data-testid="share-link-hidden">
                    {t('shares.link.hidden')}
                    <button type="button" className="nn-link text-xs" onClick={() => void makeLink(link.expires_on)}>
                      {t('shares.link.renew')}
                    </button>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
                  <label className="flex items-center gap-2">
                    {t('shares.link.valid')}
                    <input
                      type="date"
                      className="nn-field h-[34px] w-auto py-0"
                      min={dayFrom(1)}
                      required
                      value={link.expires_on}
                      aria-label={t('shares.link.until')}
                      data-testid="share-link-day"
                      onChange={(event) => void changeDay(event.target.value)}
                    />
                  </label>
                  <span className="text-xs text-mist-500">{t('shares.link.untilText', { date: day(`${link.expires_on}T12:00:00`, i18n.language) })}</span>
                  <button type="button" className="ml-auto text-[13px] text-bad-500 hover:underline" onClick={() => void revoke()} data-testid="share-link-revoke">
                    {t('shares.link.revoke')}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        <Problem text={problem} />
        <span className="flex justify-end">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={done} data-testid="share-done">
            {t('shares.dialog.done')}
          </button>
        </span>
      </div>
    </Dialog>
  )
}
