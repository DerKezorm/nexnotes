/**
 * API tokens (NOTES-25) dock onto Settings, Connections: one section for programs and AI tools, with the connected AI
 * tools below it, after devices and nextasks and before the vault password (drawing N2-Verbindungen).
 */
import { CONNECTION_SECTIONS } from '../extensions'
import { TokensSection } from './TokensSection'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'tokens')) {
  const vault = CONNECTION_SECTIONS.findIndex((section) => section.key === 'vault')
  const section = { key: 'tokens', render: () => <TokensSection /> }
  if (vault === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(vault, 0, section)
}
