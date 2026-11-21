/**
 * The words of the small marks a row or tile carries (NOTES-6 AC-2, AC-3, AC-7, AC-9): checklist progress, who a note
 * is shared with or whose it is, pictures and scans, tags. Every text from a note or a person goes on the page as text,
 * never as HTML (EC-5): React writes it so, and nothing here builds markup.
 */
import { colorOf } from '../../folders/palette'
import type { ListItem, ListTag } from './api'

type T = (key: string, values?: Record<string, unknown>) => string

export function tagName(tag: ListTag): string {
  return typeof tag === 'string' ? tag : tag.name
}

/** "#einkauf #urlaub", or empty when the tags feature sent none. */
export function tagsText(item: ListItem): string {
  return (item.tags ?? []).map((tag) => `#${tagName(tag)}`).join(' ')
}

/** "3 von 8" for a note with checklists. */
export function tasksText(item: ListItem, t: T): string {
  return item.tasks && item.tasks.total > 0 ? t('noteList.tasks', { done: item.tasks.done, total: item.tasks.total }) : ''
}

/** "von Lena" for a note of somebody else, "geteilt mit Anna" or "geteilt mit 2" for one of the account's own. */
export function sharedText(item: ListItem, t: T): string {
  if (item.owner) return t('noteList.sharedFrom', { name: item.owner.name })
  const shared = item.shared
  if (!shared) return ''
  if (shared === true) return t('noteList.shared')
  const names = shared.names ?? []
  if (names.length === 1) return t('noteList.sharedWith', { name: names[0] })
  const count = shared.count ?? names.length
  return count > 0 ? t('noteList.sharedCount', { count }) : t('noteList.shared')
}

/** "2 Fotos", "Scan · Text erkannt", "1 Skizze". */
export function mediaText(item: ListItem, t: T): string {
  const media = item.media
  if (!media || media.count < 1) return ''
  if (media.kind === 'scan' && media.text) return t('noteList.media.scanText', { count: media.count })
  return t(`noteList.media.${media.kind}`, { count: media.count })
}

/** The CSS color of a note's mark; empty for a note without one. */
export function noteColor(item: ListItem): string {
  return item.color ? colorOf(item.color) : ''
}
