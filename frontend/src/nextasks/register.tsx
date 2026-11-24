/**
 * A member's own nextasks (NOTES-19) docks onto the frame: its card in Settings, Connections (after the devices, before
 * the MCP keys, drawing N2-Verbindungen), "An nextasks" in the head of an open note, "Als nextasks-Aufgabe" in the bar
 * at the selection and in the note's menu (the whole note as one task).
 */
import { ListChecks } from 'lucide-react'

import { NOTE_HEAD_PARTS, NOTE_MENU_ITEMS, SELECTION_ACTIONS } from '../editor/noteParts'
import { CONNECTION_SECTIONS, SHELL_PARTS } from '../extensions'
import { onAccountChange } from '../state/account'
import { setNextasks } from './api'
import { NextasksSection } from './NextasksSection'
import { canSendLines, sendSelection } from './selection'
import { NoteTaskHost, NoteTaskItem, SendToNextasks } from './SendToNextasks'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'nextasks')) {
  const after = CONNECTION_SECTIONS.findIndex((section) => section.key === 'mcp' || section.key === 'vault')
  const section = { key: 'nextasks', render: () => <NextasksSection /> }
  if (after === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(after, 0, section)
}
if (!NOTE_HEAD_PARTS.includes(SendToNextasks)) NOTE_HEAD_PARTS.push(SendToNextasks)
// The whole note as one task, from the note's menu in the editor and in the list; its dialog over the page.
if (!NOTE_MENU_ITEMS.includes(NoteTaskItem)) NOTE_MENU_ITEMS.push(NoteTaskItem)
if (!SHELL_PARTS.some((part) => part.key === 'nextasks-note')) SHELL_PARTS.push({ key: 'nextasks-note', render: () => <NoteTaskHost /> })
// The selected lines from the bar at the selection, where the head's button would send them.
const selectionAction: (typeof SELECTION_ACTIONS)[number] = (editor, t) =>
  canSendLines(editor) ? { key: 'nextasks', label: t('nextasks.selection'), icon: ListChecks, run: () => sendSelection(editor) } : null
if (!SELECTION_ACTIONS.includes(selectionAction)) SELECTION_ACTIONS.push(selectionAction)
// Another account in this tab has its own nextasks, or none.
onAccountChange(() => setNextasks(null))
