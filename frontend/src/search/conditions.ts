/**
 * What a search asks for: the words and the filters (AC-4). They live in the address (`/search?q=…&folder=…`), so a
 * search can be bookmarked, goes back and forth with the browser, and becomes a smart folder with exactly these
 * conditions (AC-6, NOTES-7).
 *
 * A period is kept as a choice ("last 7 days"), not as dates: it counts from today whenever it is asked again, in the
 * device's time zone (as NOTES-7 EC-3 wants for smart folders).
 */
import type { SearchQuery } from './api'

export type Period = '' | 'week' | 'month' | 'year' | 'custom'

export type SearchConditions = {
  q: string
  folderId: string
  tag: string
  period: Period
  /** `yyyy-mm-dd`, only for a period of one's own. */
  from: string
  to: string
}

export const NO_CONDITIONS: SearchConditions = { q: '', folderId: '', tag: '', period: '', from: '', to: '' }

const PERIODS: Period[] = ['week', 'month', 'year', 'custom']
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function readConditions(params: URLSearchParams): SearchConditions {
  const period = (params.get('period') ?? '') as Period
  return {
    q: params.get('q') ?? '',
    folderId: params.get('folder') ?? '',
    tag: (params.get('tag') ?? '').replace(/^#/, ''),
    period: PERIODS.includes(period) ? period : '',
    from: DAY.test(params.get('from') ?? '') ? params.get('from')! : '',
    to: DAY.test(params.get('to') ?? '') ? params.get('to')! : '',
  }
}

export function writeConditions(conditions: SearchConditions): URLSearchParams {
  const params = new URLSearchParams()
  if (conditions.q) params.set('q', conditions.q)
  if (conditions.folderId) params.set('folder', conditions.folderId)
  if (conditions.tag) params.set('tag', conditions.tag)
  if (conditions.period) params.set('period', conditions.period)
  if (conditions.period === 'custom') {
    if (conditions.from) params.set('from', conditions.from)
    if (conditions.to) params.set('to', conditions.to)
  }
  return params
}

export function hasFilters(conditions: SearchConditions): boolean {
  return Boolean(conditions.folderId || conditions.tag || periodRange(conditions).since || periodRange(conditions).until)
}

export function withoutFilters(conditions: SearchConditions): SearchConditions {
  return { ...NO_CONDITIONS, q: conditions.q }
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** The period as moments (ISO with the zone), counted from `now` in the device's time zone. */
export function periodRange(conditions: SearchConditions, now = new Date()): { since?: string; until?: string } {
  const today = startOfDay(now)
  const back = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days).toISOString()
  switch (conditions.period) {
    case 'week':
      return { since: back(6) }
    case 'month':
      return { since: back(29) }
    case 'year':
      return { since: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1).toISOString() }
    case 'custom': {
      const range: { since?: string; until?: string } = {}
      if (conditions.from) {
        const [year, month, day] = conditions.from.split('-').map(Number)
        range.since = new Date(year, month - 1, day).toISOString()
      }
      if (conditions.to) {
        const [year, month, day] = conditions.to.split('-').map(Number)
        range.until = new Date(year, month - 1, day + 1, 0, 0, 0, -1).toISOString()
      }
      return range
    }
    default:
      return {}
  }
}

/** The request for the server. */
export function toQuery(conditions: SearchConditions, now = new Date()): SearchQuery {
  const query: SearchQuery = { q: conditions.q }
  if (conditions.folderId) query.folder_id = conditions.folderId
  if (conditions.tag) query.tag = conditions.tag
  const range = periodRange(conditions, now)
  if (range.since) query.since = range.since
  if (range.until) query.until = range.until
  return query
}

/** Something to search for: words, or at least one filter. */
export function askable(conditions: SearchConditions): boolean {
  return conditions.q.trim() !== '' || hasFilters(conditions)
}
