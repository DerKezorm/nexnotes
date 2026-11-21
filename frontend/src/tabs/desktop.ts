/**
 * Tabs and two notes side by side are for wider screens (NOTES-8); on a phone one note at a time and no tabs, as
 * before (Out of Scope, NOTES-23). The line is the app's own `md` (768 px), where the sidebar stays on screen.
 */
import { useSyncExternalStore } from 'react'

export const DESKTOP_QUERY = '(min-width: 768px)'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DESKTOP_QUERY) : null
}

export function isDesktop(): boolean {
  return query()?.matches ?? false
}

export function useDesktop(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = query()
      list?.addEventListener('change', listener)
      return () => list?.removeEventListener('change', listener)
    },
    isDesktop,
  )
}

/** Apple's keyboards name the keys by their signs. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}
