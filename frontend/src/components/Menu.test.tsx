/** The one menu of the app: over everything, outside any box that scrolls, upward where there is no room below. */
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Menu, menuPlace, usePlaceInside } from './Menu'

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
})

describe('the menu', () => {
  it('hangs on the page itself, outside the box that scrolls, and keyboard and Escape work there', () => {
    const scroller = document.createElement('div')
    scroller.style.overflow = 'auto'
    scroller.className = 'overflow-x-auto'
    const button = document.createElement('button')
    scroller.append(button)
    document.body.append(scroller)
    const closed = vi.fn()
    act(() =>
      root.render(
        <Menu anchor={button} onClose={closed} label="Actions">
          <button type="button" role="menuitem">One</button>
          <button type="button" role="menuitem">Two</button>
        </Menu>,
      ),
    )
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.parentElement).toBe(document.body)
    expect(scroller.contains(menu)).toBe(false)
    expect(menu.closest('.overflow-x-auto')).toBeNull()
    expect(menu.className).toContain('fixed')
    expect(document.activeElement?.textContent).toBe('One')
    act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement?.textContent).toBe('Two')
    act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(closed).toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    scroller.remove()
  })

  it('opens below, upward when there is no room below, and never leaves the window', () => {
    const view = { width: 1280, height: 800 }
    const size = { width: 240, height: 300 }
    expect(menuPlace({ left: 1000, right: 1032, top: 100, bottom: 132 }, size, view, 'end')).toEqual({ left: 792, top: 136, up: false })
    expect(menuPlace({ left: 1000, right: 1032, top: 700, bottom: 732 }, size, view, 'end')).toEqual({ left: 792, top: 396, up: true })
    // A phone: no room for it beside the button at the right edge, so it stays inside the window.
    expect(menuPlace({ left: 350, right: 382, top: 100, bottom: 132 }, size, { width: 390, height: 844 }, 'start').left).toBe(390 - 240 - 8)
    // Too tall for above and below: still inside the window.
    expect(menuPlace({ left: 10, right: 40, top: 300, bottom: 330 }, { width: 200, height: 780 }, view, 'start')).toEqual({ left: 10, top: 12, up: false })
  })

  it('a menu opened at a point low on the screen goes upward from the point', () => {
    const view = { width: 1920, height: 1080 }
    const point = { left: 600, right: 600, top: 1000, bottom: 996 }
    expect(menuPlace(point, { width: 248, height: 420 }, view, 'start')).toEqual({ left: 600, top: 576, up: true })
    // Near the right edge too: moved left, still at the point's height.
    expect(menuPlace({ ...point, left: 1900, right: 1900 }, { width: 248, height: 420 }, view, 'start').left).toBe(1920 - 248 - 8)
  })
})

/** jsdom lays nothing out: a menu is 30 px per entry and 248 px wide, the window 1080 px high. */
function laidOut(): () => void {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  const tall = window.innerHeight
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? this.querySelectorAll('[role="menuitem"]').length * 30 : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? 248 : 0
    },
  })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 })
  return () => {
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: tall })
  }
}

const entries = (count: number) =>
  Array.from({ length: count }, (_, index) => (
    <button key={index} type="button" role="menuitem">
      Entry {index}
    </button>
  ))

describe('the menu stays inside the window when it grows', () => {
  it('placed again once the entries that come later are there (a note low in the list)', async () => {
    const back = laidOut()
    try {
      const point = { x: 400, y: 1000 }
      await act(async () =>
        root.render(
          <Menu anchor={point} onClose={() => undefined} label="Note" align="start" width={248}>
            {entries(2)}
          </Menu>,
        ),
      )
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!
      // Two entries, 60 px: room below the point.
      expect(menu.style.top).toBe('1000px')
      await act(async () =>
        root.render(
          <Menu anchor={point} onClose={() => undefined} label="Note" align="start" width={248}>
            {entries(14)}
          </Menu>,
        ),
      )
      // Fourteen, 420 px: upward from the point, wholly inside the window.
      const top = parseFloat(menu.style.top)
      expect(top).toBe(1000 - 4 - 420)
      expect(top + 420).toBeLessThanOrEqual(1080)
      expect(menu.dataset.up).toBe('true')
    } finally {
      back()
    }
  })
})

function Hanging({ open, count }: { open: boolean; count: number }) {
  const panel = useRef<HTMLDivElement>(null)
  const place = usePlaceInside(panel, open)
  return (
    <div data-testid="parent" style={{ position: 'relative' }}>
      {open && (
        <div ref={panel} role="menu" style={place.style} data-up={place.up || undefined}>
          {entries(count)}
        </div>
      )}
    </div>
  )
}

describe('a menu that hangs off another element (the selection bar)', () => {
  it('stands below its parent, above it low on the screen, as left and top within the parent', async () => {
    const back = laidOut()
    const rect = HTMLElement.prototype.getBoundingClientRect
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    let parentTop = 100
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset.testid === 'parent') return { left: 300, right: 700, top: parentTop, bottom: parentTop + 40, width: 400, height: 40, x: 300, y: parentTop, toJSON: () => ({}) } as DOMRect
      return rect.call(this)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'menu' ? this.parentElement : null
      },
    })
    try {
      await act(async () => root.render(<Hanging open count={6} />))
      const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
      expect([menu().style.left, menu().style.top, menu().dataset.up]).toEqual(['0px', '44px', undefined])
      await act(async () => root.render(<Hanging open={false} count={6} />))
      parentTop = 1000
      await act(async () => root.render(<Hanging open count={6} />))
      // 180 px high: no room below 1040, so above the parent.
      expect([menu().style.top, menu().dataset.up]).toEqual([`${-4 - 180}px`, 'true'])
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
      back()
    }
  })
})
