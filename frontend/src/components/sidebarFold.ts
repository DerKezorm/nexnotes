/**
 * The sidebar folded away beside the notes (24.11.2026): on a wider screen with the tabs, "Hide sidebar" in the list's
 * head (or in the list's strip while the list is folded) leaves a narrow strip at the left edge that brings it back.
 * With the list folded too the note has the whole width. Kept on this device as `sidebar`; only the notes page with
 * tabs folds it, every other page shows the sidebar as always.
 */
import { createContext, useEffect, useSyncExternalStore } from 'react'

import { useDevicePref } from '../lib/devicePref'

let holders = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** The notes page with tabs is on show: while it is, the sidebar may be folded away. */
export function useSidebarFoldable(): void {
  useEffect(() => {
    holders += 1
    emit()
    return () => {
      holders -= 1
      emit()
    }
  }, [])
}

/** Whether the sidebar is folded away on this device, and how to change it. */
export function useSidebarHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, set] = useDevicePref('sidebar', (raw) => raw === 'off')
  return [hidden, (next) => set(next ? 'off' : null)]
}

/** For the frame: the sidebar is folded away right now. */
export function useSidebarFolded(): boolean {
  const foldable = useSyncExternalStore(subscribe, () => holders > 0)
  const [hidden] = useSidebarHidden()
  return foldable && hidden
}

/** For the list's head beside the notes: whether the sidebar is folded away, and the button that folds or brings it
 * back. Elsewhere (a phone, the drawer) null: no button. */
export const SidebarFoldContext = createContext<{ hidden: boolean; toggle: () => void } | null>(null)
