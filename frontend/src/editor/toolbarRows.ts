/** How the toolbar lays out its tools (NOTES-3 AC-3, EC-11): groups in one row, or two, never broken inside a group. */

/** The width of a tool with its gap, of the text style with the line after it, and of the line between two groups. */
export const TOOL_WIDTH = 38
export const STYLE_WIDTH = 160
export const GROUP_LINE = 17
/**
 * The tools in their groups (NOTES-3 AC-3): text style | bold … highlighter | lists | table, link | quote, code |
 * indenting, divider | undo, redo | text width, outline. A row breaks only between two groups, never inside one.
 */
export const TOOL_GROUPS: string[][] = [
  ['style'],
  ['bold', 'italic', 'underline', 'strike', 'highlight'],
  ['bullet', 'ordered', 'task'],
  ['table', 'link'],
  ['quote', 'code'],
  ['indent', 'outdent', 'divider'],
  ['undo', 'redo'],
  ['width', 'outline'],
]

/** How wide a group is in the row (the text style is a field, the rest are tools). */
export function groupWidth(group: string[]): number {
  return group.reduce((sum, key) => sum + (key === 'style' ? STYLE_WIDTH - GROUP_LINE : TOOL_WIDTH), 0)
}

/**
 * The groups in one row while they fit, else in two: each row takes whole groups as long as they fit (second
 * review: two rows rather than "More"). Only what not even two rows hold goes into "More" (`rest`, whole groups from
 * the end; the second row then keeps room for the "More" button), and of those the first `extra` tools still stand at
 * the end of the second row where they fit, before "More". No group fits at all (a very narrow side): no rows,
 * everything is `rest`. Unknown width (no layout yet) counts as wide.
 */
export function toolRows(widths: number[], room: number, more = TOOL_WIDTH): { rows: number[][]; rest: number[]; extra: number } {
  const all = widths.map((_, index) => index)
  const need = (indices: number[]) => indices.reduce((sum, index, at) => sum + widths[index] + (at > 0 ? GROUP_LINE : 0), 0)
  if (room <= 0 || need(all) <= room) return { rows: [all], rest: [], extra: 0 }
  const fill = (from: number, space: number) => {
    let to = from
    while (to < all.length && need(all.slice(from, to + 1)) <= space) to++
    return to
  }
  const first = fill(0, room)
  if (first === 0) return { rows: [], rest: all, extra: 0 }
  if (need(all.slice(first)) <= room) return { rows: [all.slice(0, first), all.slice(first)], rest: [], extra: 0 }
  // The second row holds what fits beside "More"; nothing beside it: "More" alone in the second row.
  const second = fill(first, room - more - GROUP_LINE)
  const rest = all.slice(second)
  const left = room - more - (second > first ? need(all.slice(first, second)) + GROUP_LINE : 0)
  const tools = rest.reduce((sum, index) => sum + Math.round(widths[index] / TOOL_WIDTH), 0)
  return { rows: [all.slice(0, first), all.slice(first, second)], rest, extra: Math.min(tools, Math.max(0, Math.floor(left / TOOL_WIDTH))) }
}
