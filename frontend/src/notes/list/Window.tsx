/**
 * Draws only the part of a list that is on screen, plus some to spare (EC-2). It scrolls with whatever the list lies
 * in (the nearest scrolling parent, else the page) and needs no library: every entry has its height from `layout.ts`.
 *
 * When the entries change while the member is down the list (a note changed on another device, EC-6), the note at the
 * top of the screen stays where it was instead of the list jumping.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { anchorOf, shiftFor, visibleRange, type Anchor, type Entry } from './layout'

/** Without a layout (a page not yet measured, or a test without one): this many entries from the top. */
const UNMEASURED = 400

type Scroller = HTMLElement | Window

function scrollerOf(element: HTMLElement): Scroller {
  let current = element.parentElement
  while (current) {
    const overflow = getComputedStyle(current).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return current
    current = current.parentElement
  }
  return window
}

/** The part of the list on screen, in pixels from its top; null when nothing is measured. */
function viewport(box: HTMLElement, scroller: Scroller, height: number): { from: number; to: number } | null {
  const rect = box.getBoundingClientRect()
  if (height > 0 && rect.height === 0) return null
  if (scroller === window) {
    const from = -rect.top
    return { from, to: from + window.innerHeight }
  }
  const element = scroller as HTMLElement
  const from = element.getBoundingClientRect().top - rect.top
  return { from, to: from + element.clientHeight }
}

function scrollBy(scroller: Scroller, by: number): void {
  if (scroller === window) window.scrollBy(0, by)
  else (scroller as HTMLElement).scrollTop += by
}

type Props = {
  entries: Entry[]
  height: number
  render: (entry: Entry) => ReactNode
}

export function Window({ entries, height, render }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const scroller = useRef<Scroller | null>(null)
  const anchor = useRef<Anchor | null>(null)
  const latest = useRef(entries)
  const [range, setRange] = useState<[number, number]>([0, UNMEASURED])

  const measure = useCallback(() => {
    const element = box.current
    if (!element) return
    scroller.current ??= scrollerOf(element)
    const seen = viewport(element, scroller.current, element.style.height ? parseFloat(element.style.height) : 0)
    if (!seen) {
      anchor.current = null
      setRange((old) => (old[0] === 0 && old[1] === UNMEASURED ? old : [0, UNMEASURED]))
      return
    }
    anchor.current = anchorOf(latest.current, seen.from)
    const next = visibleRange(latest.current, seen.from, seen.to)
    setRange((old) => (old[0] === next[0] && old[1] === next[1] ? old : next))
  }, [])

  // New entries: keep the note at the top of the screen in its place, then draw what is now on screen.
  useLayoutEffect(() => {
    latest.current = entries
    const element = box.current
    if (element && scroller.current && anchor.current) {
      const seen = viewport(element, scroller.current, height)
      if (seen) {
        const shift = shiftFor(anchor.current, entries, seen.from)
        if (shift !== 0) scrollBy(scroller.current, shift)
      }
    }
    measure()
  }, [entries, height, measure])

  useEffect(() => {
    const element = box.current
    if (!element) return
    const target = (scroller.current ??= scrollerOf(element))
    const again = () => measure()
    target.addEventListener('scroll', again, { passive: true })
    window.addEventListener('resize', again)
    return () => {
      target.removeEventListener('scroll', again)
      window.removeEventListener('resize', again)
    }
  }, [measure])

  const [start, end] = range
  return (
    <div ref={box} style={{ position: 'relative', height }} data-testid="note-window">
      {entries.slice(start, Math.min(end, entries.length)).map((entry) => (
        <div key={entry.key} style={{ position: 'absolute', left: 0, right: 0, top: entry.top, height: entry.height }}>
          {render(entry)}
        </div>
      ))}
    </div>
  )
}
