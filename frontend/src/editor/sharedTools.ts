/**
 * The one toolbar over two notes side by side (NOTES-8, decision of 21.11.2026): with two sides on show each note hands
 * its editor to the page instead of drawing the text tools itself. The page draws one bar over both sides that works
 * on the side used last; each sheet keeps only the tools of the whole note (`NoteViewTools`, attaching, the others,
 * the pin, the note's menu). One note alone, a narrow window and the phone keep their own bar.
 */
import type { Editor } from '@tiptap/core'
import { createContext } from 'react'

/** What a note hands to the bar over both sides: its editor, its way to the link dialog, and whether it may be written. */
export type ToolsEntry = { editor: Editor; onLink: () => void; writable: boolean }

/** Given to a note on a side of two on show: the note registers its editor here (null when it goes). */
export type ToolsSlot = { register: (entry: ToolsEntry | null) => void }

export const SharedToolsContext = createContext<ToolsSlot | null>(null)
