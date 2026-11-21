/** Versions of a locked note (NOTES-16, NOTES-15): encrypted on the device, the server reads nothing of them. The
 * vault opens and restores them in this browser (`vault/register.tsx`); without an open vault the page says so. */
import type { ProseNode } from './api'

/** A version as the server hands it out encrypted: `sealed_rev` names the revision of the note's content it was, or
 * `null` when it was sealed for its id at locking (format 2 of the vault). */
export type SealedVersion = { id: number; content_sealed: string; sealed_rev?: number | null }

export const SEALED_HISTORY: {
  /** The version's text, or `null` while the vault is closed. */
  open: ((noteId: string, version: SealedVersion) => Promise<ProseNode | null>) | null
  /** Brings the version back as the note's newest save. */
  restore: ((noteId: string, version: SealedVersion) => Promise<void>) | null
} = { open: null, restore: null }
