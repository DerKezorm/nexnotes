/**
 * Text recognition docks onto the frame (NOTES-11): the large view of pictures, scans and PDFs with their text
 * (`registerLargeView` of the attachments), a hit of the search in an attachment opens its note and the view at the
 * page, the place marked (`registerAttachmentOpener`, AC-8), and the view itself over every page (`SHELL_PARTS`).
 */
import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { registerLargeView } from '../attachments/large'
import { SHELL_PARTS } from '../extensions'
import { noteHref } from '../notes/newNote'
import { registerAttachmentOpener } from '../search/registry'
import { TEXT_KINDS } from './api'
import { Viewer } from './Viewer'
import { arrived, closeViewer, openViewer, useViewer } from './store'

export function ViewerHost() {
  const opening = useViewer()
  const navigate = useNavigate()
  const close = useCallback(() => closeViewer(), [])
  useEffect(() => {
    if (opening?.go) {
      navigate(opening.go)
      if (opening.id) arrived()
      else closeViewer()
    }
  }, [opening, navigate])
  if (!opening?.id) return null
  return <Viewer key={`${opening.id}:${opening.page}:${opening.mark?.text ?? ''}`} opening={opening} onClose={close} />
}

registerLargeView((info, noteId) => {
  if (!TEXT_KINDS.includes(info.kind)) return
  openViewer({ id: info.id, info, noteId })
})

registerAttachmentOpener((hit) => {
  const found = hit.attachment
  if (!found) return
  // Words of a recording (NOTES-18) and other kinds without a picture: only the note opens.
  if (!TEXT_KINDS.includes(found.kind)) {
    openViewer({ id: '', noteId: hit.id, go: noteHref(hit.id) })
    return
  }
  openViewer({ id: found.ref, noteId: hit.id, page: found.page ?? 1, mark: hit.jump, showText: true, go: noteHref(hit.id) })
})

SHELL_PARTS.push({ key: 'ocr-viewer', render: () => <ViewerHost /> })
