/** The mark "note with bolt" in both looks of the app, and the wordmark NEX/NOTES (design system "Logo und Name"). */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Logo, LOGO_COLORS, LogoMark } from './Logo'

let root: Root
let box: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  document.documentElement.removeAttribute('data-theme')
})

const part = (name: string) => box.querySelector(`[data-part="${name}"]`)!

describe('the logo', () => {
  it('draws the mark in the colors of the look the app shows, and follows a switch', async () => {
    act(() => root.render(<LogoMark size={44} />))
    expect(box.querySelector('svg')!.dataset.look).toBe('dark')
    expect(part('tile').getAttribute('fill')).toBe('#16120a')
    expect(part('bolt').getAttribute('fill')).toBe('#f5c445')
    expect(part('bolt').getAttribute('stroke')).toBe('#16120a')
    expect([...box.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color'))).toEqual([...LOGO_COLORS.dark.gradient])
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light')
      await Promise.resolve()
    })
    expect(part('tile').getAttribute('fill')).toBe('#ffffff')
    expect(part('bolt').getAttribute('fill')).toBe('#b8740a')
    expect(part('bolt').getAttribute('stroke')).toBe('#ffffff')
    expect([...box.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color'))).toEqual(['#f5cf63', '#d9a21b', '#8a5a06'])
    expect(part('lines')).not.toBeNull()
  })

  it('leaves out the two lines below 32 px and draws the note in one tone', () => {
    act(() => root.render(<LogoMark size={26} />))
    expect(box.querySelector('[data-part="lines"]')).toBeNull()
    expect(part('note').getAttribute('stroke')).toBe(LOGO_COLORS.dark.gradient[1])
    expect(box.querySelector('linearGradient')).toBeNull()
    expect(part('bolt')).not.toBeNull()
  })

  it('writes the name as NEX in the text color and NOTES in honey', () => {
    act(() => root.render(<Logo withWordmark />))
    const mark = box.querySelector('[data-testid="wordmark"]')!
    expect(mark.getAttribute('aria-label')).toBe('nexnotes')
    const [nex, notes] = [...mark.children] as HTMLElement[]
    expect(nex.textContent).toBe('NEX')
    expect(notes.textContent).toBe('NOTES')
    expect(mark.className).toContain('text-mist-100')
    expect(notes.className).toBe('nn-wordmark-accent')
  })
})
