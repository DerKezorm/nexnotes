// On or off is a tick everywhere, never a sliding switch beside it (one look for one kind of choice). Read from the
// sources: no component carries the role of a switch or draws its pill, and the row of the settings is a real checkbox.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Toggle } from '../pages/settings/ui'

type Files = {
  readFileSync: (file: string, encoding: string) => string
  readdirSync: (dir: string, options: { recursive: true }) => string[]
}
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

/** What gives a sliding switch away: its role, in JSX, in an object or in a selector, and the pill it is drawn as (a
 * round track 38 px wide, as in the settings once, or a low track 30 to 39 px wide, as in the menu "Ansicht" beside
 * "Hinweise"; a square sign of that width is no pill). */
const SWITCH = [
  /role=\{?["'`]switch["'`]/,
  /role:\s*["'`]switch["'`]/,
  /\[role=["']?switch["']?\]/,
  /\bw-\[38px\][^'"`]*rounded-full|rounded-full[^'"`]*\bw-\[38px\]/,
  /(?<![\w-])h-(?:4|5|6|\[[12]\dpx\])\s[^'"`]*(?<![\w-])w-\[3\dpx\]/,
]

/** The pill of the hints as the menu "Ansicht" drew it until 23.11.2026: the guard must know it. */
const OLD_MENU_PILL = `<span aria-hidden className={'flex h-5 w-[34px] shrink-0 items-center rounded-[10px] p-0.5 ' + (look.hints ? 'justify-end' : 'justify-start')}>`

describe('on and off', () => {
  it('is never a switch anywhere in the sources', () => {
    const sources = files
      .readdirSync('src', { recursive: true })
      .map((name) => name.replace(/\\/g, '/'))
      .filter((name) => /\.(tsx?|css)$/.test(name) && !name.includes('.test.'))
    const found: string[] = []
    for (const name of sources) {
      const lines = files.readFileSync(`src/${name}`, 'utf-8').split('\n')
      lines.forEach((line, at) => {
        if (SWITCH.some((pattern) => pattern.test(line))) found.push(`${name}:${at + 1}: ${line.trim()}`)
      })
    }
    expect(found).toEqual([])
  })

  it('knows the pill of a switch, also the one the menu "Ansicht" had beside "Hinweise"', () => {
    expect(SWITCH.some((pattern) => pattern.test(OLD_MENU_PILL))).toBe(true)
    expect(SWITCH.some((pattern) => pattern.test(`className="rounded-full w-[38px] bg-accent-500"`))).toBe(true)
    // A tick is no switch.
    expect(SWITCH.some((pattern) => pattern.test(`<Check aria-hidden className={'h-4 w-4 shrink-0 ' + (on ? '' : 'invisible')} />`))).toBe(false)
  })

  it('the menu "Ansicht" offers the hints kind by kind as ticked menu entries', () => {
    const menu = files.readFileSync('src/notes/list/ViewMenu.tsx', 'utf-8')
    expect(menu).toContain('role="menuitemcheckbox"')
    expect(menu).toMatch(/HINT_KINDS\.map/)
    expect(menu).not.toMatch(/look\.hints \?/)
  })

  describe('a row of the settings', () => {
    let box: HTMLDivElement
    let root: Root
    beforeEach(() => {
      box = document.createElement('div')
      document.body.append(box)
      root = createRoot(box)
    })
    afterEach(() => {
      act(() => root.unmount())
      box.remove()
    })

    it('is a checkbox with its name, ticked by a click anywhere on the row', () => {
      let value = false
      const draw = () => root.render(<Toggle label="Link previews" hint="Fetch a title" checked={value} onChange={(next) => ((value = next), draw())} testId="row" />)
      act(draw)
      const tick = box.querySelector<HTMLInputElement>('[data-testid="row"]')!
      expect(tick.type).toBe('checkbox')
      expect(tick.getAttribute('role')).toBeNull()
      expect(tick.getAttribute('aria-label')).toBe('Link previews')
      expect(tick.checked).toBe(false)
      act(() => box.querySelector('label')!.click())
      expect(value).toBe(true)
      expect(tick.checked).toBe(true)
    })
  })
})
