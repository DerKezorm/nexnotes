/**
 * nexnotes' side of the shared module verbinden (`vendor/nexverbinden` 0.1.1) in the page: its client for the module's
 * routes (`/api/connect`) and the logos of the partner apps it has.
 */
import { api } from '../api/client'
import type { VerbindenRequest } from '../vendor/nexverbinden'

export const connectRequest: VerbindenRequest = <T,>(path: string, init: Parameters<VerbindenRequest>[1] = {}) =>
  api<T>(path, { method: init.method, body: init.body })

/** Partner -> logo (the others show the module's symbol). */
export const LOGOS: Record<string, string> = { nextasks: '/apps/nextasks.svg' }

/** Where the pages send the browser; an object, so that a test sees it without leaving the page. */
export const leave = { to: (address: string) => window.location.assign(address) }
