/** nexnotes' own `fetch` for the shared modules that take one (updates, wasneu): every request names its tab
 * (changes are refused without it). */
import { tabId } from '../api/client'

export function tabFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Nexnotes-Client', tabId())
  return fetch(path, { credentials: 'same-origin', ...init, headers })
}
