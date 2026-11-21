// The Tiptap extensions of a nexnotes note, format "nexnotes-doc 1".
//
// One list for the browser editor and for the interop check against the server (backend/app/notedoc). The frontend
// takes this file over as it is and adds what only the editor needs (collaboration, caret, placeholder, input rules);
// nothing added there may change the schema, or the server and the iOS app no longer read the same document.
//
// Node and mark names, attributes and their defaults must match backend/app/notedoc/schema.py; the interop fixtures
// (make-fixtures.mjs) write the schema out and a backend test compares both.

import { getSchema, mergeAttributes, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'

/** The fixed row of highlight colours; the editor maps each name to a colour of the theme. */
export const HIGHLIGHT_COLORS = ['honey', 'green', 'blue', 'rose', 'violet']

/** Links only to these schemes (NOTES-3 EC-8); everything else is not a link. */
export const LINK_PROTOCOLS = ['http', 'https', 'mailto']

/** The id of an attachment (NOTES-10): 22 characters of base64url the browser makes; never a path. */
export const ATTACHMENT_ID = /^[A-Za-z0-9_-]{16,32}$/

/** How wide a picture stands in the note (NOTES-10 AC-2); the first is the default. */
export const IMAGE_SIZES = ['medium', 'small', 'full']

const attachmentId = (value) => (typeof value === 'string' && ATTACHMENT_ID.test(value) ? value : null)
const text = (value) => (typeof value === 'string' && value.trim() ? value : null)
const dataAttribute = (name, read = text) => ({
  default: null,
  parseHTML: (element) => read(element.getAttribute(`data-${name}`)),
  renderHTML: (attributes) => (attributes[name] ? { [`data-${name}`]: attributes[name] } : {}),
})

/**
 * Attachments (NOTES-10) are blocks without content that name the attachment by its id; the file is never in the
 * document. A picture with its size, a file of any other kind (PDF, video ...), and the card of a link with its title,
 * description, site and the id of the stored picture of the page.
 */
export const NoteImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      id: dataAttribute('id', attachmentId),
      size: {
        default: IMAGE_SIZES[0],
        parseHTML: (element) => (IMAGE_SIZES.includes(element.getAttribute('data-size')) ? element.getAttribute('data-size') : IMAGE_SIZES[0]),
        renderHTML: (attributes) => ({ 'data-size': attributes.size }),
      },
      name: dataAttribute('name'),
    }
  },
  parseHTML() {
    return [{ tag: 'figure[data-type="image"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-type': 'image' }, HTMLAttributes)]
  },
})

export const NoteAttachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { id: dataAttribute('id', attachmentId), name: dataAttribute('name') }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="attachment"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'attachment' }, HTMLAttributes)]
  },
})

export const NoteLinkPreview = Node.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      href: dataAttribute('href', (value) => (typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null)),
      title: dataAttribute('title'),
      description: dataAttribute('description'),
      site: dataAttribute('site'),
      image: dataAttribute('image', attachmentId),
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="link-preview"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'link-preview' }, HTMLAttributes)]
  },
})

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
    NoteImage,
    NoteAttachment,
    NoteLinkPreview,
  ]
}

/** The ProseMirror schema of a note. */
export function noteSchema() {
  return getSchema(noteExtensions())
}
