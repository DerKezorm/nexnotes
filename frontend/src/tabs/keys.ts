/**
 * Tabs and sides by keyboard (NOTES-8 EC-7), with Alt and Shift (⌥⇧ on a Mac): the browser keeps Ctrl+1 to 8, Ctrl+W
 * and Ctrl+Tab for its own tabs, and Ctrl+Alt is AltGr on a German keyboard, where it types braces.
 *
 * - 1 to 6: that tab
 * - → and ←: the next and the previous tab
 * - S: the other side
 * - W: closes the tab
 *
 * Read from `event.code`, so that the shifted digits of any keyboard layout count.
 */
import { closeFocusedTab, nthTab, otherSide, stepTab } from './open'

export type TabCommand = { kind: 'nth'; index: number } | { kind: 'step'; step: 1 | -1 } | { kind: 'side' } | { kind: 'close' }

export function tabCommand(event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code'>): TabCommand | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null
  const digit = /^(?:Digit|Numpad)([1-6])$/.exec(event.code)
  if (digit) return { kind: 'nth', index: Number(digit[1]) - 1 }
  if (event.code === 'ArrowRight') return { kind: 'step', step: 1 }
  if (event.code === 'ArrowLeft') return { kind: 'step', step: -1 }
  if (event.code === 'KeyS') return { kind: 'side' }
  if (event.code === 'KeyW') return { kind: 'close' }
  return null
}

export function runTabCommand(command: TabCommand): void {
  if (command.kind === 'nth') nthTab(command.index)
  else if (command.kind === 'step') stepTab(command.step)
  else if (command.kind === 'side') otherSide()
  else closeFocusedTab()
}

/** Listens while the tabs are on the page; before the editor, so that ⌥⇧ never types a sign into the note. */
export function listenForTabKeys(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return
    const command = tabCommand(event)
    if (!command) return
    event.preventDefault()
    event.stopPropagation()
    runTabCommand(command)
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
