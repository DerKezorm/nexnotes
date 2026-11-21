/** A block of an attachment in the editor (NOTES-10): the React view of the schema's `image`, `attachment` and
 * `linkPreview`, with what one who writes may do (size, remove, back to a plain link). */
import { NodeViewWrapper, useEditorState, type ReactNodeViewProps } from '@tiptap/react'

import type { LinkCard } from './api'
import { AttachmentBlock, LinkCardBlock } from './blocks'
import type { ImageSize } from './open'
import { cancelUpload } from './uploads'

export function BlockView({ node, editor, getPos, updateAttributes, deleteNode, extension, selected }: ReactNodeViewProps) {
  const editable = useEditorState({ editor, selector: ({ editor: current }) => current.isEditable }) ?? editor.isEditable
  const noteId = String((extension.options as { noteId?: string }).noteId ?? '')
  const attrs = node.attrs as Record<string, string | null>
  const remove = () => {
    if (attrs.id) cancelUpload(attrs.id)
    deleteNode()
  }
  const plain = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined
    const href = attrs.href
    if (pos === undefined || !href) return
    editor
      .chain()
      .focus()
      .insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: 'paragraph', content: [{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }] })
      .run()
  }
  return (
    <NodeViewWrapper className={'nn-attachment-node' + (selected ? ' nn-attachment-selected' : '')} data-drag-handle="" contentEditable={false}>
      {node.type.name === 'linkPreview' ? (
        <LinkCardBlock attrs={attrs as unknown as LinkCard} actions={{ editable, onRemove: remove, onPlain: plain }} />
      ) : (
        <AttachmentBlock
          noteId={noteId}
          id={attrs.id}
          name={attrs.name}
          size={(attrs.size as ImageSize | null) ?? undefined}
          nodeType={node.type.name === 'image' ? 'image' : 'attachment'}
          actions={{ editable, onRemove: remove, onSize: node.type.name === 'image' ? (size) => updateAttributes({ size }) : undefined }}
        />
      )}
    </NodeViewWrapper>
  )
}
