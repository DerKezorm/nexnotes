/**
 * A member's own nextasks (NOTES-19) docks onto the frame: its card in Settings, Connections (after the devices, before
 * the MCP keys, drawing N2-Verbindungen) and "An nextasks" in the head of an open note.
 */
import { NOTE_HEAD_PARTS } from '../editor/noteParts'
import { CONNECTION_SECTIONS } from '../extensions'
import { onAccountChange } from '../state/account'
import { setNextasks } from './api'
import { NextasksSection } from './NextasksSection'
import { SendToNextasks } from './SendToNextasks'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'nextasks')) {
  const after = CONNECTION_SECTIONS.findIndex((section) => section.key === 'mcp' || section.key === 'vault')
  const section = { key: 'nextasks', render: () => <NextasksSection /> }
  if (after === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(after, 0, section)
}
if (!NOTE_HEAD_PARTS.includes(SendToNextasks)) NOTE_HEAD_PARTS.push(SendToNextasks)
// Another account in this tab has its own nextasks, or none.
onAccountChange(() => setNextasks(null))
