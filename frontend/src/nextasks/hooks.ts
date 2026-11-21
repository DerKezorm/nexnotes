/** The connection of nextasks for any part of the page, and how a due day reads on a mark. */
import { useEffect, useSyncExternalStore } from 'react'

import { loadNextasks, nextasksStatus, onNextasks } from './api'

export function useNextasks() {
  const status = useSyncExternalStore(onNextasks, nextasksStatus)
  useEffect(() => {
    if (!nextasksStatus()) void loadNextasks().catch(() => undefined)
  }, [])
  return status
}

/** "Fr", "27. Nov.": the due day short, the weekday within the next week. */
export function dueText(day: string, lang: string, today = new Date()): string {
  const [year, month, date] = day.split('-').map(Number)
  const due = new Date(year, month - 1, date)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000)
  if (days >= 0 && days < 7) return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(due).replace(/\.$/, '')
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(due)
}
