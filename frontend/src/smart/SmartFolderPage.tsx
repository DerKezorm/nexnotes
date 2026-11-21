/**
 * A smart folder opened (NOTES-7 AC-4): a list of the notes' workspace (`/smart/<id>`, the note beside it as `?note=`)
 * that always shows what fits now, as rows or tiles like any folder, its view kept on the server for every device.
 * Above it "Bearbeiten" and "Löschen" (AC-6: deleting asks once and goes without the trash; the notes stay). A
 * condition that points nowhere is named with the way to edit it (EC-1); when nothing fits, the list says so and shows
 * the conditions (EC-2).
 *
 * "Neue Notiz" on this page goes into the inbox: a smart folder is no place (NOTES-4 AC-9, `folderOfList`).
 */
import { Filter, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { Dialog } from '../components/Dialog'
import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { NoteList } from '../notes/NoteList'
import { hrefIn } from '../notes/workspace'
import type { ListSource } from '../notes/list/useNoteList'
import { smartApi, type Broken, type SmartAnswer, type SmartFolder } from './api'
import { describe, smartName } from './conditions'
import { useFolderName } from './folderName'
import { refreshSmartFolders, useSmartFolders } from './store'

/** The conditions as sentences, joined by "and" or "or" (the empty state, EC-2). */
export function ConditionList({ folder }: { folder: SmartFolder }) {
  const { t, i18n } = useTranslation()
  const folderName = useFolderName()
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="text-[13px] text-mist-500">{t(folder.match === 'any' ? 'smart.matchAnySays' : 'smart.matchAllSays')}</p>
      <ul className="flex flex-wrap justify-center gap-1.5" data-testid="smart-conditions">
        {folder.conditions.map((condition, index) => (
          <li key={index} className="rounded-md bg-ink-800 px-2 py-[3px] text-[12.5px] text-mist-100" data-testid="smart-condition">
            {describe(condition, t, i18n.language, folderName)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function BrokenNote({ broken, folderId }: { broken: Broken[]; folderId: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-warn-500/50 bg-warn-500/10 px-3.5 py-2.5 text-[13px] text-mist-100" role="status" data-testid="smart-broken">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {broken.map((item) => (
          <span key={item.index} data-testid="smart-broken-item">
            {item.kind === 'folder' ? t('smart.broken.folder', { name: item.name || t('smart.broken.unnamed') }) : t('smart.broken.tag', { tag: `#${item.name}` })}
          </span>
        ))}
      </span>
      <Link to={`/smart/${encodeURIComponent(folderId)}/edit`} className="nn-btn h-8 border border-warn-500/60 px-3 text-[13px]" data-testid="smart-broken-edit">
        {t('smart.edit')}
      </Link>
    </div>
  )
}

function DeleteDialog({ folder, onClose }: { folder: SmartFolder; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const name = smartName(folder, t)
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await smartApi.remove(folder.id)
      await refreshSmartFolders()
      navigate('/')
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('smart.deleteTitle', { name })} onClose={onClose}>
      <div className="space-y-3" data-testid="smart-delete">
        <p className="text-[13px] leading-normal text-mist-400">{t('smart.deleteSays')}</p>
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-danger" onClick={() => void remove()} disabled={busy} data-testid="smart-delete-confirm">
            {t('smart.delete')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function SmartFolderPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const padding = useListPadding()
  const { folders } = useSmartFolders()
  const [answer, setAnswer] = useState<SmartAnswer | null>(null)
  const [missing, setMissing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const known = folders.find((folder) => folder.id === id) ?? null
  const folder = answer?.folder.id === id ? answer.folder : known
  const name = folder ? smartName(folder, t) : ''
  useListTitle(name || t('smart.heading'))

  const source = useMemo<ListSource>(
    () => ({
      key: `smart:${id}`,
      read: () =>
        smartApi.notes(id).then(
          (found) => {
            setAnswer(found)
            setMissing(false)
            return found
          },
          (error: unknown) => {
            if (error instanceof ApiError && error.status === 404) setMissing(true)
            throw error
          },
        ),
      stamp: () => smartApi.stamp(id),
      saveView: (view) => smartApi.saveView(id, view),
    }),
    [id],
  )

  if (missing)
    return (
      <div className={'flex flex-col gap-3 ' + padding} data-testid="smart-missing">
        <h1 className="text-2xl font-bold">{t('smart.missingTitle')}</h1>
        <p className="text-sm text-mist-500">{t('smart.missingText')}</p>
      </div>
    )

  const empty = folder && (
    <div data-testid="smart-empty" className="flex min-h-[260px] flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed border-ink-600 p-6 text-center">
      <Filter aria-hidden className="h-11 w-11 text-accent-400" strokeWidth={1.4} />
      <p className="text-lg font-semibold">{t('smart.emptyTitle')}</p>
      <ConditionList folder={folder} />
      <Link to={`/smart/${encodeURIComponent(id)}/edit`} className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" data-testid="smart-empty-edit">
        {t('smart.edit')}
      </Link>
    </div>
  )

  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="smart-page">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link to={`/smart/${encodeURIComponent(id)}/edit`} className="nn-btn nn-btn-ghost h-8 gap-1.5 px-2.5 text-[13px] font-normal" data-testid="smart-edit">
          <Pencil aria-hidden className="h-3.5 w-3.5" />
          {t('smart.edit')}
        </Link>
        <button
          type="button"
          className="nn-btn nn-btn-ghost h-8 gap-1.5 px-2.5 text-[13px] font-normal"
          onClick={() => setDeleting(true)}
          disabled={!folder}
          data-testid="smart-delete-open"
        >
          <Trash2 aria-hidden className="h-3.5 w-3.5" />
          {t('smart.delete')}
        </button>
      </div>
      {answer && answer.folder.id === id && answer.broken.length > 0 && <BrokenNote broken={answer.broken} folderId={id} />}
      <NoteList heading={name || ' '} source={source} empty={empty || undefined} hrefFor={(noteId) => hrefIn(`/smart/${encodeURIComponent(id)}`, noteId)} />
      {deleting && folder && <DeleteDialog folder={folder} onClose={() => setDeleting(false)} />}
    </div>
  )
}
