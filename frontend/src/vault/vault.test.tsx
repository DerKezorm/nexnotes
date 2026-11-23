/**
 * NOTES-16 in the browser: the cryptography (the same bytes as the server's tests and the iOS app), the open vault in
 * memory only and its closing (five minutes without use, the last note closed, another account, a new password
 * elsewhere), the dialogs (set up, lock, open with wrong passwords and their wait, new password, forgotten), saving a
 * locked note, and a locked note in its tab locking again (NOTES-8 EC-5).
 *
 * The server is a stand-in (`fetch`); the cryptography is the browser's own WebCrypto.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import * as Y from 'yjs'

import i18n from '../i18n'
import { AuthProvider } from '../state/auth'
import { accountChanged, followAccount, forgetAccount } from '../state/account'
import { attachmentAad, checkKdf, contentAad, derive, fromB64, KDF_ALLOWED, makeVault, noteKey, packAttachment, rewrapVault, seal, toB64, unpackAttachment, unseal, unwrapVault, versionAad, WeakKdfError, KDF_ITERATIONS, type Kdf } from './crypto'
import { ChangePasswordDialog, ForgotDialog, LockDialog, UnlockCard } from './dialogs'
import { LockedNote } from './LockedNote'
import { SealedProvider } from './provider'
import { AUTO_LOCK_MS, forgetVault, hold, isOpen, lockVault, openVault, revSeen, setClock, takeKey, touch, vaultKey } from './session'
import './register'

const ACCOUNT = 7
const PASSWORD = 'Tresor-Passwort 2026'

type Answer = { status: number; body: unknown }
let handler: (method: string, path: string, body: unknown) => Answer | undefined = () => undefined
const calls: { method: string; path: string; body: unknown }[] = []

let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  forgetAccount()
  followAccount(ACCOUNT)
  forgetVault()
  calls.length = 0
  handler = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      calls.push({ method, path, body })
      const answer = handler(method, path, body) ?? { status: 404, body: { detail: { code: 'not_found', message: 'Not found.' } } }
      if (answer.body instanceof Blob) return new Response(answer.body, { status: answer.status })
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  forgetVault()
  localStorage.clear()
  sessionStorage.clear()
})

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function until(check: () => unknown, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (check()) return
    } catch (error) {
      if (Date.now() > end) throw error
    }
    if (Date.now() > end) throw new Error('never got there')
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
  }
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>))
  await settle()
}

const $ = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`)

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => void field.dispatchEvent(new Event('input', { bubbles: true })))
}

async function submit(id: string): Promise<void> {
  const form = $(id)!.closest('form') ?? ($(id) as HTMLFormElement)
  await act(async () => form.requestSubmit())
  await settle()
}

const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path.startsWith(path))

/** A vault of the stand-in server: the derivation, the wrapped key, the hash it compares. */
type Server = { kdf: Kdf; wrapped: string; auth: string; epoch: number; failures: number; wait: number }

async function serverVault(password = PASSWORD): Promise<{ server: Server; key: CryptoKey }> {
  const made = await makeVault(password, ACCOUNT)
  return { server: { kdf: made.kdf, wrapped: made.wrapped_key, auth: made.auth, epoch: 1, failures: 0, wait: 0 }, key: made.key }
}

/** The vault routes as the server answers them: wrong check values counted, a wait after every third. */
function vaultRoutes(server: Server, locked = 3) {
  return (method: string, path: string, body: unknown): Answer | undefined => {
    if (method === 'GET' && path === '/api/vault') return { status: 200, body: { set_up: true, kdf: server.kdf, epoch: server.epoch, locked_notes: locked, locked_all: locked, wait: server.wait } }
    if (method === 'POST' && path === '/api/vault/unlock') {
      if (server.wait) return { status: 429, body: { detail: { code: 'vault_wait', message: '', wait: server.wait } } }
      if ((body as { auth: string }).auth !== server.auth) {
        server.failures += 1
        const wait = server.failures % 3 === 0 ? 30 : 0
        server.wait = wait
        return { status: 403, body: { detail: { code: 'vault_wrong', message: '', left: 3 - (server.failures % 3), wait } } }
      }
      return { status: 200, body: { wrapped_key: server.wrapped, kdf: server.kdf, epoch: server.epoch } }
    }
    return undefined
  }
}

// --- The cryptography ------------------------------------------------------------------------------------------------

