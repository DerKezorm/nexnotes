/**
 * What was shared from another app becomes a note (NOTES-23 AC-5): the link, the text and the files as Markdown in the
 * server's format ("nexnotes-doc 1", `notedoc/markdown.py`), the suggested title, where it came from. Pure functions,
 * so the page and the tests share them.
 */
import { cleanTitle, suggestTitle } from '../../editor/title'

/** What the service worker took from the share target's form (`public/sw.js`, `readShare`). */
export type Shared = { title: string; text: string; url: string; files: File[] }

/** A file of the note to be: its attachment id (made here, NOTES-10) and whether it shows as a picture. */
export type SharedFile = { id: string; name: string; picture: boolean }

const LINK = /^https?:\/\/\S+$/i
const TRAILING_LINK = /(?:^|\s)(https?:\/\/\S+)\s*$/i

/** The link and the text of a share. Many apps send the address inside the text ("Title https://…") and none in
 * `url`: then the address at its end is the link, and the text is what stands before it. */
export function splitShared(shared: Pick<Shared, 'text' | 'url'>): { link: string; text: string } {
  const text = shared.text.trim()
  if (shared.url && LINK.test(shared.url)) {
    const rest = text === shared.url ? '' : text.endsWith(shared.url) ? text.slice(0, -shared.url.length).trim() : text
    return { link: shared.url, text: rest }
  }
  if (LINK.test(text)) return { link: text, text: '' }
  const found = TRAILING_LINK.exec(text)
  if (found) return { link: found[1], text: text.slice(0, found.index).trim() }
  return { link: '', text }
}

export function hostOf(link: string): string {
  try {
    return new URL(link).host
  } catch {
    return ''
  }
}

/** The suggested title (AC-5, a must): what the other app called it, else the first words of the text (the rule of
 * NOTES-3), else the first file's name without its ending, else the link's site. */
export function suggestShareTitle(shared: Pick<Shared, 'title' | 'files'>, link: string, text: string): string {
  const given = cleanTitle(shared.title)
  if (given && given !== link) return given
  const words = suggestTitle(text)
  if (words) return words
  const file = shared.files[0]?.name ?? ''
  const named = cleanTitle(file.replace(/\.[A-Za-z0-9]{1,8}$/, ''))
  if (named) return named
  return cleanTitle(hostOf(link))
}

const ESCAPE = /([\\`*_[\]<~|])/g
const LINE_START = /^(\s*)(#{1,6}(?=[ \t]|$)|>|-|\+|=|\d+[.)])/
const ENTITY = /&(?=[A-Za-z0-9#]+;)/g

/** Text as it stands, never read as Markdown: the same marks the server escapes (`markdown._escape`). */
export function escapeText(text: string, lineStart = false): string {
  let out = text.replace(ESCAPE, '\\$1').replace(ENTITY, '\\&')
  if (lineStart) {
    const match = LINE_START.exec(out)
    if (match) {
      const [, lead, mark] = match
      const marked = /\d/.test(mark[0]) ? mark.slice(0, -1) + '\\' + mark.slice(-1) : '\\' + mark
      out = lead + marked + out.slice(match[0].length)
    }
  }
  return out
}

/** Every line of a text escaped; empty lines stay, so paragraphs stay paragraphs. */
function escapeLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => escapeText(line, true))
}

function destination(href: string): string {
  return href.replace(/([()\\<>])/g, '\\$1')
}

/** The note's text: the link on a line of its own, the shared text, the member's own words, then each file as a
 * block that names its attachment (`![name](attachment:<id>)` for a picture, `[name](attachment:<id>)` else). */
export function shareMarkdown(parts: { link: string; text: string; note: string; files: SharedFile[] }): string {
  const blocks: string[] = []
  if (parts.link) blocks.push(`[${escapeText(parts.link)}](${destination(parts.link)})`)
  if (parts.text.trim()) blocks.push(escapeLines(parts.text.trim()).join('\n'))
  if (parts.note.trim()) blocks.push(escapeLines(parts.note.trim()).join('\n'))
  for (const file of parts.files) blocks.push(`${file.picture ? '!' : ''}[${escapeText(file.name)}](attachment:${file.id})`)
  return blocks.join('\n\n')
}

/** Where the note came from (NOTES-4 AC-7): Android names no app to the page, so the system is the source. */
export function shareOrigin(agent: string): string {
  return /Android/i.test(agent) ? 'share:Android' : 'share'
}
