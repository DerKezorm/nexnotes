/** API tokens over the server (`backend/app/routers/tokens.py`, NOTES-25). */
import { api } from '../api/client'

export type TokenLevel = 'read' | 'write'
/** Where a token counts: the API, MCP, or (an older card key) the nexdeck card's routes only. */
export type TokenAccess = 'api' | 'mcp' | 'card'

export type ApiTokenEntry = {
  id: number
  name: string
  /** `api`; the older `mcp` and `dashboard` keys; `connector` for a program that signed in with OAuth. */
  kind: 'api' | 'mcp' | 'dashboard' | 'connector'
  /** An older key: `mcp` ("nur MCP"), `card` ("nur nexdeck-Karte"); null for an API token. */
  legacy: 'mcp' | 'card' | null
  level: TokenLevel
  access: TokenAccess[]
  /** The folders the token is limited to; null for all notes. */
  folders: string[] | null
  prefix?: string
  created_at: string | null
  last_used_at: string | null
  expires_at: string | null
  expired: boolean
  /** Blocked by the operator (AC-27). */
  blocked: boolean
}

export type TokenList = {
  /** The operator's switch "Programmschnittstelle (API) für Mitglieder" (AC-5). */
  allowed: boolean
  mcp_allowed: boolean
  /** The address programs are given. */
  address: string
  max_tokens: number
  tokens: ApiTokenEntry[]
  connectors: ApiTokenEntry[]
}

export type NewToken = { name: string; level: TokenLevel; mcp: boolean; folders: string[] | null; days: number | null }
export type MadeToken = { made: ApiTokenEntry; token: string }

/** A token in the operator's overview: the folders only as a number, the account named. */
export type OperatorToken = Omit<ApiTokenEntry, 'folders' | 'prefix'> & { folders: number; account: { id: number; name: string } }

/** The choices of "Ablauf" (AC-1): 90 days chosen from the start, null is "Nie". */
export const EXPIRY_CHOICES: (number | null)[] = [30, 90, 365, null]
export const DEFAULT_DAYS = 90
/** From this many days before, the date shows orange (AC-2). */
export const WARN_DAYS = 7

export const tokensApi = {
  list: () => api<TokenList>('/api/tokens'),
  make: (body: NewToken) => api<MadeToken>('/api/tokens', { method: 'POST', body }),
  revoke: (id: number) => api<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
  every: () => api<{ tokens: OperatorToken[] }>('/api/admin/tokens'),
  block: (id: number) => api<void>(`/api/admin/tokens/${id}/block`, { method: 'POST' }),
}

/** Run out, runs out within `WARN_DAYS`, or neither. */
export function expiry(entry: Pick<ApiTokenEntry, 'expires_at' | 'expired'>, now = Date.now()): 'expired' | 'soon' | 'ok' | 'never' {
  if (!entry.expires_at) return 'never'
  const at = new Date(entry.expires_at).getTime()
  if (entry.expired || at <= now) return 'expired'
  return at - now <= WARN_DAYS * 86_400_000 ? 'soon' : 'ok'
}
