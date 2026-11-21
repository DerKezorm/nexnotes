/**
 * The exports of the account that run in the background (NOTES-17 AC-7, EC-6, EC-7), outside React's tree: the dialog
 * starts one, the notices at the bottom show how it goes and when the ZIP is ready. While one waits or runs the page
 * asks the server every few seconds; otherwise once when it loads (an export that ended while the page was closed is
 * still told) and whenever something is started.
 */
import { useSyncExternalStore } from 'react'

import { onAccountChange } from '../state/account'
import { exportApi, type ExportJob } from './api'

/** How often the page asks while an export waits or runs. */
export const POLL_MS = 3000

let jobs: ExportJob[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
const listeners = new Set<() => void>()

function publish(next: ExportJob[]): void {
  jobs = next
  for (const listener of listeners) listener()
}

export function pending(list: ExportJob[]): boolean {
  return list.some((job) => job.status === 'queued' || job.status === 'running')
}

/** Asks the server for the account's exports; while one waits or runs, again in a moment. */
export async function refreshExports(): Promise<ExportJob[]> {
  const asked = generation
  if (timer) clearTimeout(timer)
  timer = null
  let found: ExportJob[]
  try {
    const answer: unknown = await exportApi.jobs()
    found = Array.isArray(answer) ? (answer as ExportJob[]) : []
  } catch {
    found = jobs
  }
  // Another account signed in meanwhile: what came is not this one's.
  if (asked !== generation) return jobs
  publish(found)
  if (pending(found)) timer = setTimeout(() => void refreshExports(), POLL_MS)
  return found
}

/** The notice of a finished export was seen (or put away): it does not come again, on no device. */
export async function markSeen(id: string): Promise<void> {
  publish(jobs.map((job) => (job.id === id ? { ...job, seen: true } : job)))
  try {
    await exportApi.seen(id)
  } catch {
    // Seen here; another device asks again later, which is no harm.
  }
}

export function useExportJobs(): ExportJob[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => jobs,
  )
}

onAccountChange(() => {
  generation += 1
  if (timer) clearTimeout(timer)
  timer = null
  publish([])
})
