/**
 * What happens when something is dropped on a folder (NOTES-4 AC-3, AC-11): notes go into it; a folder goes into it,
 * or before or after it among its siblings (then the member's order holds from now on). A folder never goes into
 * itself or one of its subfolders (EC-1): such a place does not even accept the drag.
 */
import { problemText } from '../lib/errors'
import { foldersApi } from './api'
import { mayMoveNotes, notesMoved, type Dragged } from './actions'
import { refreshFolders, setFolderOpen, subtreeOf, type TreeState } from './store'
import { showNotice } from './notice'

export type Zone = 'before' | 'into' | 'after'

/** Where over a row the pointer is: the upper and lower quarter are the gaps between folders, the rest the folder. */
export function zoneAt(clientY: number, box: { top: number; height: number }, kind: 'notes' | 'folder'): Zone {
  if (kind === 'notes' || box.height <= 0) return 'into'
  const y = clientY - box.top
  if (y < box.height * 0.25) return 'before'
  if (y > box.height * 0.75) return 'after'
  return 'into'
}

/** Whether the row of `targetId` (`null`: the top) takes this drag in this zone. */
export function accepts(tree: TreeState, dragged: Dragged, targetId: string | null, zone: Zone, inbox = false): boolean {
  if (!dragged) return false
  if (dragged.kind === 'notes') return zone === 'into' && targetId !== null
  if (inbox) return false
  const moving = dragged.ids[0]
  if (!moving || !tree.byId.has(moving)) return false
  const inside = subtreeOf(tree, moving)
  if (zone === 'into') return targetId === null || !inside.has(targetId)
  const target = targetId ? tree.byId.get(targetId) : undefined
  if (!target || target.id === moving) return false
  return target.parent_id === null || !inside.has(target.parent_id)
}

export async function drop(tree: TreeState, dragged: Dragged, targetId: string | null, zone: Zone): Promise<void> {
  if (!dragged) return
  try {
    if (dragged.kind === 'notes') {
      if (!targetId) return
      if (!(await mayMoveNotes(dragged.ids, targetId))) return
      await foldersApi.move(targetId, [], dragged.ids)
      notesMoved(dragged.ids, targetId)
    } else if (zone === 'into') {
      await foldersApi.move(targetId, dragged.ids)
      if (targetId) setFolderOpen(targetId, true)
    } else {
      const target = targetId ? tree.byId.get(targetId) : undefined
      const moving = dragged.ids[0]
      if (!target || !moving) return
      const parent = target.parent_id
      if (tree.byId.get(moving)?.parent_id !== parent) await foldersApi.move(parent, [moving])
      const siblings = (tree.children.get(parent) ?? []).filter((id) => id !== moving)
      const at = siblings.indexOf(target.id) + (zone === 'after' ? 1 : 0)
      siblings.splice(at, 0, moving)
      await foldersApi.order(parent, siblings)
    }
  } catch (problem) {
    showNotice({ text: problemText(problem) })
  } finally {
    await refreshFolders()
  }
}
