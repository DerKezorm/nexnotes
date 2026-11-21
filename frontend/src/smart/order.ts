import { showNotice } from '../folders/notice'
import { problemText } from '../lib/errors'
import { smartApi } from './api'
import { refreshSmartFolders, showOrder } from './store'

/** The ids of the smart folders in the order after moving `id` to the place of `target` (AC-8: dragging one onto
 * another puts it there; down the list it lands after the target, up the list before it). */
export function moved(ids: string[], id: string, target: string): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids
  const rest = ids.filter((item) => item !== id)
  const at = rest.indexOf(target) + (ids.indexOf(id) < ids.indexOf(target) ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The ids after moving `id` one place up (`-1`) or down (`1`); the same ids when it is already at that end. */
export function stepped(ids: string[], id: string, by: -1 | 1): string[] {
  const next = ids.indexOf(id) + by
  if (!ids.includes(id) || next < 0 || next >= ids.length) return ids
  return moved(ids, id, ids[next])
}

/** The new order shown at once, then kept on the server (AC-8); a refusal is said and the server's order comes back. */
export function keepOrder(ids: string[]): void {
  showOrder(ids)
  smartApi
    .order(ids)
    .catch((error) => {
      showNotice({ text: problemText(error) })
    })
    .finally(() => void refreshSmartFolders())
}
