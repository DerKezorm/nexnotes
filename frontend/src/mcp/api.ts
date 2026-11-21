/** MCP keys and connectors over the server (`backend/app/routers/mcp.py`, `routers/oauth.py`, NOTES-20). */
import { api } from '../api/client'

export type McpLevel = 'read' | 'write'

export type McpKey = {
  id: number
  name: string
  level: McpLevel
  prefix: string
  /** `key`: made here by hand; `connector`: a program that signed in with the member's consent (OAuth). */
  kind: 'key' | 'connector'
  created_at: string | null
  last_used_at: string | null
}

export type McpKeys = {
  /** The operator's switch (AC-8): off, no key works and none can be made. */
  allowed: boolean
  /** Where a tool sends its requests (`…/api/mcp`). */
  address: string
  max_keys: number
  keys: McpKey[]
}

export type MadeKey = { key: McpKey; token: string }

export type ConsentAsk = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  state: string
}

export const mcpApi = {
  keys: () => api<McpKeys>('/api/mcp/keys'),
  make: (name: string, level: McpLevel) => api<MadeKey>('/api/mcp/keys', { method: 'POST', body: { name, level } }),
  revoke: (id: number) => api<void>(`/api/mcp/keys/${id}`, { method: 'DELETE' }),
  consentInfo: (ask: ConsentAsk) =>
    api<{ client_name: string; redirect_host: string }>('/api/oauth/authorize', {
      query: { client_id: ask.client_id, redirect_uri: ask.redirect_uri, code_challenge: ask.code_challenge, code_challenge_method: ask.code_challenge_method },
    }),
  consent: (ask: ConsentAsk, approve: boolean, level: McpLevel) =>
    api<{ redirect: string }>('/api/oauth/authorize', { method: 'POST', body: { ...ask, approve, level } }),
}

/** What the consent page was asked, from its address; `null` when a part is missing. */
export function consentAsk(search: string): ConsentAsk | null {
  const params = new URLSearchParams(search)
  const ask = {
    client_id: params.get('client_id') ?? '',
    redirect_uri: params.get('redirect_uri') ?? '',
    code_challenge: params.get('code_challenge') ?? '',
    code_challenge_method: params.get('code_challenge_method') ?? '',
    state: params.get('state') ?? '',
  }
  if (!ask.client_id || !ask.redirect_uri || !ask.code_challenge) return null
  if ((params.get('response_type') ?? 'code') !== 'code') return null
  return ask
}

/** Where the consent page sends the browser afterwards; an object, so that a test sees it without leaving the page. */
export const leave = { to: (address: string) => window.location.assign(address) }