describe('the cryptography', () => {
  it('NOTES-16 AC-3 AC-7 a round trip: the password opens the vault, the note key opens the note, nothing else does', async () => {
    const made = await makeVault(PASSWORD, ACCOUNT)
    expect(made.kdf.iterations).toBe(KDF_ITERATIONS)
    expect(made.key.extractable).toBe(false)
    const { kek, auth } = await derive(PASSWORD, made.kdf)
    expect(toB64(auth)).toBe(made.auth)
    const opened = await unwrapVault(kek, made.wrapped_key, ACCOUNT)
    const doc = new Y.Doc()
    doc.getText('title').insert(0, 'Haushalt')
    doc.getXmlFragment('body').insert(0, [new Y.XmlText('WLAN geheim')])
    const state = Y.encodeStateAsUpdate(doc) as Uint8Array<ArrayBuffer>
    const sealed = await seal(await noteKey(made.key, 'n1'), state, contentAad('n1', 1))
    const plain = await unseal(await noteKey(opened, 'n1'), sealed, contentAad('n1', 1))
    const back = new Y.Doc()
    Y.applyUpdate(back, plain)
    expect(back.getText('title').toString()).toBe('Haushalt')
    expect(new TextDecoder().decode(sealed)).not.toContain('geheim')
    // Another note's key, another place, a changed byte: nothing opens.
    await expect(unseal(await noteKey(opened, 'n2'), sealed, contentAad('n1', 1))).rejects.toThrow()
    await expect(unseal(await noteKey(opened, 'n1'), sealed, contentAad('n2', 1))).rejects.toThrow()
    // Another revision, or a version: format 2 binds the content to its revision and kind.
    await expect(unseal(await noteKey(opened, 'n1'), sealed, contentAad('n1', 2))).rejects.toThrow()
    await expect(unseal(await noteKey(opened, 'n1'), sealed, versionAad('n1', 1))).rejects.toThrow()
    const broken = sealed.slice()
    broken[broken.length - 1] ^= 1
    await expect(unseal(await noteKey(opened, 'n1'), broken, contentAad('n1', 1))).rejects.toThrow()
    // Format 1 is not read.
    const old = sealed.slice()
    old[0] = 1
    await expect(unseal(await noteKey(opened, 'n1'), old, contentAad('n1', 1))).rejects.toThrow()
  })

  it('NOTES-16 EC-1 a wrong password opens nothing, and every seal has its own nonce', async () => {
    const made = await makeVault(PASSWORD, ACCOUNT)
    const wrong = await derive('falsches Passwort', made.kdf)
    expect(toB64(wrong.auth)).not.toBe(made.auth)
    await expect(unwrapVault(wrong.kek, made.wrapped_key, ACCOUNT)).rejects.toThrow()
    const key = await noteKey(made.key, 'n1')
    const data = new TextEncoder().encode('gleich') as Uint8Array<ArrayBuffer>
    const nonces = new Set<string>()
    for (let i = 0; i < 50; i++) nonces.add(toB64((await seal(key, data, contentAad('n1', 1))).slice(1, 13)))
    expect(nonces.size).toBe(50)
  })

  it('NOTES-16 AC-7 the browser reads exactly what the server tests and the iOS app write (fixed vectors)', async () => {
    // Made with backend/tests/vault_client.py (the same vectors in test_notes16_the_vectors_of_the_browser).
    const kdf: Kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: toB64(Uint8Array.from({ length: 16 }, (_, i) => i)) }
    const { kek, auth } = await derive(PASSWORD, kdf)
    expect(toB64(auth)).toBe('JRORMaItQVOTPJoW3Ef0nnb552SFJt/mi6gbKi//jvs=')
    const vault = await unwrapVault(kek, 'AgcHBwcHBwcHBwcHB2uYq195Bav/93xmWPh2D1sdf63zmmkp/DB/aqvEQP1JrYoN/h4af0uJNWt59v9R3w==', 7)
    const key = await noteKey(vault, 'note-1')
    const content = fromB64('AgcHBwcHBwcHBwcHB9lc9TGo2OAv4aqCNDHXhJ5v08wwqRaZQr47Erz2')
    expect(new TextDecoder().decode(await unseal(key, content, contentAad('note-1', 3)))).toBe('Geheim äöü')
    const version = fromB64('AgcHBwcHBwcHBwcHB9hY7ie026fMhs33QU71F8AoLkDF7BPb02Wv+FMUIQ==')
    expect(new TextDecoder().decode(await unseal(key, version, versionAad('note-1', 42)))).toBe('Fassung äöü')
    await expect(unseal(key, content, contentAad('note-1', 2))).rejects.toThrow()
    await expect(unseal(key, content, 'nexnotes sealed v1|note|note-1')).rejects.toThrow()
  })

  it('NOTES-16 AC-5 a new password wraps the same vault key', async () => {
    const made = await makeVault(PASSWORD, ACCOUNT)
    const old = await derive(PASSWORD, made.kdf)
    const next = await rewrapVault(old.kek, made.wrapped_key, 'neues Passwort', ACCOUNT)
    const fresh = await derive('neues Passwort', next.kdf)
    const reopened = await unwrapVault(fresh.kek, next.wrapped_key, ACCOUNT)
    const sealed = await seal(await noteKey(made.key, 'n1'), new Uint8Array([1, 2, 3]), contentAad('n1', 1))
    expect([...(await unseal(await noteKey(reopened, 'n1'), sealed, contentAad('n1', 1)))]).toEqual([1, 2, 3])
  })

  it('NOTES-16 AC-7 a derivation weaker than the page takes is refused before the password is used', async () => {
    const good: Kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: toB64(new Uint8Array(16)) }
    expect(checkKdf(good)).toEqual(good)
    expect(KDF_ALLOWED.map((entry) => [entry.name, entry.hash, entry.minIterations, entry.minSalt])).toEqual([['PBKDF2', 'SHA-256', 600_000, 16]])
    const weaker = [
      { ...good, iterations: 1 },
      { ...good, iterations: 599_999 },
      { ...good, iterations: 600_000.5 },
      { ...good, iterations: '600000' },
      { ...good, hash: 'SHA-1' },
      { ...good, name: 'scrypt' },
      { ...good, salt: toB64(new Uint8Array(15)) },
      { ...good, salt: '' },
      { ...good, salt: '%%%' },
      null,
    ]
    for (const kdf of weaker) {
      expect(() => checkKdf(kdf)).toThrow(WeakKdfError)
      await expect(derive(PASSWORD, kdf as Kdf)).rejects.toThrow(WeakKdfError)
    }
  })

  it('NOTES-16 AC-7 a picture the iOS app sealed opens here byte for byte, and the app reads what this page seals (TestFlight 0.16.0)', async () => {
    // Written by the app (NotesCore BrowserSealedTests, nonce 07 × 12) for the vault key 00 … 1f: the same bytes this
    // page writes with that nonce.
    const vault = await crypto.subtle.importKey('raw', Uint8Array.from({ length: 32 }, (_, i) => i), 'HKDF', false, ['deriveKey'])
    const key = await noteKey(vault, 'BrowserLockedNote00001')
    const aad = attachmentAad('BrowserLockedNote00001', 'BrowserWebPPicture0001')
    const webp = fromB64('UklGRlYAAABXRUJQVlA4IEoAAABwAwCdASoYABAAPm0qkUWkIqGYBABABsSgCxCIAq//cAAOa+gA/vEAf/8M7f/hfv+GKf/A/qw91hjn6sPen3QJrDpX7NOLuWuYAA==')
    const app = fromB64('AgcHBwcHBwcHBwcHB93HoB1eEvNoq2xuCDyQ899AXvbxpVyGW8MY4uMv52ORmmQ0zBsKWQidpuiUdPkracqCMIGhGyvD0lWq9U7YxEWqOsEHYaD2EjMwNl4peQrfUHmI3GyV5iX8f6KVv73Brzp1JZ/17I7XqPxh84VQIzDSPdkK+MKiMZ4vJaVC4hbTBPfz8CURj3b66KzpSJiCLqs/BKYQFXU85bBnO5RRhIsjSvbgzGhMNm79p7SxQFWTEZGqJ85plRfrffg1HuGfS1plVea9nUru6pPtEKM=')
    const { header, data } = unpackAttachment(await unseal(key, app, aad))
    expect(header).toEqual({ name: 'nexnotes mit Seitenleiste, Notizliste und offener Notiz.webp', mime: 'image/webp' })
    expect(toB64(data)).toBe(toB64(webp))
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7)
      return array
    })
    try {
      expect(toB64(await seal(key, packAttachment(header, webp), aad))).toBe(toB64(app))
    } finally {
      random.mockRestore()
    }
  })

  it('NOTES-16 AC-2 the sealed file is read past the browser cache (the address held the plain file before the lock)', async () => {
    const seen: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response(new Blob([new Uint8Array([2, 1])]), { status: 200 })
    }))
    const { vaultApi } = await import('./api')
    await vaultApi.file('a1')
    expect(seen[0].cache).toBe('no-store')
  })

  it('NOTES-16 AC-2 an attachment carries its name and type inside, encrypted', async () => {
    const made = await makeVault(PASSWORD, ACCOUNT)
    const key = await noteKey(made.key, 'n1')
    const packed = packAttachment({ name: 'Ausweis.png', mime: 'image/png' }, new Uint8Array([9, 8, 7]))
    const sealed = await seal(key, packed, attachmentAad('n1', 'a1'))
    expect(new TextDecoder().decode(sealed)).not.toContain('Ausweis')
    const { header, data } = unpackAttachment(await unseal(key, sealed, attachmentAad('n1', 'a1')))
    expect(header).toEqual({ name: 'Ausweis.png', mime: 'image/png' })
    expect([...data]).toEqual([9, 8, 7])
  })
})

