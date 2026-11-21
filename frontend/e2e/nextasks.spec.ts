/**
 * NOTES-19 in a real browser against the real server: nextasks connected under Settings, Connections; one line and
 * three lines sent from an open note; the mark beside a line; a task gone in nextasks.
 *
 * nextasks is a stand-in served from this test (`/api/v1/me`, `/lists`, `/tasks`), never a real one. nexnotes never
 * asks the machine itself, so the stand-in listens on an address of this machine in the own network (the first private
 * IPv4 address it has), and the operator opens "Connections into the local network" first. Without such an address
 * the tests are skipped. The page is the operator of global-setup.ts.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'

import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-nextasks00' }
const TOKEN = 'ntk_e2e_stand_in_token_0123456789abcdef'
const LIST = '11111111-1111-4111-8111-111111111111'

type Task = { id: string; title: string; url: string; notes: string; list_id?: string; due_date?: string; external_ref?: string; trashed: boolean; link: string }

function homeAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) return entry.address
    }
  }
  return null
}

function standIn(host: string) {
  const tasks = new Map<string, Task>()
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const send = (status: number, data: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(data))
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: { code: 'token_invalid', message: 'No.' } })
      const path = (request.url ?? '').split('?')[0]
      if (request.method === 'GET' && path === '/api/v1/me')
        return send(200, { name: 'robin', display_name: 'Robin', level: 'write', features: ['tasks', 'dashboard', 'external_ref'], spaces: [] })
      if (request.method === 'GET' && path === '/api/v1/lists')
        return send(200, { lists: [{ id: LIST, space_name: 'Home', name: 'Renovation', writable: true, hidden: false, sections: [] }] })
      if (request.method === 'POST' && path === '/api/v1/tasks') {
        const asked = JSON.parse(body) as Task
        const again = [...tasks.values()].find((task) => task.external_ref && task.external_ref === asked.external_ref)
        if (again) return send(200, again)
        const id = randomUUID()
        const task = { ...asked, id, trashed: false, link: `http://${host}/tasks/${id}` }
        tasks.set(id, task)
        return send(201, task)
      }
      const one = /^\/api\/v1\/tasks\/([0-9a-f-]+)$/.exec(path)
      if (request.method === 'GET' && one) {
        const task = tasks.get(one[1])
        return task ? send(200, task) : send(404, { detail: { code: 'not_found', message: 'Not found.' } })
      }
      return send(404, { detail: { code: 'not_found', message: 'Not found.' } })
    })
  })
  return { server, tasks }
}

const home = homeAddress()
test.skip(!home, 'This machine has no address in a private network for the stand-in nextasks.')

let stand: ReturnType<typeof standIn>
let address = ''

test.beforeAll(async () => {
  stand = standIn(home!)
  await new Promise<void>((resolve) => stand.server.listen(0, home!, resolve))
  address = `http://${home}:${(stand.server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise((resolve) => stand.server.close(resolve))
})

async function connect(page: Page): Promise<void> {
  expect((await page.request.put('/api/settings', { data: { connections_local_network: true }, headers: TAB })).status()).toBe(200)
  // Connected already, to this worker's stand-in: nothing to do. A stand-in of an earlier worker (a new worker after a
  // failed test listens on another port) is disconnected first, or every later test would talk to nobody.
  const now = (await (await page.request.get('/api/nextasks', { headers: TAB })).json()) as { connected: boolean; url?: string }
  if (now.connected && now.url === address) return
  if (now.connected) expect((await page.request.delete('/api/nextasks', { headers: TAB })).status()).toBe(204)
  await page.goto('/settings/connections')
  const card = page.locator('#nextasks')
  await card.getByLabel('Address of nextasks').fill(address)
  await card.getByLabel('API key').fill(TOKEN)
  await card.getByTestId('nextasks-connect').click()
  await expect(card.getByTestId('nextasks-connected')).toHaveText(`Connected to ${home} as Robin`)
}

async function newNote(page: Page, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title: `E2E nextasks ${Date.now()}`, markdown }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).id as string
}

test('NOTES-19 AC-4 AC-5 connecting under Connections: the button appears only then', async ({ page }) => {
  const id = await newNote(page, 'Before connecting')
  await page.request.delete('/api/nextasks', { headers: TAB })
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toContainText('Before connecting')
  await expect(page.getByTestId('nextasks-send')).toHaveCount(0)
  await page.goto('/settings/connections')
  await expect(page.getByTestId('nextasks-how')).toBeVisible()
  await connect(page)
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('nextasks-send')).toBeVisible()
})

test('NOTES-19 AC-1 AC-2 AC-3 AC-6 one line goes with a due day, gets its mark, and the task leads back', async ({ page }) => {
  await connect(page)
  const id = await newNote(page, '- [ ] Confirm grey silicone\n- [ ] Have the basin taken off')
  await page.goto(`/notes/${id}`)
  // In the note itself: the list beside it shows the same words in the note's preview.
  await page.getByTestId('note-body').getByText('Have the basin taken off', { exact: true }).click()
  await page.getByTestId('nextasks-send').click()
  await expect(page.getByTestId('nextasks-line')).toHaveText('Have the basin taken off')
  await expect(page.getByTestId('nextasks-list')).toHaveValue(LIST)
  await page.getByTestId('nextasks-due').fill('2030-01-04')
  await page.getByTestId('nextasks-submit').click()
  const mark = page.getByTestId('nextasks-mark')
  await expect(mark).toHaveCount(1)
  await expect(mark).toContainText('due')
  await expect(page.locator('li').filter({ has: mark })).toContainText('Have the basin taken off')
  const task = [...stand.tasks.values()].find((one) => one.title === 'Have the basin taken off')!
  expect(task.url).toContain(`/notes/${id}`)
  expect(task.due_date).toBe('2030-01-04')
  // The mark stays after a reload: it is the member's, kept by the server.
  await page.reload()
  await expect(page.getByTestId('nextasks-mark')).toHaveCount(1)
})

test('NOTES-19 EC-2 EC-4 three lines become three tasks; a task deleted in nextasks is said at its mark', async ({ page }) => {
  await connect(page)
  const id = await newNote(page, 'Milk\n\nEggs\n\nButter')
  await page.goto(`/notes/${id}`)
  await page.getByTestId('note-body').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByTestId('nextasks-send').click()
  await expect(page.getByTestId('nextasks-count')).toHaveText('3 lines become 3 tasks:')
  await page.getByTestId('nextasks-submit').click()
  await expect(page.getByTestId('nextasks-mark')).toHaveCount(3)
  const eggs = [...stand.tasks.values()].find((one) => one.title === 'Eggs')!
  stand.tasks.delete(eggs.id)
  await page.locator('p').filter({ hasText: 'Eggs' }).getByTestId('nextasks-mark').click()
  await expect(page.getByTestId('nextasks-gone')).toBeVisible()
  await page.getByTestId('nextasks-gone-remove').click()
  await expect(page.getByTestId('nextasks-mark')).toHaveCount(2)
})
