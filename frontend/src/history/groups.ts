/**
 * The versions grouped as the list shows them (NOTES-15 AC-1): today, yesterday, by day, by week. Days are the days of
 * the device's time zone, summer time included (EC-9); the server thins by its own clock, which is another matter.
 */
import type { Author, VersionItem } from './api'

export type GroupKey = 'today' | 'yesterday' | 'days' | 'weeks'
export type Entry = { version: VersionItem; label: string }
export type Group = { key: GroupKey; entries: Entry[] }

/** Until this many days back a version stands with its day; older ones with their week. */
export const DAYS_BY_DAY = 30
const DAY_MS = 86_400_000

/** The calendar day of a moment in a time zone, as a number of days since 1970. */
export function dayNumber(date: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS
}

/** The Monday of the week a day belongs to (1 January 1970 was a Thursday). */
export function weekStart(day: number): number {
  return day - ((day + 3) % 7)
}

function dayLabel(day: number, lang: string, withWeekday = true): string {
  return new Intl.DateTimeFormat(lang, { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}) }).format(new Date(day * DAY_MS))
}

export function timeLabel(value: string, lang: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function groupVersions(
  versions: VersionItem[],
  lang: string,
  weekOf: (date: string) => string,
  now = new Date(),
  timeZone?: string,
): Group[] {
  const today = dayNumber(now, timeZone)
  const groups = new Map<GroupKey, Entry[]>()
  const perWeek = new Map<number, number>()
  for (const version of versions) {
    const day = dayNumber(new Date(version.created_at), timeZone)
    if (today - day > DAYS_BY_DAY) perWeek.set(weekStart(day), (perWeek.get(weekStart(day)) ?? 0) + 1)
  }
  for (const version of versions) {
    const day = dayNumber(new Date(version.created_at), timeZone)
    const back = today - day
    const time = timeLabel(version.created_at, lang, timeZone)
    let key: GroupKey
    let label: string
    if (back <= 0) [key, label] = ['today', time]
    else if (back === 1) [key, label] = ['yesterday', time]
    else if (back <= DAYS_BY_DAY) [key, label] = ['days', `${dayLabel(day, lang)}, ${time}`]
    else {
      key = 'weeks'
      // One version in its week stands as the week; several (before the server thinned them) with their days.
      label = (perWeek.get(weekStart(day)) ?? 0) > 1 ? dayLabel(day, lang) : weekOf(dayLabel(weekStart(day), lang, false))
    }
    const entries = groups.get(key) ?? []
    entries.push({ version, label })
    groups.set(key, entries)
  }
  const order: GroupKey[] = ['today', 'yesterday', 'days', 'weeks']
  return order.filter((key) => groups.has(key)).map((key) => ({ key, entries: groups.get(key)! }))
}

/** "Anna", "Bruno, Anna", "MCP · Laptop". */
export function whoText(authors: Author[], t: (key: string, values?: Record<string, unknown>) => string): string {
  const names = authors.map((author) => {
    const name = author.name || t('history.someone')
    if (!author.via) return name
    // A nexdeck card that ticked an item (NOTES-21) names its key as well, beside the tools of MCP.
    if (author.via.startsWith('nexdeck:')) return t('history.viaDeck', { key: author.via.slice(8) })
    // A program with an API token (NOTES-25 AC-22): the account and the token.
    if (author.via.startsWith('api:')) return t('history.viaApi', { account: name, name: author.via.slice(4) })
    const key = author.via.startsWith('mcp:') ? author.via.slice(4) : author.via
    return t('history.viaKey', { key })
  })
  return [...new Set(names)].join(', ')
}
