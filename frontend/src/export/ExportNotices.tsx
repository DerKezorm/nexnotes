/**
 * The notices of exports in the background (NOTES-17 AC-7): while one waits or runs a quiet line says so; when the ZIP
 * is ready, a notice with "Herunterladen" until the member fetches it or puts it away. An export that broke off (a
 * restart of the server, EC-6; a full disk, EC-7) says why and offers to start again.
 */
import { Download, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { bytes } from '../lib/format'
import { problemText } from '../lib/errors'
import { downloadHref, exportApi, type ExportJob } from './api'
import { markSeen, refreshExports, useExportJobs } from './watch'

export function ExportNotices() {
  const { t, i18n } = useTranslation()
  const jobs = useExportJobs()
  const [problem, setProblem] = useState('')

  useEffect(() => {
    void refreshExports()
  }, [])

  const name = (job: ExportJob) => (job.folder_id ? job.label || t('export.inbox') : t('export.everything'))
  const running = jobs.filter((job) => job.status === 'queued' || job.status === 'running')
  const told = jobs.filter((job) => !job.seen && (job.status === 'ready' || job.status === 'failed'))
  if (!running.length && !told.length) return null

  const restart = async (job: ExportJob) => {
    setProblem('')
    try {
      await exportApi.restart(job.id)
      await refreshExports()
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[55] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" data-testid="export-notices">
      {running.map((job) => (
        <div key={job.id} role="status" data-testid="export-running" className="pointer-events-auto flex items-center gap-2.5 rounded-[12px] border border-ink-600 bg-ink-800 px-3.5 py-2.5 text-[13px] text-mist-300 shadow-xl shadow-black/40">
          <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-accent-400" />
          <span className="min-w-0">{t(job.status === 'queued' ? 'export.waiting' : 'export.running', { name: name(job) })}</span>
        </div>
      ))}
      {told.map((job) => (
        <div key={job.id} role="status" data-testid={`export-${job.status}`} className="pointer-events-auto flex flex-col gap-2 rounded-[12px] border border-ink-600 bg-ink-800 px-3.5 py-3 text-[13.5px] text-mist-100 shadow-xl shadow-black/40">
          <div className="flex items-start gap-2">
            <span className={'min-w-0 flex-1 ' + (job.status === 'failed' ? 'text-warn-500' : '')}>
              {job.status === 'ready'
                ? t('export.ready', { name: name(job), size: bytes(job.size, i18n.language) })
                : t(`export.failed.${['disk_full', 'interrupted', 'not_found'].includes(job.problem) ? job.problem : 'failed'}`, { name: name(job) })}
            </span>
            <button type="button" aria-label={t('common.close')} className="shrink-0 rounded-full p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100" onClick={() => void markSeen(job.id)}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <div className="flex justify-end gap-2">
            {job.status === 'ready' ? (
              <a href={downloadHref(job)} download={job.filename} className="nn-btn nn-btn-accent h-8 gap-1.5 px-3" onClick={() => void markSeen(job.id)}>
                <Download className="h-4 w-4" aria-hidden />
                {t('export.download')}
              </a>
            ) : (
              job.problem !== 'not_found' && (
                <button type="button" className="nn-btn nn-btn-ghost h-8 gap-1.5 px-3" onClick={() => void restart(job)}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  {t('export.restart')}
                </button>
              )
            )}
          </div>
        </div>
      ))}
      {problem && (
        <p role="alert" className="pointer-events-auto rounded-[9px] border border-bad-500/40 bg-ink-800 px-3 py-2 text-sm text-bad-500">
          {problem}
        </p>
      )}
    </div>
  )
}