// --- The open vault ----------------------------------------------------------------------------------------------------

describe('the open vault', () => {
  it('NOTES-16 AC-3 EC-6 closes after five minutes without use, never sooner while used', async () => {
    let now = 1_000_000
    setClock(() => now)
    vi.useFakeTimers()
    const { key } = await serverVault()
    takeKey(key, 1)
    now += AUTO_LOCK_MS - 1000
    touch()
    now += AUTO_LOCK_MS - 1000
    await act(async () => void vi.advanceTimersByTime(2000))
    expect(isOpen()).toBe(true)
    now += 2000
    await act(async () => void vi.advanceTimersByTime(2000))
    await act(async () => void (await Promise.resolve()))
    expect(isOpen()).toBe(false)
    expect(vaultKey()).toBeNull()
  })

  it('NOTES-16 AC-7 EC-6 nothing of the password or the key is kept in the browser', async () => {
    const { server } = await serverVault()
    handler = vaultRoutes(server)
    await render(<UnlockCard title="Haushalt" />)
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-password')
    await until(() => isOpen())
    expect(vaultKey()!.extractable).toBe(false)
    const kept = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie
    expect(kept).not.toContain(PASSWORD)
    expect(kept).not.toContain(server.auth)
    expect(($('vault-password') as HTMLInputElement | null)?.value ?? '').toBe('')
    expect(($('vault-password') as HTMLInputElement | null)?.autocomplete ?? 'new-password').toBe('new-password')
  })

  it('NOTES-16 AC-3 closing the last locked note locks again', async () => {
    vi.useFakeTimers()
    const { key } = await serverVault()
    takeKey(key, 1)
    const release = hold()
    release()
    await act(async () => void vi.advanceTimersByTime(500))
    expect(isOpen()).toBe(true)
    const again = hold()
    await act(async () => void vi.advanceTimersByTime(5000))
    expect(isOpen()).toBe(true)
    again()
    await act(async () => void vi.advanceTimersByTime(2000))
    expect(isOpen()).toBe(false)
  })

  it('NOTES-16 AC-7 signing out or another account closes the vault at once', async () => {
    const { key } = await serverVault()
    takeKey(key, 1)
    accountChanged()
    expect(isOpen()).toBe(false)
    takeKey(key, 1)
    followAccount(8)
    expect(isOpen()).toBe(false)
  })
})

