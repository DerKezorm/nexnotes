/**
 * nexnotes' side of the shared module mcp (`vendor/nexmcp` 1.1.0) in the page: its client for the module's routes
 * (the tab header, its errors with their codes) and its words for its tools and levels (DE/EN, in the language files
 * under mcp, tools and dialog). The parts are the module's: the consent page "Programm verbinden" (`/oauth/authorize`),
 * "Rechte je Werkzeug" and "Wartende Rückfragen" in the card "KI-Werkzeuge (MCP)", the page of one request
 * (`/mcp/requests/<id>`) and the operator's settings in "Schnittstellen".
 */
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import type { McpRequest, McpWords } from '../vendor/nexmcp'

/** The module's routes over nexnotes' client. */
export const mcpRequest: McpRequest = <T,>(path: string, init: Parameters<McpRequest>[1] = {}) =>
  api<T>(path, { method: init.method, body: init.body })

/** nexnotes' tools, by the names programs know. */
export const TOOLS = [
  'search_notes', 'read_note', 'list_notes', 'list_folders', 'list_tags', 'list_smart_folders',
  'create_note', 'append_to_note', 'check_item', 'move_note', 'create_folder', 'trash_note',
] as const

export function useMcpWords(): McpWords {
  const { t } = useTranslation()
  return {
    tools: Object.fromEntries(TOOLS.map((name) => [name, t(`mcp.tools.${name}`)])),
    levels: { read: t('mcp.dialog.read'), write: t('mcp.dialog.write') },
    levelHints: { read: t('mcp.dialog.readHint'), write: t('mcp.dialog.writeHint') },
  }
}

/** Where the consent page sends the browser afterwards; an object, so that a test sees it without leaving the page. */
export const leave = { to: (address: string) => window.location.assign(address) }
