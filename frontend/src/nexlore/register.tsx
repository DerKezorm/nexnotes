/**
 * A note into nexlore (module verbinden, Runde 2 V19): "An nexlore" in the note's menu and its dialog over the page.
 */
import { NOTE_MENU_ITEMS } from '../editor/noteParts'
import { SHELL_PARTS } from '../extensions'
import { onAccountChange } from '../state/account'
import { forgetNexlore } from './api'
import { NexloreHost, NoteNexloreItem } from './SendToNexlore'

if (!NOTE_MENU_ITEMS.includes(NoteNexloreItem)) NOTE_MENU_ITEMS.push(NoteNexloreItem)
if (!SHELL_PARTS.some((part) => part.key === 'nexlore-note')) SHELL_PARTS.push({ key: 'nexlore-note', render: () => <NexloreHost /> })
onAccountChange(() => forgetNexlore())
