/** The ids of the smart folders in the order after moving `id` to the place of `target` (AC-8: dragging one onto
 * another puts it there; down the list it lands after the target, up the list before it). */
export function moved(ids: string[], id: string, target: string): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids
  const rest = ids.filter((item) => item !== id)
  const at = rest.indexOf(target) + (ids.indexOf(id) < ids.indexOf(target) ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}
