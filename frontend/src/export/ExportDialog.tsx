/**
 * "Exportieren" (NOTES-17, drawing N17-Export): this note as Markdown or PDF, its folder as ZIP, or everything. A note
 * comes at once as a file; a folder or everything runs in the background, and the dialog names the size beforehand
 * (AC-7). Exports that are ready stand at the bottom, to be fetched again for 24 hours (AC-8).
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { bytes } from '../lib/format'
import { problemText } from '../lib/errors'
import { downloadHref, exportApi, saveBlob, type Estimate } from './api'
import { refreshExports, useExportJobs } from './watch'

export type ExportChoice = 'markdown' | 'pdf' | 'folder' | 'all'

export type ExportNote = { id: string; title: string }
export type ExportFolder = { id: string; name: string; inbox?: boolean }

export function ExportDialog({ note, folder, onClose }: { note?: ExportNote; folder?: ExportFolder; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const [choice, setChoice] = useState<ExportChoice>(note ? 'markdown' : folder ? 'folder' : 'all')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const jobs = useExportJobs()
  const ready = jobs.filter((job) => job.status === 'ready')
  const folderName = folder ? (folder.inbox || !folder.name ? t('export.inbox') : folder.name) : ''
  const zip = choice === 'folder' || choice === 'all'
  const scope = choice === 'folder' ? folder?.id ?? null : null

  useEffect(() => {
    void refreshExports()
  }, [])

  useEffect(() => {
    if (!zip) return
    let current = true
    setEstimate(null)
    exportApi.estimate(scope).then(
      (found) => current && setEstimate(found),
      (error) => current && setProblem(problemText(error)),
    )
    return () => {
      current = false
    }
  }, [zip, scope])

  const options = useMemo(() => {
    const list: { key: ExportChoice; title: string; desc: string }[] = []
    if (note) {
      list.push({ key: 'markdown', title: t('export.markdown'), desc: t('export.markdownDesc') })
      list.push({ key: 'pdf', title: t('export.pdf'), desc: t('export.pdfDesc') })
    }
    if (folder) list.push({ key: 'folder', title: t('export.folder', { name: folderName }), desc: t('export.folderDesc') })
    list.push({ key: 'all', title: t('export.all'), desc: t('export.allDesc') })
    return list
  }, [note, folder, folderName, t])

  const go = async () => {
    if (busy) return
    setBusy(true)
    setProblem('')
    try {
      if (choice === 'markdown' || choice === 'pdf') {
        const file = await exportApi.note(note!.id, choice)
        saveBlob(file.blob, file.name)
      } else {
        await exportApi.start(scope)
        void refreshExports()
      }
      onClose()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('export.title')} onClose={onClose} medium>
      <div className="flex flex-col gap-3.5" data-testid="export-dialog">
        <div role="radiogroup" aria-label={t('export.what')} className="flex flex-col gap-2">
          {options.map((option) => {
            const on = option.key === choice
            return (
              <label
                key={option.key}
                data-testid={`export-option-${option.key}`}
                className={
                  'flex cursor-pointer items-start gap-3 rounded-[12px] border px-3.5 py-3 ' +
                  (on ? 'border-accent-500 bg-accent-wash' : 'border-ink-700 hover:bg-ink-800')
                }
              >
                <input
                  type="radio"
                  name="export-choice"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent-500)]"
                  checked={on}
                  onChange={() => {
                    setProblem('')
                    setChoice(option.key)
                  }}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14.5px] font-semibold text-mist-100">{option.title}</span>
                  <span className="text-[12.5px] leading-snug text-mist-500">{option.desc}</span>
                </span>
              </label>
            )
          })}
        </div>
        {zip && (
          <p role="status" data-testid="export-estimate" className="rounded-[10px] border border-ink-700 bg-ink-900 px-3 py-2.5 text-[12.5px] leading-relaxed text-mist-400">
            {estimate
              ? t('export.estimate', { size: bytes(estimate.bytes, i18n.language), notes: t('export.notes', { count: estimate.notes }) })
              : t('export.estimating')}{' '}
            {t('export.background')}
          </p>
        )}
        {problem && (
          <p role="alert" className="rounded-[9px] border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-accent" data-testid="export-start" disabled={busy || (zip && !estimate)} onClick={() => void go()}>
            {t('export.start')}
          </button>
        </div>
        {ready.length > 0 && (
          <div className="border-t border-ink-700 pt-3" data-testid="export-ready">
            <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('export.readyList')}</p>
            <ul className="flex flex-col gap-1">
              {ready.map((job) => (
                <li key={job.id} className="flex items-center justify-between gap-3 text-[13px] text-mist-300">
                  <span className="min-w-0 truncate">
                    {job.filename} · {bytes(job.size, i18n.language)}
                  </span>
                  <a className="shrink-0 font-semibold text-accent-400 hover:underline" href={downloadHref(job)} download={job.filename}>
                    {t('export.download')}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  )
}
