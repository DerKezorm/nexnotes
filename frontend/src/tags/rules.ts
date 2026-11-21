/**
 * The rule of a tag (NOTES-5), the same as the server's (`backend/app/services/tags.py`); both read `cases.json` in
 * their tests.
 *
 * - a `#` at the start, after a blank or after an opening bracket or quote; after a letter, a digit or `/` it belongs
 *   to an address or a word and is no tag (EC-1);
 * - then letters, digits, marks, `-`, `_` and emoji (EC-3); `-` and `_` at the end fall away, any other sign ends it;
 * - at least one letter or emoji (`#1` is a number, EC-1), at most `MAX_TAG` characters;
 * - text in inline code or in a link, and code blocks, hold no tags (the editor's plugin leaves them out);
 * - `#Einkauf` and `#einkauf` are one tag (`keyOf`, EC-2).
 *
 * Positions are those of JavaScript strings (UTF-16), as ProseMirror counts.
 */

export const MAX_TAG = 64

const OPENERS = new Set(Array.from('([{"\'„“”‚‘’«»‹›'))
const EMOJI: Array<[number, number]> = [
  [0x200d, 0x200d],
  [0x20e3, 0x20e3],
  [0x2300, 0x23ff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
  [0x1f000, 0x1faff],
  [0xe0020, 0xe007f],
]
const JOINERS = new Set([0x200d, 0x20e3, 0xfe0f])

function isEmoji(code: number): boolean {
  return EMOJI.some(([low, high]) => code >= low && code <= high)
}

function isBlank(char: string): boolean {
  return /^[\p{Z}\t\n\r\v\f]$/u.test(char)
}

/** A character that may stand in a tag. */
export function isTagChar(char: string): boolean {
  return /^[\p{L}\p{M}\p{N}_-]$/u.test(char) || isEmoji(char.codePointAt(0) ?? 0)
}

function isStrong(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return /^\p{L}$/u.test(char) || (isEmoji(code) && !JOINERS.has(code) && !(code >= 0xe0020 && code <= 0xe007f))
}

export type FoundTag = {
  /** Where the `#` stands. */
  start: number
  /** After the last character of the tag. */
  end: number
  /** As written, without `#`, in NFC. */
  label: string
}

/** The tags in a piece of plain text, in order. */
export function findTags(text: string): FoundTag[] {
  const chars = Array.from(text)
  // The UTF-16 offset of every character, and of the end.
  const offsets: number[] = []
  let at = 0
  for (const char of chars) {
    offsets.push(at)
    at += char.length
  }
  offsets.push(at)
  const out: FoundTag[] = []
  let index = 0
  while (index < chars.length) {
    const before = index > 0 ? chars[index - 1] : ''
    if (chars[index] !== '#' || (index > 0 && !isBlank(before) && !OPENERS.has(before))) {
      index++
      continue
    }
    let stop = index + 1
    while (stop < chars.length && isTagChar(chars[stop])) stop++
    let end = stop
    while (end > index + 1 && (chars[end - 1] === '-' || chars[end - 1] === '_')) end--
    const raw = chars.slice(index + 1, end)
    if (raw.length > 0 && raw.length <= MAX_TAG && raw.some(isStrong)) {
      out.push({ start: offsets[index], end: offsets[end], label: raw.join('').normalize('NFC') })
    }
    index = Math.max(stop, index + 1)
  }
  return out
}

/** What makes two spellings one tag: case does not count (EC-2). The same as the server's `key_of`. */
export function keyOf(label: string): string {
  return label.normalize('NFC').toLowerCase()
}

/** A name as typed, with or without `#`; empty when it is no tag. */
export function cleanName(name: string): string {
  let value = name.trim().normalize('NFC')
  if (value.startsWith('#')) value = value.slice(1)
  const found = findTags('#' + value)
  return found.length === 1 && found[0].end === value.length + 1 ? found[0].label : ''
}

/** The address of a tag's page. */
export function tagHref(label: string): string {
  return `/tags/${encodeURIComponent(label)}`
}

/** The tag being typed right before the caret (`text` is the text of the block up to the caret): what the
 * suggestions complete, from just `#` on. `null` when the caret is not in one. */
export function typedTag(text: string): { start: number; prefix: string } | null {
  const hash = text.lastIndexOf('#')
  if (hash < 0) return null
  const before = hash > 0 ? Array.from(text.slice(0, hash)).pop() ?? '' : ''
  if (hash > 0 && !isBlank(before) && !OPENERS.has(before)) return null
  const rest = Array.from(text.slice(hash + 1))
  if (rest.length > MAX_TAG || !rest.every(isTagChar)) return null
  return { start: hash, prefix: rest.join('') }
}
