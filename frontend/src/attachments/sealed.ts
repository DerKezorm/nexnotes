/** How an attachment of a locked note (NOTES-16) stands in the note: the vault decrypts it here and registers its
 * view (`vault/register.tsx`); the blocks ask for it when the server says `sealed`. */
import type { ReactNode } from 'react'

import type { BlockActions } from './blocks'
import type { ImageSize } from './open'

export type SealedBlockProps = { noteId: string; id: string; name: string | null; size?: ImageSize; actions: BlockActions }

export const SEALED_BLOCK: { render: ((props: SealedBlockProps) => ReactNode) | null } = { render: null }
