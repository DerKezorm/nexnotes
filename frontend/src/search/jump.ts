/**
 * From a hit to its place in the note (AC-5). The hit says what it found as written and the how-manieth of its kind it
 * is (`Jump`); once the editor shows the note's text, the place is scrolled into the middle and marked for a moment.
 *
 * It watches the page rather than the editor, so nothing in the editor has to know about the search: the editor's
 * text loads over the live connection a moment after the page opened.
 */
import type { Jump } from './api'

/** The editor's text. */
const EDITOR = '.ProseMirror'
/** How long the search waits for the note's text before it gives up. */
export const JUMP_WAIT_MS = 8000
/** How long the place stays marked. */
export const MARK_MS = 4000
export const HIGHLIGHT_NAME = 'nexnotes-search'

type Found = { range: Range; element: HTMLElement }

let stopRunning: (() => void) | null = null

/** The `nth` occurrence of `text` in the text of `root`, as a range over its text nodes. */
export function findInText(root: Element, text: string, nth: number): Found | null {
  if (!text) return null
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let all = ''
  const starts: number[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(all.length)
    all += (node as Text).data
  }
  let at = -1
  for (let count = 0; count <= nth; count++) {
    at = all.indexOf(text, at + 1)
    if (at < 0) break
  }
  // Fewer of them than the server counted (a block break between): the first one is near enough.
  if (at < 0) at = all.indexOf(text)
  if (at < 0) return null
  const end = at + text.length
  const locate = (offset: number, isEnd: boolean): [Text, number] => {
    for (let index = nodes.length - 1; index >= 0; index--) {
      if (isEnd ? starts[index] < offset : starts[index] <= offset) return [nodes[index], offset - starts[index]]
    }
    return [nodes[0], 0]
  }
  const [startNode, startOffset] = locate(at, false)
  const [endNode, endOffset] = locate(end, true)
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return { range, element: startNode.parentElement ?? (root as HTMLElement) }
}

type Highlights = { set: (name: string, value: unknown) => void; delete: (name: string) => void }

function mark(found: Found): void {
  found.element.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight
  if (highlights && Highlight) {
    highlights.set(HIGHLIGHT_NAME, new Highlight(found.range))
    window.setTimeout(() => highlights.delete(HIGHLIGHT_NAME), MARK_MS)
  } else {
    found.element.setAttribute('data-search-hit', '')
    window.setTimeout(() => found.element.removeAttribute('data-search-hit'), MARK_MS)
  }
}

/** Waits for the note's text and puts the hit in view. A new jump replaces one still waiting. */
export function jumpToHit(jump: Jump | null | undefined): void {
  stopRunning?.()
  if (!jump?.text) return
  const look = (): boolean => {
    for (const editor of Array.from(document.querySelectorAll(EDITOR))) {
      const found = findInText(editor, jump.text, jump.nth)
      if (found) {
        mark(found)
        return true
      }
    }
    return false
  }
  if (look()) return
  const observer = new MutationObserver(() => {
    if (look()) stop()
  })
  const timer = window.setTimeout(() => stop(), JUMP_WAIT_MS)
  const stop = () => {
    observer.disconnect()
    window.clearTimeout(timer)
    if (stopRunning === stop) stopRunning = null
  }
  stopRunning = stop
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}