// --- Dialogs ---------------------------------------------------------------------------------------------------------

/**
 * The dialogs' tests check what the page says and does, not the derivation's strength: 600,000 rounds of PBKDF2 take a
 * quarter of a second alone and several seconds beside a full run, four times in a test. Below the page, at
 * WebCrypto's own door, the rounds are cut to a few; the page itself still asks for what the server names, and
 * `checkKdf` still refuses anything under `KDF_ALLOWED` (the cryptography's tests above run the real rounds and the
 * fixed vectors). Returns the rounds the page asked for.
 */
function fewRounds(): number[] {
  const asked: number[] = []
  const subtle = globalThis.crypto.subtle
  const real = subtle.deriveBits.bind(subtle)
  vi.spyOn(subtle, 'deriveBits').mockImplementation((algorithm, key, length) => {
    if (typeof algorithm === 'object' && algorithm.name === 'PBKDF2') {
      const pbkdf2 = algorithm as Pbkdf2Params
      asked.push(pbkdf2.iterations)
      return real({ ...pbkdf2, iterations: 1_000 }, key, length)
    }
    return real(algorithm, key, length)
  })
  return asked
}

describe('the dialogs', () => {
  let asked: number[] = []
  beforeEach(() => {
    asked = fewRounds()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('NOTES-16 AC-1 the first lock sets up the vault: twice the password, the warning, the box first, the title hint', async () => {
    let setup: unknown = null
    handler = (method, path, body) => {
      if (method === 'GET' && path === '/api/vault') return { status: 200, body: { set_up: false, locked_notes: 0, locked_all: 0 } }
      if (method === 'POST' && path === '/api/vault/setup') {
        setup = body
        return { status: 201, body: { set_up: true, epoch: 1, locked_notes: 0, locked_all: 0 } }
      }
      if (method === 'POST' && path.endsWith('/lock/start')) return { status: 200, body: { state: toB64(Y.encodeStateAsUpdate(new Y.Doc()) as Uint8Array<ArrayBuffer>), rev: 1, versions: [], attachments: [], epoch: 1 } }
      if (path.startsWith('/api/vault/stage')) return { status: 200, body: { part: 'content', size: 1 } }
      if (method === 'POST' && path.endsWith('/lock')) return { status: 200, body: { id: 'n1', locked: true, rev: 1 } }
      return undefined
    }
    await render(<LockDialog noteId="n1" onClose={() => undefined} />)
    expect($('vault-warning')!.textContent).toContain('A forgotten password means the content is gone')
    expect($('vault-title-hint')!.textContent).toContain('Keep secrets out of the title')
    expect(($('vault-submit') as HTMLButtonElement).disabled).toBe(true)
    type($('vault-password') as HTMLInputElement, 'kurz')
    type($('vault-repeat') as HTMLInputElement, 'kurz')
    await act(async () => ($('vault-understood') as HTMLInputElement).click())
    await submit('vault-setup')
    expect(box.textContent).toContain('At least 8 characters.')
    type($('vault-password') as HTMLInputElement, PASSWORD)
    type($('vault-repeat') as HTMLInputElement, PASSWORD + 'x')
    await submit('vault-setup')
    expect(box.textContent).toContain('The two passwords are not the same.')
    expect(setup).toBeNull()
    type($('vault-repeat') as HTMLInputElement, PASSWORD)
    await submit('vault-setup')
    await until(() => sent('POST', '/api/vault/notes/n1/lock').some((call) => call.path.endsWith('/lock')))
    expect(setup).toMatchObject({ understood: true, kdf: { name: 'PBKDF2', iterations: KDF_ITERATIONS } })
    expect(JSON.stringify(setup)).not.toContain(PASSWORD)
    expect(JSON.stringify(calls)).not.toContain(PASSWORD)
    expect(isOpen()).toBe(true)
  })

  it('NOTES-16 AC-8 with a vault there, locking asks only the password and sends the note encrypted', async () => {
    const { server } = await serverVault()
    const doc = new Y.Doc()
    doc.getXmlFragment('body').insert(0, [new Y.XmlText('Kontonummer 1234')])
    const staged: Record<string, Uint8Array> = {}
    const routes = vaultRoutes(server)
    handler = (method, path, body) => {
      if (method === 'POST' && path.endsWith('/lock/start')) return { status: 200, body: { state: toB64(Y.encodeStateAsUpdate(doc) as Uint8Array<ArrayBuffer>), rev: 1, versions: [], attachments: [], epoch: 1 } }
      if (method === 'PUT' && path.startsWith('/api/vault/stage')) {
        staged[new URL(path, 'http://x').searchParams.get('part')!] = new Uint8Array()
        void (body as Blob).arrayBuffer().then((bytes) => (staged.content = new Uint8Array(bytes)))
        return { status: 200, body: { part: 'content', size: 1 } }
      }
      if (method === 'POST' && path.endsWith('/lock')) return { status: 200, body: { id: 'n1', locked: true, rev: 1 } }
      return routes(method, path, body)
    }
    await render(<LockDialog noteId="n1" onClose={() => undefined} />)
    expect(box.querySelectorAll('input[type=password]')).toHaveLength(1)
    expect($('vault-understood')).toBeNull()
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-password')
    await until(() => sent('POST', '/api/vault/notes/n1/lock').length === 2)
    await until(() => staged.content && staged.content.length > 0)
    expect(new TextDecoder().decode(staged.content)).not.toContain('Kontonummer')
    expect(new TextDecoder().decode(await unseal(await noteKey(vaultKey()!, 'n1'), staged.content as Uint8Array<ArrayBuffer>, contentAad('n1', 1)))).toContain('Kontonummer')
  })

  it('NOTES-16 AC-8 the lock dialog says "Locking …" from the first moment, never stands empty while it works', async () => {
    const { server } = await serverVault()
    const routes = vaultRoutes(server)
    handler = (method, path, body) => {
      if (method === 'POST' && path.endsWith('/lock/start')) return { status: 200, body: { state: toB64(Y.encodeStateAsUpdate(new Y.Doc()) as Uint8Array<ArrayBuffer>), rev: 1, versions: [], attachments: [], epoch: 1 } }
      if (method === 'PUT' && path.startsWith('/api/vault/stage')) return { status: 200, body: { part: 'content', size: 1 } }
      if (method === 'POST' && path.endsWith('/lock')) return { status: 200, body: { id: 'n1', locked: true, rev: 1 } }
      return routes(method, path, body)
    }
    // The server holds the start of the lock: the password is taken, nothing is encrypted yet.
    const answer = globalThis.fetch
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/lock/start')) await held
      return answer(input, init)
    })
    let closed = false
    await render(<LockDialog noteId="n1" onClose={() => (closed = true)} />)
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-password')
    await until(() => $('vault-progress'))
    expect($('vault-unlock')).toBeNull()
    expect($('vault-progress')!.textContent).toBe('Locking …')
    expect($('vault-lock-dialog')!.textContent).toContain('Locking …')
    expect(closed).toBe(false)
    await act(async () => release())
    await until(() => closed)
    expect(sent('POST', '/api/vault/notes/n1/lock').some((call) => call.path.endsWith('/n1/lock'))).toBe(true)
  })

  it('NOTES-16 AC-3 while the password is checked the button says "Unlocking …" and the field holds still', async () => {
    const { server } = await serverVault()
    handler = vaultRoutes(server)
    const answer = globalThis.fetch
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/vault/unlock') await held
      return answer(input, init)
    })
    let opened = false
    await render(<UnlockCard title="Konten" onOpened={() => (opened = true)} />)
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-password')
    await until(() => $('vault-submit')!.textContent === 'Unlocking …')
    expect(($('vault-submit') as HTMLButtonElement).disabled).toBe(true)
    // Typed while the answer is under way, it would be emptied with the answer: the field takes nothing meanwhile.
    expect(($('vault-password') as HTMLInputElement).readOnly).toBe(true)
    expect($('vault-unlock')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => release())
    await until(() => opened)
    expect(($('vault-password') as HTMLInputElement).readOnly).toBe(false)
    expect($('vault-submit')!.textContent).toBe('Unlock')
  })

  it('NOTES-16 EC-1 three wrong passwords bring the wait with its countdown', async () => {
    const { server } = await serverVault()
    handler = vaultRoutes(server)
    await render(<UnlockCard title="WLAN-Gäste und Codes" />)
    expect($('locked-title')!.textContent).toBe('WLAN-Gäste und Codes')
    // Each try is waited for until the server answered it and the form is free again: the message of the try before
    // stays on screen meanwhile and must not count as the answer to this one.
    const answered = async (tries: number) => {
      await until(() => sent('POST', '/api/vault/unlock').length === tries && $('vault-unlock')!.getAttribute('aria-busy') === null)
    }
    type($('vault-password') as HTMLInputElement, 'eins')
    await submit('vault-password')
    await answered(1)
    expect($('vault-message')!.textContent).toBe('Wrong. After three wrong tries: wait 30 seconds.')
    type($('vault-password') as HTMLInputElement, 'zwei')
    await submit('vault-password')
    await answered(2)
    expect($('vault-message')!.textContent).toBe('Wrong. One more try, then you will have to wait.')
    type($('vault-password') as HTMLInputElement, 'drei')
    await submit('vault-password')
    await answered(3)
    expect($('vault-submit')!.textContent).toMatch(/^Unlock in 0:[0-3]\d$/)
    expect(($('vault-submit') as HTMLButtonElement).disabled).toBe(true)
    expect($('vault-message')!.textContent).toBe('Too many wrong tries. Wait until the time is up.')
    expect(isOpen()).toBe(false)
    // The page asked for the rounds the server named, every time (the test only made them cheaper below it).
    expect(asked).toEqual([600_000, 600_000, 600_000, 600_000])
  })

  it('NOTES-16 AC-5 a new password needs the old one; a wrong old one changes nothing', async () => {
    const { server } = await serverVault()
    let changed: { auth_old: string; auth: string } | null = null
    const routes = vaultRoutes(server)
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/vault/password') {
        changed = body as { auth_old: string; auth: string }
        return { status: 200, body: { set_up: true, epoch: 2, locked_notes: 3, locked_all: 3 } }
      }
      return routes(method, path, body)
    }
    await render(<ChangePasswordDialog onClose={() => undefined} />)
    type($('vault-old') as HTMLInputElement, 'falsch')
    type($('vault-password') as HTMLInputElement, 'neues Passwort')
    type($('vault-repeat') as HTMLInputElement, 'neues Passwort')
    await submit('vault-change')
    await until(() => box.textContent!.includes('The current password is wrong.'))
    expect(changed).toBeNull()
    type($('vault-old') as HTMLInputElement, PASSWORD)
    await submit('vault-change')
    await until(() => $('vault-changed'))
    expect(changed!.auth_old).toBe(server.auth)
    expect(changed!.auth).not.toBe(server.auth)
  })

  it('NOTES-16 EC-2 a forgotten password starts a new vault only after naming how many notes go', async () => {
    let reset: { count: number } | null = null
    handler = (method, path, body) => {
      if (method === 'GET' && path === '/api/vault') return { status: 200, body: { set_up: true, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, epoch: 1, locked_notes: 2, locked_all: 3 } }
      if (method === 'POST' && path === '/api/vault/reset') {
        reset = body as { count: number }
        return { status: 200, body: { set_up: true, epoch: 2, locked_notes: 0, locked_all: 0, removed: 3 } }
      }
      return undefined
    }
    await render(<ForgotDialog onClose={() => undefined} />)
    expect($('vault-forgot-count')!.textContent).toBe('Without the old password only a new vault is possible. All 3 locked notes are lost then, for the operator too.')
    expect($('vault-submit')!.textContent).toBe('Start anew, delete 3 notes')
    type($('vault-password') as HTMLInputElement, 'ganz neues Passwort')
    type($('vault-repeat') as HTMLInputElement, 'ganz neues Passwort')
    await act(async () => ($('vault-understood') as HTMLInputElement).click())
    // Without the account's password nothing goes to the server: a stolen session is not enough (EC-2).
    await submit('vault-setup')
    expect(reset).toBeNull()
    expect(box.textContent).toContain("Enter your account's password.")
    type($('vault-account-password') as HTMLInputElement, 'Konto-Passwort')
    await submit('vault-setup')
    await until(() => $('vault-forgot-done'))
    expect(reset).toMatchObject({ count: 3, understood: true, current_password: 'Konto-Passwort', code: '' })
    expect($('vault-forgot-done')!.textContent).toBe('The new vault is ready. 3 locked notes were deleted.')
  })
})

