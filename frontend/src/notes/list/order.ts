/**
 * The order of a list (NOTES-6): pinned notes first under "Angeheftet" (AC-6), then the others sorted as the view says
 * (AC-4) and, when grouping is on, under Heute, Gestern, Letzte 7 Tage, Letzte 30 Tage and then one heading per month
 * (AC-5); without them the others stand under "Notizen" (AC-6). Sorted by title there are no groups. Days are the
 * device's days (EC-7): everything here takes `now` and reads dates in the browser's time zone.
 */
import type { ListItem, ListView } from './api'

export type GroupKey = 'pinned' | 'notes' | 'today' | 'yesterday' | 'week' | 'month' | `m:${string}` | 'all'

export type Section = { key: GroupKey; items: ListItem[] }

/** The start of the local day of `now`, as a time. */
function startOfDay(now: Date, daysBack = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime()
}

/** Which group a date falls in, seen from `now` on this device. A date in the future (another device's clock) is
 * today. */
export function dayGroup(value: string, now: Date): GroupKey {
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time) || time >= startOfDay(now)) return 'today'
  if (time >= startOfDay(now, 1)) return 'yesterday'
  if (time >= startOfDay(now, 6)) return 'week'
  if (time >= startOfDay(now, 29)) return 'month'
  return `m:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** The date a list sorts and groups by: when the note was made, or when it last changed. */
export function dateOf(item: ListItem, view: Pick<ListView, 'sort'>): string {
  return view.sort === 'created' ? item.created_at : item.updated_at
}

const collators = new Map<string, Intl.Collator>()

/** Titles as a reader sorts them: case and accents only break ties, numbers as numbers ("Topic 2" before "Topic 10"),
 * like the folders. */
export function collator(lang: string): Intl.Collator {
  let found = collators.get(lang)
  if (!found) {
    found = new Intl.Collator(lang || undefined, { numeric: true, sensitivity: 'base' })
    collators.set(lang, found)
  }
  return found
}

/** A copy of `items` in the view's order. Equal keys fall back to the newest change and the id, so the order never
 * wobbles between two loads. */
export function sortItems(items: ListItem[], view: Pick<ListView, 'sort' | 'direction'>, lang = 'en'): ListItem[] {
  const sign = view.direction === 'asc' ? 1 : -1
  const words = collator(lang)
  const keyed = items.map((item) => ({
    item,
    time: view.sort === 'title' ? 0 : Date.parse(dateOf(item, view)) || 0,
    updated: Date.parse(item.updated_at) || 0,
  }))
  keyed.sort((a, b) => {
    // An untitled note goes last either way.
    if (view.sort === 'title' && !a.item.title !== !b.item.title) return a.item.title ? -1 : 1
    const order = view.sort === 'title' ? words.compare(a.item.title, b.item.title) : a.time - b.time
    if (order !== 0) return order * sign
    if (a.updated !== b.updated) return b.updated - a.updated
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
  })
  return keyed.map((entry) => entry.item)
}

/** Grouping is on when the view says so and the list is sorted by a date (AC-5). */
export function groupsOn(view: ListView): boolean {
  return view.grouped && view.sort !== 'title'
}

/** The sections of a list: "Angeheftet" first when anything is pinned, then the date groups. Without groups the rest is
 * one section: under its own heading "Notizen" after pinned notes, so they stand apart from them (AC-6), else without
 * a heading. */
export function arrange(items: ListItem[], view: ListView, now: Date, lang = 'en'): Section[] {
  const sorted = sortItems(items, view, lang)
  const pinned = sorted.filter((item) => item.pinned)
  const rest = pinned.length ? sorted.filter((item) => !item.pinned) : sorted
  const sections: Section[] = pinned.length ? [{ key: 'pinned', items: pinned }] : []
  if (!groupsOn(view)) {
    if (rest.length) sections.push({ key: pinned.length ? 'notes' : 'all', items: rest })
    return sections
  }
  let current: Section | null = null
  for (const item of rest) {
    const key = dayGroup(dateOf(item, view), now)
    if (!current || current.key !== key) {
      current = { key, items: [] }
      sections.push(current)
    }
    current.items.push(item)
  }
  return sections
}

/** The heading of a section in the page's language; a month of another year names the year. */
export function sectionLabel(key: GroupKey, t: (key: string) => string, lang: string, now: Date): string {
  if (key === 'all') return ''
  if (!key.startsWith('m:')) return t(`noteList.groups.${key}`)
  const [year, month] = key.slice(2).split('-').map(Number)
  const date = new Date(year, month - 1, 1)
  const options: Intl.DateTimeFormatOptions = year === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' }
  return date.toLocaleDateString(lang || undefined, options)
}

/** The time until the next local midnight, for a list that must move its notes from "Heute" to "Gestern" (EC-7). */
export function untilMidnight(now: Date): number {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  return Math.max(1000, tomorrow + 1000 - now.getTime())
}
