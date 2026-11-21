/** The words for how a list is sorted, grouped and drawn: the line under its heading. */
import type { ListView } from './api'
import type { ListLook } from './look'

type T = (key: string, values?: Record<string, unknown>) => string

/** "Titel A–Z", "Titel Z–A", or the date sorted by. */
export function sortName(view: Pick<ListView, 'sort' | 'direction'>, t: T): string {
  if (view.sort === 'title') return t(view.direction === 'desc' ? 'noteList.sort.titleDesc' : 'noteList.sort.title')
  return t(`noteList.sort.${view.sort}`)
}

/** The line under the heading: how the list is sorted, grouped and drawn ("Zuletzt geändert · nach Datum gruppiert"). */
export function viewSummary(view: ListView, look: ListLook, t: T, gallery = false): string {
  if (gallery) return t('noteList.view.gallery')
  const parts = [sortName(view, t)]
  if (view.sort !== 'title' && view.direction === 'asc') parts.push(t('noteList.sort.asc'))
  if (view.grouped && view.sort !== 'title') parts.push(t('noteList.state.grouped'))
  if (look.style !== 'list') parts.push(t(`noteList.style.${look.style}`))
  return parts.join(' · ')
}
