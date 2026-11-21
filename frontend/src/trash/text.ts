/** What a row of the trash says besides its title: where it came from and lands, and the time left. */
import type { TrashItem } from './api'

type Say = (key: string, values?: Record<string, unknown>) => string

/** The second line: where it came from and, when that is gone, where it lands (EC-1); orange then. */
export function originLine(item: TrashItem, t: Say): { text: string; warn: boolean } {
  const name = item.origin?.name ?? ''
  let text: string
  if (item.origin_gone) {
    const where = item.kind === 'note' ? 'Inbox' : 'Top'
    text = name ? t(`trash.fromGoneTo${where}`, { name }) : t(`trash.goneTo${where}`)
  } else if (!item.origin) text = t('trash.fromTop')
  else if (item.origin.inbox) text = t('trash.fromInbox')
  else text = t('trash.from', { name })
  if (item.deleted_by) text = `${t('trash.deletedBy', { name: item.deleted_by.name })}, ${text}`
  return { text, warn: item.origin_gone }
}

/** "noch 41 Tage", "noch 1 Tag", and on the last day that it goes today. */
export function leftText(item: TrashItem, t: Say): string {
  return item.days_left > 0 ? t('trash.left', { count: item.days_left }) : t('trash.lastDay')
}
