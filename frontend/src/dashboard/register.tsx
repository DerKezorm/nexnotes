/** Keys for nexdeck cards (NOTES-21) dock onto Settings, Connections: after the MCP keys, before the vault password. */
import { CONNECTION_SECTIONS } from '../extensions'
import { DeckKeysSection } from './DeckKeysSection'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'dashboard')) {
  const vault = CONNECTION_SECTIONS.findIndex((section) => section.key === 'vault')
  const section = { key: 'dashboard', render: () => <DeckKeysSection /> }
  if (vault === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(vault, 0, section)
}
