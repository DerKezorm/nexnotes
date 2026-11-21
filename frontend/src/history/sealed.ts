/** Versions of a locked note (NOTES-16, NOTES-15): encrypted on the device, the server reads nothing of them. The
 * vault opens and restores them in this browser (`vault/register.tsx`); without an open vault the page says so. */
import type { ProseNode } from './api'

export const SEALED_HISTORY: {
  /** The version's text, or `null` while the vault is closed. */
  open: ((noteId: string, sealed: string) => Promise<ProseNode | null>) | null
  /** Brings the version back as the note's newest save. */
  restore: ((noteId: string, versionId: number, sealed: string) => Promise<void>) | null
} = { open: null, restore: null }
