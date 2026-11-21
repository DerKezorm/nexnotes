/**
 * Renaming and deleting a tag (drawing "N5-Schlagwort"). Both say beforehand what changes: how many of the member's own
 * notes, and that the notes others shared keep the tag (AC-4, AC-5). Renaming onto a tag that exists already asks once
 * more and then merges the two (AC-7).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { Dialog } from '../components/Dialog'
import { problemText } from '../lib/errors'
import { tagsApi, type RenameResult, type TagPage } from './api'
import { cleanName } from './rules'

function Problem({ text }: { text: string }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-[9px] border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
      {text}
    </p>
  )
}

/** "In der Notiz von Lena bleibt #einkauf stehen." */
function KeptLine({ page }: { page: TagPage }) {
  const { t } = useTranslation()
  const kept = page.others.reduce((sum, other) => sum + other.count, 0)
  if (kept === 0) return null
  return (
    <>
      {' '}
      {t('tags.kept', { count: kept, names: page.others.map((other) => other.name).join(', ') })}{' '}
      <span className="text-accent-400">#{page.label}</span>
      {t('tags.keptEnd')}
    </>
  )
}

export function RenameDialog({ page, onDone, onClose }: { page: TagPage; onDone: (result: RenameResult) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(page.label)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  /** The tag the new name would merge with (AC-7): asked once, then sent with `merge`. */
  const [merging, setMerging] = useState<string | null>(null)
  const clean = cleanName(name)

  const send = async (merge: boolean) => {
    if (busy || !clean) return
    setBusy(true)
    try {
      onDone(await tagsApi.rename(page.label, clean, merge))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'tag_exists') setMerging(String(error.values.label ?? clean))
      else setProblem(problemText(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('tags.renameTitle')} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(merging !== null)
        }}
        className="space-y-3"
        data-testid="tag-rename"
      >
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-mist-100">
          {t('tags.newName')}
          <span className="nn-field flex items-center gap-0.5 focus-within:border-accent-700">
            <span aria-hidden className="text-mist-500">
              #
            </span>
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-mist-100 focus:outline-none"
              value={name}
              onChange={(event) => {
                setName(event.target.value.replace(/^#/, ''))
                setProblem('')
                setMerging(null)
              }}
              onFocus={(event) => event.target.select()}
            />
          </span>
        </label>
        {name.trim() !== '' && !clean && <Problem text={t('errors.tag_name_invalid')} />}
        <p className="text-[13px] leading-normal text-mist-400" data-testid="tag-rename-says">
          {t('tags.renameSays', { count: page.mine })}
          <KeptLine page={page} />
        </p>
        {merging !== null && (
          <p className="rounded-[9px] border border-warn-500/50 bg-warn-500/10 px-3 py-2 text-[13px] text-mist-100" data-testid="tag-merge-ask">
            {t('tags.mergeAsk', { tag: `#${merging}` })}
          </p>
        )}
        <Problem text={problem} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !clean}>
            {merging !== null ? t('tags.merge') : t('tags.rename')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteDialog({ page, onDone, onClose }: { page: TagPage; onDone: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await tagsApi.remove(page.label)
      onDone()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('tags.deleteTitle')} onClose={onClose}>
      <div className="space-y-3" data-testid="tag-delete">
        <p className="text-[13px] leading-normal text-mist-400" data-testid="tag-delete-says">
          {t('tags.deleteSays', { count: page.mine, tag: `#${page.label}` })}
          <KeptLine page={page} />
        </p>
        <Problem text={problem} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-danger" onClick={() => void remove()} disabled={busy || page.mine === 0}>
            {t('tags.delete')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