// --- A locked note open --------------------------------------------------------------------------------------------------

describe('what a server must not be able to do', () => {
  it('NOTES-16 AC-7 a vault naming one round of the derivation is not opened, and the page says why', async () => {
    const { server } = await serverVault()
    const routes = vaultRoutes(server)
    handler = (method, path, body) => {
      if (method === 'GET' && path === '/api/vault') return { status: 200, body: { set_up: true, kdf: { ...server.kdf, iterations: 1 }, epoch: 1, locked_notes: 1, locked_all: 1, wait: 0 } }
      return routes(method, path, body)
    }
    expect(await openVault(PASSWORD)).toEqual({ ok: false, reason: 'weak' })
    await render(<UnlockCard title="Haushalt" />)
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-unlock')
    await until(() => $('vault-message'))
    expect($('vault-message')!.textContent).toBe(i18n.t('errors.vault_weak_kdf'))
    // No check value ever left the page: nothing to guess the password from offline.
    expect(calls.filter((call) => call.path === '/api/vault/unlock')).toEqual([])
    expect(isOpen()).toBe(false)
  })

  it('NOTES-16 EC-5 a save on an older revision is sealed again for the one after the newest', async () => {
    const { key } = await serverVault()
    takeKey(key, 1)
    const saves: { content: string; base_rev: number; rev: number }[] = []
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/vault/save') {
        saves.push(body as { content: string; base_rev: number; rev: number })
        if (saves.length === 1) return { status: 409, body: { detail: { code: 'vault_stale', message: '', rev: 7 } } }
        return { status: 200, body: { rev: 8, conflict: true } }
      }
      return undefined
    }
    const doc = new Y.Doc()
    const provider = new SealedProvider('n1', doc, 4, await noteKey(key, 'n1'), 1, { saveDelay: 10, pollEvery: 0 })
    doc.getText('title').insert(0, 'Liste')
    await until(() => saves.length === 2 && provider.pending === 0)
    expect(saves.map((save) => [save.base_rev, save.rev])).toEqual([[4, 5], [4, 8]])
    await expect(unseal(await noteKey(key, 'n1'), fromB64(saves[1].content), contentAad('n1', 8))).resolves.toBeTruthy()
    await expect(unseal(await noteKey(key, 'n1'), fromB64(saves[1].content), contentAad('n1', 5))).rejects.toThrow()
    expect(provider.rev).toBe(8)
    provider.destroy()
  })

  it('NOTES-16 AC-7 a revision older than this tab had is not shown (a server rolling back)', async () => {
    const { key } = await serverVault()
    takeKey(key, 1)
    expect(revSeen('n1', 5)).toBe(true)
    expect(revSeen('n1', 5)).toBe(true)
    expect(revSeen('n1', 3)).toBe(false)
    expect(revSeen('n2', 1)).toBe(true)
    // Closed, the vault forgets what it saw.
    await lockVault()
    expect(revSeen('n1', 1)).toBe(true)
  })
})

