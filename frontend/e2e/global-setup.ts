/**
 * Before any test: the operator account on the fresh data directory, and its session saved for every test
 * (`storageState`). Name and password are made up for the test run and live only in the temporary data directory.
 */
import { request, type FullConfig } from '@playwright/test'

export const OPERATOR = { name: 'tester@example.com', password: 'e2e test operator password' }
/** The tab header every change needs. */
export const TAB = { 'X-Nexnotes-Client': 'tab-e2esetup0' }

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL!
  const context = await request.newContext({ baseURL, extraHTTPHeaders: TAB })
  const setup = await (await context.get('/api/setup')).json()
  if (setup.needs_setup) {
    const made = await context.post('/api/setup', { data: { display_name: 'Tester', email: 'tester@example.com', password: OPERATOR.password, language: 'en', code: 'e2e-setup-code-of-the-run' } })
    if (!made.ok()) throw new Error(`setup failed: ${made.status()}`)
  } else {
    const signed = await context.post('/api/auth/login', { data: OPERATOR })
    if (!signed.ok()) throw new Error(`sign-in failed: ${signed.status()}`)
  }
  await context.storageState({ path: process.env.NEXNOTES_E2E_STATE! })
  await context.dispose()
}
