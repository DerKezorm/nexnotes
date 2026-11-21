/** The export routes of the server (`backend/app/routers/export.py`, NOTES-17). */
import { api, ApiError, tabId } from '../api/client'

export type ExportJob = {
  id: string
  folder_id: string | null
  /** The folder's name at the start; empty for everything. */
  label: string
  filename: string
  status: 'queued' | 'running' | 'ready' | 'failed'
  /** Why it failed: disk_full, interrupted, not_found, failed. */
  problem: string
  estimate: number
  size: number
  notes: number
  created_at: string
  finished_at: string | null
  expires_at: string | null
  seen: boolean
}

export type Estimate = { bytes: number; notes: number }

export const exportApi = {
  estimate: (folderId: string | null) => api<Estimate>('/api/export/estimate', { query: { folder_id: folderId ?? undefined } }),
  start: (folderId: string | null) => api<ExportJob>('/api/export/jobs', { method: 'POST', body: { folder_id: folderId } }),
  jobs: () => api<ExportJob[]>('/api/export/jobs'),
  seen: (id: string) => api<ExportJob>(`/api/export/jobs/${encodeURIComponent(id)}/seen`, { method: 'POST' }),
  restart: (id: string) => api<ExportJob>(`/api/export/jobs/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  note: noteFile,
}

/** One note as a file: Markdown (with attachments a ZIP) or PDF, with the name the server gave it. A failure comes
 * back as `ApiError`, so the dialog can say what went wrong (a download link could not). */
async function noteFile(noteId: string, kind: 'markdown' | 'pdf'): Promise<{ blob: Blob; name: string }> {
  const response = await fetch(`/api/export/notes/${encodeURIComponent(noteId)}/${kind}`, { headers: { 'X-Nexnotes-Client': tabId() } })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const code = data?.detail?.code
    throw new ApiError(response.status, typeof code === 'string' ? code : 'internal_error')
  }
  const fallback = kind === 'pdf' ? 'note.pdf' : 'note.md'
  return { blob: await response.blob(), name: nameFrom(response.headers.get('content-disposition'), fallback) }
}

/** Where the ready ZIP is fetched: a plain link, the browser downloads it with the session's cookie. */
export function downloadHref(job: ExportJob): string {
  return `/api/export/jobs/${encodeURIComponent(job.id)}/download`
}

/** The name the server gave the file (`filename*=UTF-8''…`), else `fallback`. */
export function nameFrom(disposition: string | null, fallback: string): string {
  const found = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')
  if (!found) return fallback
  try {
    return decodeURIComponent(found[1])
  } catch {
    return fallback
  }
}

/** Hands a file to the browser to save. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
