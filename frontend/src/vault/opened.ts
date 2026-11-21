/** The locked notes open in this tab (NOTES-16): their connections, for saving before the lock comes off and for
 * encrypting a new attachment before it leaves (`register.tsx`). */
import type { SealedProvider } from './provider'

const open = new Map<string, SealedProvider>()

export function remember(provider: SealedProvider): void {
  open.set(provider.noteId, provider)
}

export function forget(provider: SealedProvider): void {
  if (open.get(provider.noteId) === provider) open.delete(provider.noteId)
}

export function openSealed(noteId: string): SealedProvider | undefined {
  return open.get(noteId)
}

export function forgetAllOpened(): void {
  open.clear()
}
