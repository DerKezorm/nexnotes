/**
 * The groups of a list folded shut (Angeheftet, Heute, Gestern, a month ...): per list and per device, in the
 * browser's storage. A storage that cannot be read or written (a private window) folds for the page's life only.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'

const KEY = 'nexnotes:list-collapsed'
/** Never more than this many folded groups are kept; the oldest go first. */
const KEEP = 400

let shut: string[] | null = null
const listeners = new Set<() => void>()

function read(): string[] {
  if (shut) return shut
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    shut = Array.isArray(kept) ? kept.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    shut = []
  }
  return shut
}

function write(next: string[]): void {
  shut = next.slice(-KEEP)
  try {
    localStorage.setItem(KEY, JSON.stringify(shut))
  } catch {
    // Kept for this page only.
  }
  for (const listener of [...listeners]) listener()
}

const name = (list: string, section: string) => `${list}|${section}`

/** Folds a group of a list shut, or opens it again. */
export function setCollapsed(list: string, section: string, collapsed: boolean): void {
  const key = name(list, section)
  const rest = read().filter((entry) => entry !== key)
  write(collapsed ? [...rest, key] : rest)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The groups of the list `list` that are folded shut, and how to fold one. */
export function useCollapsed(list: string): { collapsed: ReadonlySet<string>; toggle: (section: string) => void } {
  const all = useSyncExternalStore(subscribe, read, read)
  const collapsed = useMemo(() => {
    const prefix = `${list}|`
    return new Set(all.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)))
  }, [all, list])
  const toggle = useCallback((section: string) => setCollapsed(list, section, !read().includes(name(list, section))), [list])
  return { collapsed, toggle }
}

/** For tests: nothing folded, and the storage read anew. */
export function forgetCollapsed(): void {
  shut = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to forget.
  }
}
