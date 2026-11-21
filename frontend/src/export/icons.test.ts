/**
 * NOTES-17 AC-2: the PDF of a note shows its symbol before the title, drawn as the page draws it. The server has no
 * lucide; it reads the drawings from `backend/app/export_icons.json`, which this test writes from the same icons the
 * page uses (`WRITE_ICONS=1 npx vitest run src/export/icons.test.ts`) and otherwise compares, so a changed symbol cannot
 * leave the PDF behind.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SYMBOLS } from '../lib/symbols'

type Files = {
  readFileSync: (file: string, encoding: string) => string
  writeFileSync: (file: string, data: string, encoding: string) => void
}
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as Files
const FILE = '../backend/app/export_icons.json'

function drawings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of SYMBOLS) {
    // The look of the page's symbols (NoteIcon): stroke 2, the colour of the text, which the PDF puts in.
    const markup = renderToStaticMarkup(createElement(entry.icon, { size: 24, strokeWidth: 2, color: 'currentColor' }))
    out[entry.name] = markup.replace(/ class="[^"]*"/, '').replace(' aria-hidden="true"', '')
  }
  return out
}

describe('NOTES-17 AC-2 the symbols in the PDF', () => {
  it('NOTES-17 AC-2 the server draws every symbol as the page does', () => {
    const wanted = drawings()
    const text = JSON.stringify(wanted, null, 1) + '\n'
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
    if (env.WRITE_ICONS) fs.writeFileSync(FILE, text, 'utf-8')
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Record<string, string>
    expect(Object.keys(stored).sort()).toEqual(SYMBOLS.map((entry) => entry.name).sort())
    expect(stored).toEqual(wanted)
    for (const svg of Object.values(stored)) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain('stroke="currentColor"')
    }
  })
})
