/**
 * "Mit mir geteilt" (NOTES-13 AC-3, drawing "N13-Mit-mir-geteilt"): what others shared with the member, per owner,
 * each with its right and "Verlassen" (AC-6); above it what is not there any more and why (AC-5, EC-4). A shared
 * folder opens as a list like every other (`SharedFolderPage`: the same head, "Ansicht", the four looks), its notes in
 * the editor as any note.
 */
import { FileText, Folder as FolderIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import { Avatar } from '../components/Avatar'
import { Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { notesChanged } from '../notes/api'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { noteHref } from '../notes/newNote'
import { NoteList } from '../notes/NoteList'
import { hrefIn } from '../notes/workspace'
import { FolderBell } from '../notify/NotifyBell'
import { PhoneListWays } from '../pwa/phone'
import { sharesApi, sharesChanged, type SharedFolder, type ShareNotice, type WithMeItem } from './api'
import { noticeText, useWithMe } from './withMe'

function Row({ item, onLeave }: { item: WithMeItem; onLeave: () => void }) {
  const { t, i18n } = useTranslation()
  const folder = item.kind === 'folder'
  const meta = [
    folder ? t('shares.page.folder', { count: item.notes ?? 0 }) : t('shares.page.note'),
    item.updated_at ? t('shares.page.changed', { date: day(item.updated_at, i18n.language) }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const Icon = folder ? FolderIcon : FileText
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-2.5 py-3" data-testid="shared-item">
      <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-mist-300" strokeWidth={1.8} />
      <Link to={folder ? `/shared/folder/${encodeURIComponent(item.id)}` : noteHref(item.id)} className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5 hover:text-accent-400">
        <span className="truncate text-[14.5px] font-semibold">{item.title || t('notes.untitled')}</span>
        <span className="truncate text-[12.5px] text-mist-500">{meta}</span>
      </Link>
      <span
        className={'rounded-md px-2 py-0.5 text-xs font-semibold ' + (item.level === 'write' ? 'bg-accent-wash text-accent-400' : 'bg-ink-800 text-mist-300')}
        data-testid="shared-level"
      >
        {t(`shares.level.${item.level}`)}
      </span>
      <button type="button" className="nn-btn nn-btn-ghost h-[34px]" onClick={onLeave} data-testid="shared-leave">
        {t('shares.page.leave')}
      </button>
    </div>
  )
}

export function SharedPage() {
  const { t } = useTranslation()
  const padding = useListPadding()
  useListTitle(t('shares.page.title'))
  const { data, problem, reload } = useWithMe()
  const [trouble, setTrouble] = useState('')

  const leave = async (item: WithMeItem) => {
    setTrouble('')
    try {
      await sharesApi.leave(item.kind, item.id)
      sharesChanged()
      notesChanged()
      reload()
    } catch (error) {
      setTrouble(problemText(error))
    }
  }
  const drop = async (notice: ShareNotice) => {
    await sharesApi.dropNotice(notice.id).catch(() => undefined)
    reload()
  }

  return (
    <div className={'flex min-h-full flex-col gap-4 ' + padding} data-testid="shared-page">
      <PhoneListWays />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t('shares.page.title')}</h1>
        <p className="text-[13.5px] text-mist-400">{t('shares.page.text')}</p>
      </div>
      <Problem text={problem || trouble} />
      {data?.notices.map((notice) => (
        <div key={notice.id} role="status" className="flex max-w-[900px] items-center gap-3 rounded-[10px] border border-ink-700 bg-ink-850 px-3.5 py-3 text-[13px] text-mist-200" data-testid="shared-notice">
          <span className="flex-1">{noticeText(notice, t)}</span>
          <button type="button" className="nn-btn nn-btn-quiet text-xs" onClick={() => void drop(notice)}>
            {t('shares.page.dismiss')}
          </button>
        </div>
      ))}
      {data && data.groups.length === 0 && (
        <p className="text-sm text-mist-500" data-testid="shared-empty">
          {t('shares.page.empty')}
        </p>
      )}
      {data?.groups.map((group) => (
        <section key={group.owner.id} className="flex max-w-[900px] flex-col gap-1.5" data-testid="shared-group">
          <h2 className="flex items-center gap-2.5 text-sm font-semibold">
            <Avatar accountId={group.owner.id} name={group.owner.name} stamp={group.owner.avatar} size={26} />
            {t('shares.page.from', { name: group.owner.name })}
          </h2>
          {group.items.map((item) => (
            <Row key={`${item.kind}-${item.id}`} item={item} onLeave={() => void leave(item)} />
          ))}
        </section>
      ))}
    </div>
  )
}

/** A folder somebody shared (or one below it): its name, whose it is, the right, its folders and its notes. */
export function SharedFolderPage() {
  const { t } = useTranslation()
  const id = useParams().id ?? ''
  const padding = useListPadding()
  const [folder, setFolder] = useState<SharedFolder | null>(null)
  const [problem, setProblem] = useState('')
  useListTitle(folder?.name ?? t('shares.page.title'))
  useEffect(() => {
    setFolder(null)
    sharesApi.folder(id).then(
      (found) => {
        setFolder(found)
        setProblem('')
      },
      (error) => setProblem(problemText(error)),
    )
  }, [id])

  if (problem)
    return (
      <div className={'flex flex-col gap-3 ' + padding} data-testid="shared-folder-gone">
        <Problem text={problem} />
        <Link to="/shared" className="text-sm text-accent-400 hover:underline">
          {t('shares.page.back')}
        </Link>
      </div>
    )
  if (!folder) return null
  // The head every list has: "Mit mir geteilt" as the path, the folder's name and count, whose it is and the right,
  // the bell; its folders between the head and the notes.
  const crumb = (
    <nav aria-label={t('shares.page.title')} className="flex min-w-0 items-center gap-1">
      <Link to="/shared" className="text-mist-500 hover:text-accent-400 hover:underline">
        {t('shares.page.title')}
      </Link>
      <span aria-hidden>›</span>
      <span aria-current="page" className="sr-only">
        {folder.name}
      </span>
    </nav>
  )
  const actions = (
    <>
      <span className="hidden max-w-[22ch] truncate text-[12.5px] text-mist-500 sm:inline" data-testid="shared-folder-whose">
        {t('shares.page.from', { name: folder.owner.name })} · {t(`shares.level.${folder.level}`)}
      </span>
      <FolderBell id={folder.id} name={folder.name} />
    </>
  )
  const intro =
    folder.folders.length > 0 ? (
      <ul className="flex flex-wrap gap-2">
        {folder.folders.map((child) => (
          <li key={child.id}>
            <Link to={`/shared/folder/${encodeURIComponent(child.id)}`} className="nn-btn nn-btn-ghost h-8 text-[13px]">
              <FolderIcon aria-hidden className="h-4 w-4" />
              {child.name}
            </Link>
          </li>
        ))}
      </ul>
    ) : undefined
  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="shared-folder-page">
      <PhoneListWays to="/shared" label={t('shares.page.title')} />
      <NoteList
        folderId={folder.id}
        heading={folder.name}
        crumb={crumb}
        icon={<FolderIcon aria-hidden className="h-[18px] w-[18px] shrink-0 text-mist-300" strokeWidth={1.8} />}
        actions={actions}
        intro={intro}
        hrefFor={(noteId) => hrefIn(`/shared/folder/${encodeURIComponent(folder.id)}`, noteId)}
      />
    </div>
  )
}
