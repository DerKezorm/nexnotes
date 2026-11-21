/** The consent page of a connecting program over the server (`backend/app/routers/oauth.py`, NOTES-20). Keys and
 * connectors are listed and revoked with the API tokens (`src/tokens/`, NOTES-25). */
import { api } from '../api/client'

export type McpLevel = 'read' | 'write'

export type ConsentAsk = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  state: string
}

export const mcpApi = {
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