describe('a locked note open in the browser', () => {
  async function sealedNote(text: string, key: CryptoKey): Promise<string> {
    const doc = new Y.Doc()
    doc.getText('title').insert(0, 'Haushalt')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    doc.getXmlFragment('body').insert(0, [paragraph])
    return toB64(await seal(await noteKey(key, 'n1'), Y.encodeStateAsUpdate(doc) as Uint8Array<ArrayBuffer>, contentAad('n1', 1)))
  }

  it('NOTES-16 AC-3 EC-5 a change is saved encrypted on the revision it started from; a newer one elsewhere is loaded', async () => {
    const { key } = await serverVault()
    takeKey(key, 1)
    const saves: { content: string; base_rev: number; rev: number; title: string }[] = []
    let rev = 4
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/vault/save') {
        saves.push(body as { content: string; base_rev: number; rev: number; title: string })
        rev += 1
        return { status: 200, body: { rev, conflict: false } }
      }
      if (method === 'GET' && path === '/api/vault/notes/n1') return { status: 200, body: { id: 'n1', content: '', rev, epoch: 1, title: 'Haushalt', saved_at: '' } }
      return undefined
    }
    const doc = new Y.Doc()
    const provider = new SealedProvider('n1', doc, 4, await noteKey(key, 'n1'), 1, { saveDelay: 10, pollEvery: 0 })
    doc.getText('title').insert(0, 'Haushalt')
    expect(provider.pending).toBeGreaterThan(0)
    await until(() => saves.length === 1 && provider.pending === 0)
    expect(saves[0].base_rev).toBe(4)
    expect(saves[0].rev).toBe(5)
    expect(saves[0].title).toBe('Haushalt')
    const plain = await unseal(await noteKey(key, 'n1'), fromB64(saves[0].content), contentAad('n1', 5))
    const back = new Y.Doc()
    Y.applyUpdate(back, plain)
    expect(back.getText('title').toString()).toBe('Haushalt')
    expect(provider.rev).toBe(5)
    // Another device saved meanwhile, nothing waits here: the newer one is loaded.
    let newer = 0
    provider.onNewer = (found) => (newer = found)
    rev = 9
    await (provider as unknown as { poll: () => Promise<void> }).poll()
    expect(newer).toBe(9)
    provider.destroy()
  })

  it('NOTES-16 EC-7 a new password on another device locks the note here and asks again', async () => {
    const { key } = await serverVault()
    takeKey(key, 1)
    handler = (method, path) => {
      if (method === 'POST' && path === '/api/vault/save') return { status: 409, body: { detail: { code: 'vault_changed', message: '', epoch: 2 } } }
      return undefined
    }
    const doc = new Y.Doc()
    const provider = new SealedProvider('n1', doc, 1, await noteKey(key, 'n1'), 1, { saveDelay: 10, pollEvery: 0 })
    doc.getText('title').insert(0, 'x')
    await until(() => provider.status === 'locked')
    await until(() => !isOpen())
    provider.destroy()
  })

  it('NOTES-8 EC-5 NOTES-16 AC-3 the open locked note locks again after five minutes and asks for the password', async () => {
    let now = 5_000_000
    setClock(() => now)
    const { server, key } = await serverVault()
    const content = await sealedNote('Geheimer Text', key)
    const routes = vaultRoutes(server)
    handler = (method, path, body) => {
      if (method === 'GET' && path === '/api/notes/n1') return { status: 200, body: { id: 'n1', title: 'Haushalt', locked: true, folder_id: 'f', title_check: false, origin: '', preview: '', created_at: '2026-11-21T08:00:00Z', updated_at: '2026-11-21T08:00:00Z', path: [], updated_by: null, owner: { id: ACCOUNT, name: 'Me' }, deleted_at: null, can_write: true } }
      if (method === 'GET' && path === '/api/vault/notes/n1') return { status: 200, body: { id: 'n1', content, rev: 1, epoch: 1, title: 'Haushalt', saved_at: '' } }
      if (path.startsWith('/api/notes/n1/attachments')) return { status: 200, body: { items: [] } }
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, version: '1', min_password: 12, code_required: false } }
      if (path === '/api/auth/me') return { status: 200, body: { id: ACCOUNT, name: 'me', display_name: 'Me', role: 'member', language: 'en', version: '1', whats_new_seen: '1' } }
      return routes(method, path, body)
    }
    await render(
      <AuthProvider>
        <LockedNote noteId="n1" onUnlocked={() => undefined} />
      </AuthProvider>,
    )
    await until(() => $('vault-password'))
    expect(box.textContent).not.toContain('Geheimer Text')
    type($('vault-password') as HTMLInputElement, PASSWORD)
    await submit('vault-password')
    await until(() => box.textContent!.includes('Geheimer Text'))
    expect($('vault-password')).toBeNull()
    now += AUTO_LOCK_MS + 1000
    await until(() => $('vault-password') && !box.textContent!.includes('Geheimer Text'), 8000)
    expect(isOpen()).toBe(false)
    await lockVault()
  })
})
