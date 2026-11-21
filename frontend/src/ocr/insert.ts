/** "In die Notiz einfügen" (AC-3): the recognised text as paragraphs right after the attachment's block, or at the end
 * of the note when the block is not there (any more). Lines stay lines, an empty line starts a new paragraph. */
import type { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'

export function paragraphsOf(text: string): JSONContent[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0)
    .map((lines) => ({
      type: 'paragraph',
      content: lines.flatMap((line, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), { type: 'text', text: line }]),
    }))
}

/** Where the text goes: right after the block naming `attachmentId`, else the end. */
export function placeAfter(editor: Editor, attachmentId: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.attrs && (node.attrs as { id?: string }).id === attachmentId && ['image', 'attachment'].includes(node.type.name)) {
      found = pos + node.nodeSize
      return false
    }
    return true
  })
  return found >= 0 ? found : editor.state.doc.content.size
}

export function insertText(editor: Editor, attachmentId: string, text: string): boolean {
  const content = paragraphsOf(text)
  if (content.length === 0 || !editor.isEditable) return false
  return editor.chain().insertContentAt(placeAfter(editor, attachmentId), content).run()
}
