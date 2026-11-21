/**
 * The title of a note: at most 120 characters, one line, spaces only count as empty (NOTES-3 EC-5, EC-7). The same
 * rules as the server's (`notedoc.clean_title`, `services/notes.suggest_title`).
 */
import type * as Y from 'yjs'

export const MAX_TITLE = 120
/** Words a suggestion takes at most. */
export const SUGGESTION_WORDS = 8

export function cleanTitle(title: string | null | undefined): string {
  if (!title) return ''
  let text = title.normalize('NFC').replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
  text = text.replace(/\p{Cc}/gu, '')
  text = text.trim()
  const chars = Array.from(text)
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE).join('').trimEnd() : text
}

const SENTENCE_END = /[.!?;,]\s|[.!?;,]$|\s[-–—]\s/

/** A title from the first words of a text: its first line up to the first sentence mark, at most eight words. */
export function suggestTitle(text: string): string {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    let line = cleanTitle(raw)
    if (!line) continue
    const end = SENTENCE_END.exec(line)
    if (end && end.index > 0) line = line.slice(0, end.index)
    return cleanTitle(line.split(' ').slice(0, SUGGESTION_WORDS).join(' '))
  }
  return ''
}

/** Writes the difference between two values of the title field into the shared title, so that someone typing in it at
 * the same time keeps their place. */
export function writeTitle(text: Y.Text, before: string, after: string, origin: unknown): void {
  if (before === after) return
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const gone = before.length - start - end
  const added = after.slice(start, after.length - end)
  text.doc?.transact(() => {
    if (gone > 0) text.delete(start, gone)
    if (added) text.insert(start, added)
  }, origin)
}

/** Where a caret goes when others changed the title around it (a Yjs delta). */
export function mapCaret(caret: number, delta: Array<{ retain?: number; insert?: unknown; delete?: number }>): number {
  let at = 0
  let result = caret
  for (const op of delta) {
    if (op.retain !== undefined) at += op.retain
    else if (typeof op.insert === 'string') {
      if (at <= caret) result += op.insert.length
      at += op.insert.length
    } else if (op.delete !== undefined) {
      if (at < caret) result -= Math.min(op.delete, caret - at)
    }
  }
  return Math.max(0, result)
}
