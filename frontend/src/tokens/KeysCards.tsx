/**
 * The cards of the shared key module (schluessel 1.0.0, plan "Einstellungen") with nexnotes' words: "API-Schlüssel"
 * and "KI-Werkzeuge (MCP)" in My account › Connections (NOTES-25, NOTES-20: API tokens with folders and the extra "also
 * for AI tools", the older MCP and card keys in the same list, AI tools connected by OAuth), "Schnittstellen" in Server ›
 * General (the switches "Programmschnittstelle (API) für Mitglieder" and "MCP-Zugang"), "API-Schlüssel aller Konten" in
 * Server › Accounts (NOTES-25 AC-27). The routes are the module's under `/api/connections`; nexnotes' older ways
 * (`/api/tokens`, `/api/admin/tokens`) stay for scripts. The module mcp adds "Rechte je Werkzeug" to each key and
 * program, "Wartende Rückfragen" to the card "KI-Werkzeuge (MCP)" and the operator's MCP settings after "MCP-Zugang".
 */
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import { mcpRequest, useMcpWords } from '../mcp/words'
import { useAuth } from '../state/auth'
import { McpOperatorSettings, PendingRequests, ToolRights } from '../vendor/nexmcp'
import { AllKeysCard, ApiKeysCard, InterfacesCard, ToolsCard, type AdminKey, type AppWords, type KeyRequest } from '../vendor/nexschluessel'

/** nexnotes' client for the cards (its tab header, its errors with their codes). */
// eslint-disable-next-line react-refresh/only-export-components
export const keyRequest: KeyRequest = <T,>(path: string, init: Parameters<KeyRequest>[1] = {}) =>
  api<T>(path, { method: init.method, query: init.query, body: init.body })

/** Where the programming interface is described (NOTES-25 AC-25). */
export const DOCS = '/api/v1/docs'

function useWords(): AppWords {
  const { t } = useTranslation()
  // One wording for every app (schluessel 1.1.1, M-5): "Alle Ordner, auch spätere", "Nur diese Ordner".
  return { areas: t('tokens.dialog.folders') }
}

/** My account › Connections, places 5 and 6: "API-Schlüssel", then "KI-Werkzeuge (MCP)". */
export function ConnectionKeys() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const words = useWords()
  const tools = useMcpWords()
  return (
    <>
      <ApiKeysCard request={keyRequest} things={t('settings.things')} thingsDative={t('settings.thingsDative')} words={words} docsHref={DOCS} operator={me?.role === 'operator'} language={i18n.language} />
      <ToolsCard
        request={keyRequest}
        words={words}
        language={i18n.language}
        extra={(key) => <ToolRights request={mcpRequest} keyId={key.id} words={tools} language={i18n.language} />}
      >
        <PendingRequests request={mcpRequest} words={tools} language={i18n.language} viewHref={(entry) => `/mcp/requests/${entry.id}`} />
      </ToolsCard>
    </>
  )
}

/** Server › General, place 3: "Schnittstellen". */
export function Interfaces() {
  const { i18n } = useTranslation()
  const tools = useMcpWords()
  return (
    <InterfacesCard
      request={keyRequest}
      docsHref={DOCS}
      language={i18n.language}
      after={{ mcp: <McpOperatorSettings request={mcpRequest} words={tools} language={i18n.language} /> }}
    />
  )
}

/** Server › Accounts, place 4: "API-Schlüssel aller Konten". */
export function AllKeys() {
  const { i18n } = useTranslation()
  const { t } = useTranslation()
  // nexnotes' own column (E36): how many folders a key is limited to, never which; "all" for every note.
  const extra = [{ key: 'folders', label: t('tokens.dialog.folders'), width: '7rem', cell: (row: AdminKey) => {
    const count = Number(row.extra?.folders ?? 0)
    return <span>{count > 0 ? t('tokens.list.folders', { count }) : t('tokens.list.foldersAll')}</span>
  } }]
  return <AllKeysCard request={keyRequest} words={useWords()} language={i18n.language} extra={extra} />
}
