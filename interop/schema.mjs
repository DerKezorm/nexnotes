// The Tiptap extensions of a nexnotes note, format "nexnotes-doc 1".
//
// One list for the browser editor and for the interop check against the server (backend/app/notedoc). The frontend
// takes this file over as it is and adds what only the editor needs (collaboration, caret, placeholder, input rules);
// nothing added there may change the schema, or the server and the iOS app no longer read the same document.
//
// Node and mark names, attributes and their defaults must match backend/app/notedoc/schema.py; the interop fixtures
// (make-fixtures.mjs) write the schema out and a backend test compares both.

import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'

/** The fixed row of highlight colours; the editor maps each name to a colour of the theme. */
export const HIGHLIGHT_COLORS = ['honey', 'green', 'blue', 'rose', 'violet']

/** Links only to these schemes (NOTES-3 EC-8); everything else is not a link. */
export const LINK_PROTOCOLS = ['http', 'https', 'mailto']

/** Headings 1 to 3, each one can be folded (NOTES-3 AC-12); the state is part of the document. */
export const CollapsibleHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-collapsed') === 'true',
        renderHTML: (attributes) => (attributes.collapsed ? { 'data-collapsed': 'true' } : {}),
      },
    }
  },
}).configure({ levels: [1, 2, 3] })

/** A checklist that can move done items to its end (NOTES-3 AC-4); the choice is part of the document. */
export const SortableTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      doneToBottom: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-done-to-bottom') === 'true',
        renderHTML: (attributes) => (attributes.doneToBottom ? { 'data-done-to-bottom': 'true' } : {}),
      },
    }
  },
})

/** Highlight colours only from the fixed row; an unknown one falls back to the default colour. */
export const NoteHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const color = element.getAttribute('data-color')
          return HIGHLIGHT_COLORS.includes(color) ? color : null
        },
        renderHTML: (attributes) => (attributes.color ? { 'data-color': attributes.color } : {}),
      },
    }
  },
}).configure({ multicolor: true })

/** The extensions that make up the schema of a note. */
export function noteExtensions() {
  return [
    StarterKit.configure({
      heading: false,
      // History comes from the collaboration extension (only one's own changes, NOTES-3 AC-13).
      undoRedo: false,
      link: {
        openOnClick: false,
        autolink: true,
        protocols: [],
        defaultProtocol: 'https',
        isAllowedUri: (url) => /^(https?:|mailto:)/i.test(String(url).trim()),
      },
    }),
    CollapsibleHeading,
    NoteHighlight,
    SortableTaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ]
}

/** The ProseMirror schema of a note. */
export function noteSchema() {
  return getSchema(noteExtensions())
}
