/** Types of `schema.mjs`, the note schema taken over unchanged from `interop/schema.mjs`. */
import type { AnyExtension } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'

export declare const HIGHLIGHT_COLORS: readonly ['honey', 'green', 'blue', 'rose', 'violet']
export declare const LINK_PROTOCOLS: readonly string[]
export declare function noteExtensions(): AnyExtension[]
export declare function noteSchema(): Schema
