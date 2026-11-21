/**
 * A phone or a touch screen (the app's own line for a finger's size, NOTES-23 AC-7: `styles/index.css`): compact rows
 * and group headings of the lists are a finger high there.
 */
import { useSyncExternalStore } from 'react'

export const TOUCH_QUERY = '(max-width: 767px), (pointer: coarse)'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH_QUERY) : null
}

function isTouch(): boolean {
  return query()?.matches ?? false
}

export function useTouch(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = query()
      list?.addEventListener('change', listener)
      return () => list?.removeEventListener('change', listener)
    },
    isTouch,
    () => false,
  )
}
