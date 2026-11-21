/**
 * The folder tree of the signed-in account, shared by the sidebar, the pages and the dialogs: loaded once, asked again
 * after every change and whenever the window comes back to the front (another device may have moved, renamed or
 * colored something meanwhile; order, symbol and color live on the server, NOTES-4 AC-10, AC-11).
 *
 * Which folders are open in the sidebar is the browser's own (AC-6): `localStorage`, never the server.
 *
 * The open folder (`useCurrentFolder`) says where a new note lands (AC-9): in the open folder, otherwise in the inbox.
 * The note editor reads it; pages that are not a folder leave it empty.
 */
import { useEffect, useSyncExternalStore } from 'react'

import { onAccountChange } from '../state/account'
import { foldersApi, type Folder, type FolderTree } from './api'

export type TreeState = {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  inbox: { id: string; count: number } | null
  folders: Folder[]
  byId: Map<string, Folder>
  /** The children of each folder (`null`: the top), in the sidebar's order. */
  children: Map<string | null, string[]>
}

function build(tree: FolderTree | null, status: TreeState['status']): TreeState {
  const folders = tree?.folders ?? []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const children = new Map<string | null, string[]>()
  for (const folder of folders) {
    const parent = folder.parent_id !== null && byId.has(folder.parent_id) ? folder.parent_id : null
    const list = children.get(parent) ?? []
    list.push(folder.id)
    children.set(parent, list)
  }
  return { status, inbox: tree?.inbox ?? null, folders, byId, children }
}

let state: TreeState = build(null, 'idle')
const listeners = new Set<() => void>()
let pending: Promise<void> | null = null
let watching = false
/** Counts up whenever the account changes: an answer asked for the account before is dropped when it comes. */
let generation = 0

function publish(next: TreeState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Asks the server for the tree again; one request at a time, a second call waits for the running one. */
export function refreshFolders(): Promise<void> {
  if (pending) return pending
  if (state.status === 'idle') publish({ ...state, status: 'loading' })
  const asked = generation
  const request: Promise<void> = foldersApi
    .tree()
    .then((tree) => {
      if (asked === generation) publish(build(tree, 'ready'))
    })
    .catch(() => {
      if (asked === generation) publish({ ...state, status: state.status === 'ready' ? 'ready' : 'failed' })
    })
    .finally(() => {
      if (pending === request) pending = null
    })
  pending = request
  return request
}

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('focus', () => void refreshFolders())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshFolders()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  watch()
  if (state.status === 'idle') void refreshFolders()
  return () => listeners.delete(listener)
}

export function useFolders(): TreeState {
  return useSyncExternalStore(subscribe, () => state)
}

/** For tests and for signing out: forget the tree of the account before. The next one to show it asks again. */
export function forgetFolders(): void {
  generation += 1
  pending = null
  publish(build(null, 'idle'))
}

/** The folder and everything above it, from the top down. */
export function pathOf(tree: TreeState, id: string): Folder[] {
  const path: Folder[] = []
  const seen = new Set<string>()
  let current = tree.byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parent_id ? tree.byId.get(current.parent_id) : undefined
  }
  return path
}

/** The folder and every folder below it. */
export function subtreeOf(tree: TreeState, id: string): Set<string> {
  const found = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const current = queue.pop()!
    if (found.has(current)) continue
    found.add(current)
    queue.push(...(tree.children.get(current) ?? []))
  }
  return found
}

/** The rows of the tree as they stand one under the other, with their depth; `open` decides which folders show their
 * children (all, when it is `null`). */
export function flatten(tree: TreeState, open: ReadonlySet<string> | null): { folder: Folder; depth: number }[] {
  const rows: { folder: Folder; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const id of tree.children.get(parent) ?? []) {
      const folder = tree.byId.get(id)
      if (!folder) continue
      rows.push({ folder, depth })
      if (open === null || open.has(id)) walk(id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

/** Indent of a level: wide for the first five, narrow below, so that fifteen levels still leave room for a name (EC-3). */
export function indent(depth: number): number {
  return 4 + Math.min(depth, 5) * 14 + Math.max(0, depth - 5) * 5
}

// ---- Open and closed, per device ------------------------------------------------------------------------------------

const OPEN_KEY = 'nexnotes.folders.open'

function readOpen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

let open: Set<string> = readOpen()
const openListeners = new Set<() => void>()

function writeOpen(next: Set<string>): void {
  open = next
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
  } catch {
    // Private mode: then it holds until the page reloads.
  }
  for (const listener of openListeners) listener()
}

export function useOpenFolders(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    },
    () => open,
  )
}

export function setFolderOpen(id: string, value: boolean): void {
  if (open.has(id) === value) return
  const next = new Set(open)
  if (value) next.add(id)
  else next.delete(id)
  writeOpen(next)
}

/** Opens every folder above this one, so that it shows in the sidebar. */
export function revealFolder(id: string): void {
  const above = pathOf(state, id).slice(0, -1)
  if (above.every((folder) => open.has(folder.id))) return
  writeOpen(new Set([...open, ...above.map((folder) => folder.id)]))
}

/** Read again from the browser (a test that changed `localStorage` itself). */
export function reloadOpenFolders(): void {
  open = readOpen()
  for (const listener of openListeners) listener()
}

// ---- The open folder: where a new note lands (AC-9) -----------------------------------------------------------------

let current: string | null = null
const currentListeners = new Set<() => void>()

/** The list on show sets it (`useShownFolder`); anything else (all notes, search, a smart folder) leaves it `null`. */
export function setCurrentFolder(id: string | null): void {
  if (current === id) return
  current = id
  for (const listener of currentListeners) listener()
}

/**
 * The folder whose list is on show (a folder's id, `inbox`, or none) is the open folder while the list is on show,
 * whether it has room beside the notes or not (NOTES-8 AC-9): the notes' workspace calls it with the folder of its
 * list.
 */
export function useShownFolder(shown: string | 'inbox' | null): void {
  const tree = useFolders()
  const id = shown === 'inbox' ? (tree.inbox?.id ?? null) : shown
  useEffect(() => {
    setCurrentFolder(id)
    return () => setCurrentFolder(null)
  }, [id])
}

/**
 * Where a new note goes (NOTES-4 AC-9): `targetFolderId` is the open folder, or the inbox when no folder is open ("All
 * notes", a search, a smart folder). `null` only while the tree is still loading.
 */
export function useCurrentFolder(): { openFolderId: string | null; targetFolderId: string | null } {
  const openFolderId = useSyncExternalStore(
    (listener) => {
      currentListeners.add(listener)
      return () => currentListeners.delete(listener)
    },
    () => current,
  )
  const tree = useFolders()
  // A folder that went to the trash meanwhile is no place for a note; before the tree is there, the page knows best.
  const alive = openFolderId !== null && (tree.status !== 'ready' || tree.byId.has(openFolderId) || tree.inbox?.id === openFolderId)
  return { openFolderId: alive ? openFolderId : null, targetFolderId: alive ? openFolderId : (tree.inbox?.id ?? null) }
}

onAccountChange(() => {
  forgetFolders()
  setCurrentFolder(null)
})
