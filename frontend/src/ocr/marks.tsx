/** What the large view marks and how often it asks (NOTES-11). */
import type { ReactNode } from 'react'

import type { Jump } from '../search/api'

/** How often the view asks again while pages are still read. */
export const ASK_EVERY_MS = 3000

/** The text with the `nth` occurrence of the jump's text marked (AC-8). */
export function marked(text: string, mark: Jump | null): ReactNode[] {
  if (!mark || !mark.text) return [text]
  let at = -1
  for (let count = 0; count <= mark.nth; count++) {
    at = text.indexOf(mark.text, at + 1)
    if (at < 0) break
  }
  if (at < 0) at = text.indexOf(mark.text)
  if (at < 0) return [text]
  return [
    text.slice(0, at),
    <mark key="hit" data-testid="ocr-mark" className="rounded-[3px] px-0.5 text-inherit" style={{ background: 'rgb(242 193 78 / 0.3)' }}>
      {text.slice(at, at + mark.text.length)}
    </mark>,
    text.slice(at + mark.text.length),
  ]
}
