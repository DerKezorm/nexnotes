/**
 * Signing out and signing in as someone else in the same tab: nothing of the account before stays on screen, not its
 * tags (NOTES-5), its folders (NOTES-4) nor its hits (NOTES-9), and an answer asked for it that comes late is dropped.
 * The same when another tab signs in as someone else (the cookie is shared).
 *
 * A small stand-in for the server answers for whichever account is signed in; answers can be held back.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import '../folders'
import '../search'
import '../tags'
import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import { forgetTags } from '../tags/store'
import { forgetAccount } from './account'
import { AuthProvider, useAuth } from './auth'

type Who = 'lena' | 'ben'

const ME: Record<Who, Record<string, unknown>> = {
  lena: { id: 7, name: 'lena', display_name: 'Lena', email: 'lena@example.com', role: 'member', sign_in: 'password', language: 'de', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0' },
  ben: { id: 1, name: 'ben', display_name: 'Ben', email: 'ben@example.com', role: 'operator', sign_in: 'password', language: 'de', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0' },
}
const TAGS: Record<Who, string> = { lena: 'geheimvonlena', ben: 'bensliste' }
const FOLDER: Record<Who, string> = { lena: 'Lenas Ordner', ben: 'Bens Ordner' }
const HIT: Record<Who, string> = { lena: 'Lenas Geheimnis', ben: 'Bens Notiz' }

let signedIn: Who | null = null
let holding = false
let held: (() => void)[] = []
let auth: ReturnType<typeof useAuth> | null = null

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** What the server says to the account signed in at the moment the request arrives. */
function answer(path: string, method: string): Response {
  const who = signedIn
  if (path === '/api/setup') return reply(200, { needs_setup: false, code_required: false, signed_in: who !== null, version: '0.1.0', min_password: 12, data_on_share: false })
  if (path === '/api/auth/logout' && method === 'POST') {
    signedIn = null
    return reply(204, null)
  }
  if (!who) return reply(401, { detail: { code: 'sign_in_required', message: 'Sign in.' } })
  if (path === '/api/auth/me') return reply(200, ME[who])
  if (path === '/api/tags') return reply(200, { tags: [{ key: TAGS[who], label: TAGS[who], count: 1 }], total: 1 })
  if (path === '/api/folders') {
    return reply(200, { inbox: { id: `inbox-${who}`, count: 0 }, folders: [{ id: `f-${who}`, name: FOLDER[who], parent_id: null, icon: '', color: '', position: null, count: 1 }] })
  }
  if (path === '/api/search') {
    return reply(200, {
      total: 1, offset: 0, unfiltered: null, terms: ['geheim'], tags: [],
      items: [{ id: `n-${who}`, title: HIT[who], title_parts: [{ text: HIT[who], hit: false }], excerpt: [], where: 'text', attachment: null, jump: null, folder: null, owner_id: ME[who].id, created_at: null, updated_at: null }],
    })
  }
  return reply(200, {})
}

function serve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      const response = answer(url.pathname, method)
      // Held back: the answer was made for the account of that moment and arrives later.
      if (holding && ['/api/tags', '/api/folders', '/api/search'].includes(url.pathname)) {
        await new Promise<void>((release) => held.push(release))
      }
      return response
    }),
  )
}

function Probe() {
  const now = useAuth()
  useEffect(() => {
    auth = now
  }, [now])
  return null
}

let root: Root
let box: HTMLDivElement

/** Long enough for the search's pause after typing (120 ms) and the answers. */
async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  }
}

async function release(): Promise<void> {
  const now = held
  held = []
  for (const go of now) go()
  await settle()
}

const page = () => document.body.textContent ?? ''

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  signedIn = 'lena'
  holding = false
  held = []
  forgetAccount()
  forgetTags()
  forgetFolders()
  serve()
  await i18n.changeLanguage('de')
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/search?q=geheim']}>
        <AuthProvider>
          <Probe />
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )
  })
  await settle()
})

afterEach(async () => {
  holding = false
  await release()
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

function seesLena(): string[] {
  return [TAGS.lena, FOLDER.lena, HIT.lena].filter((text) => page().includes(text))
}

describe('another account in the same tab', () => {
  it('NOTES-5 NOTES-4 NOTES-9 after signing out and in as somebody else nothing of the account before shows, not even late', async () => {
    expect(seesLena()).toEqual([TAGS.lena, FOLDER.lena, HIT.lena])
    // Lena's page asks again (the window comes back to the front); the answers are on their way when she leaves.
    holding = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {
      await auth!.signOut()
    })
    await settle()
    // Ben signs in in the same tab, and his answers take a while.
    signedIn = 'ben'
    await act(async () => {
      auth!.setMe(ME.ben as never)
    })
    await settle()
    expect(seesLena()).toEqual([])
    // Lena's late answers come first, then Ben's: hers are dropped.
    const lenas = held.splice(0, 2)
    for (const go of lenas) go()
    await settle()
    expect(seesLena()).toEqual([])
    holding = false
    await release()
    expect(seesLena()).toEqual([])
    expect(page()).toContain(TAGS.ben)
    expect(page()).toContain(FOLDER.ben)
    expect(page()).toContain(HIT.ben)
  })

  it('NOTES-5 NOTES-4 NOTES-9 when another tab signs in as somebody else, this page follows and shows nothing of the account before', async () => {
    expect(seesLena()).toEqual([TAGS.lena, FOLDER.lena, HIT.lena])
    holding = true
    signedIn = 'ben'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    expect(auth!.me?.id).toBe(ME.ben.id)
    expect(seesLena()).toEqual([])
    holding = false
    await release()
    expect(seesLena()).toEqual([])
    expect(page()).toContain(TAGS.ben)
    expect(page()).toContain(HIT.ben)
  })
})
