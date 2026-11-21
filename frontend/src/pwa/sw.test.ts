/**
 * NOTES-23: the service worker (`public/sw.js`) as it runs, in a small stand-in of a worker's world: its functions on
 * their own (what happens to a request, what may be kept, what a share carries) and its events (fetch, install,
 * activate, message, push). The file is read as it ships; the build's marks are filled in as the build does.
 */
type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files
const SOURCE = files.readFileSync('public/sw.js', 'utf-8')

const ORIGIN = 'https://notes.example.com'

// ---- A worker's world --------------------------------------------------------------------------------------------------

type FakeResponse = {
  status: number
  type: string
  redirected: boolean
  headers: Headers
  body: string
  url?: string
  clone: () => FakeResponse
}

function answer(body: string, init: { status?: number; type?: string; redirected?: boolean; headers?: Record<string, string> } = {}): FakeResponse {
  const response: FakeResponse = {
    status: init.status ?? 200,
    type: init.type ?? 'basic',
    redirected: init.redirected ?? false,
    headers: new Headers(init.headers ?? {}),
    body,
    // A copy of whatever it is now (a test may have changed a field with a spread).
    clone(this: FakeResponse) {
      return { ...this }
    },
  }
  return response
}

const shell = (body = 'shell') => answer(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-nexnotes-shell': '1' } })
const script = (body = 'js') => answer(body, { headers: { 'content-type': 'text/javascript' } })

function keyOf(request: string | { url: string }, ignoreSearch = false): string {
  const url = new URL(typeof request === 'string' ? request : request.url, ORIGIN)
  if (ignoreSearch) url.search = ''
  return url.href
}

function fakeCaches() {
  const stores = new Map<string, Map<string, FakeResponse>>()
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)!
    return {
      put: async (request: string | { url: string }, response: FakeResponse) => void store.set(keyOf(request), response),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (request: { url: string }) => store.delete(keyOf(request)),
      match: async (request: string | { url: string }, options: { ignoreSearch?: boolean } = {}) => {
        for (const [key, value] of store) if (keyOf(key, options.ignoreSearch) === keyOf(request, options.ignoreSearch)) return value
        return undefined
      },
    }
  }
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: string | { url: string }, options: { ignoreSearch?: boolean } = {}) => {
      for (const name of stores.keys()) {
        const found = await (await open(name)).match(request, options)
        if (found) return found
      }
      return undefined
    },
    /** Every key kept, over all caches. */
    all: () => [...stores.values()].flatMap((store) => [...store.keys()]),
  }
}

type Listener = (event: Record<string, unknown>) => void

type World = {
  api: {
    strategy: (request: { url: string; method: string; mode?: string }, origin: string, built: boolean) => string
    keepable: (response: FakeResponse | null, kind: string) => boolean
    shellEntry: (url: string) => boolean
    readShare: (form: { get: (key: string) => unknown; getAll: (key: string) => unknown[] }) => { title: string; text: string; url: string; files: unknown[] }
    shared: Map<string, unknown>
    CACHE: string
    SHARE_KEEP_MS: number
  }
  listeners: Record<string, Listener>
  caches: ReturnType<typeof fakeCaches>
  fetch: ReturnType<typeof vi.fn>
  self: { registration: { active: unknown; showNotification: ReturnType<typeof vi.fn> }; skipWaiting: ReturnType<typeof vi.fn>; clients: Record<string, ReturnType<typeof vi.fn>> }
}

function load({ built = true, files: shellFiles = ['/logo.svg', '/manifest.webmanifest', '/assets/index-abc.js'], version = 'b1', active = null as unknown } = {}): World {
  let code = SOURCE
  if (built) code = code.replace("'__NEXNOTES_BUILD__'", JSON.stringify(version)).replace('/* __NEXNOTES_SHELL__ */ []', JSON.stringify(shellFiles))
  const listeners: Record<string, Listener> = {}
  const self = {
    addEventListener: (type: string, listener: Listener) => void (listeners[type] = listener),
    location: { origin: ORIGIN },
    registration: { active, showNotification: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) },
  }
  const caches = fakeCaches()
  const fetch = vi.fn(async (): Promise<FakeResponse> => {
    throw new TypeError('Failed to fetch')
  })
  const RequestLike = function (this: { url: string }, url: string) {
    this.url = new URL(url, ORIGIN).href
  } as unknown as typeof Request
  const api = new Function(
    'self',
    'caches',
    'fetch',
    'Request',
    code + '\nreturn { strategy, keepable, shellEntry, readShare, shared, CACHE, SHARE_KEEP_MS }',
  )(self, caches, fetch, RequestLike) as World['api']
  return { api, listeners, caches, fetch, self }
}

const request = (path: string, init: { method?: string; mode?: string; origin?: string } = {}) => ({
  url: (init.origin ?? ORIGIN) + path,
  method: init.method ?? 'GET',
  mode: init.mode ?? 'cors',
})

/** A fetch event as the browser hands it: what the worker answers, and what it waits for. */
function fetchEvent(world: World, req: Record<string, unknown>) {
  let answered: Promise<unknown> | null = null
  const waits: Promise<unknown>[] = []
  world.listeners.fetch({
    request: req,
    respondWith: (promise: Promise<unknown>) => void (answered = Promise.resolve(promise)),
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
  })
  return { answered: answered as Promise<unknown> | null, waits }
}

async function lifecycle(world: World, type: 'install' | 'activate') {
  const waits: Promise<unknown>[] = []
  world.listeners[type]({ waitUntil: (promise: Promise<unknown>) => void waits.push(promise) })
  await Promise.all(waits)
}

/** Sends a message the way a page does, with a port for the answer. */
async function message(world: World, data: Record<string, unknown>): Promise<unknown> {
  let reply: unknown = undefined
  const waits: Promise<unknown>[] = []
  world.listeners.message({ data, ports: [{ postMessage: (value: unknown) => void (reply = value) }], waitUntil: (promise: Promise<unknown>) => void waits.push(promise) })
  await Promise.all(waits)
  return reply
}

function form(values: Record<string, unknown>, list: unknown[] = []) {
  return { get: (key: string) => values[key] ?? null, getAll: (key: string) => (key === 'files' ? list : []) }
}

// ---- What happens to a request ---------------------------------------------------------------------------------------

describe('NOTES-23 the service worker decides per request', () => {
  it('NOTES-23 pages, built files and shell files are its own; the API, read links and other sites never', () => {
    const { api } = load()
    const at = (path: string, init?: Parameters<typeof request>[1]) => api.strategy(request(path, init), ORIGIN, true)
    expect(at('/folders', { mode: 'navigate' })).toBe('page')
    expect(at('/notes/abc', { mode: 'navigate' })).toBe('page')
    expect(at('/assets/index-abc.js')).toBe('asset')
    expect(at('/assets/later-def.js')).toBe('asset')
    expect(at('/logo.svg')).toBe('file')
    expect(at('/manifest.webmanifest')).toBe('file')
    for (const path of ['/api/notes', '/api', '/api/attachments/x/view', '/l/token', '/l', '/sw.js', '/somewhere.png'])
      expect(at(path, { mode: path.startsWith('/l') ? 'navigate' : 'cors' }), path).toBe('network')
    expect(at('/api/notes', { mode: 'navigate' })).toBe('network')
    expect(at('/l/abc/pdf', { mode: 'navigate' })).toBe('network')
    expect(at('/folders', { mode: 'navigate', origin: 'https://other.example' })).toBe('network')
    expect(at('/notes', { method: 'POST' })).toBe('network')
    expect(at('/api/notes', { method: 'POST' })).toBe('network')
  })

  it('NOTES-23 the share target is taken even without a build, everything else is left alone then', () => {
    const { api } = load({ built: false })
    expect(api.strategy(request('/share-target', { method: 'POST', mode: 'navigate' }), ORIGIN, false)).toBe('share')
    expect(api.strategy(request('/share-target', { method: 'POST' }), ORIGIN, false)).toBe('share')
    expect(api.strategy(request('/share-target', { method: 'GET', mode: 'navigate' }), ORIGIN, false)).toBe('network')
    expect(api.strategy(request('/folders', { mode: 'navigate' }), ORIGIN, false)).toBe('network')
    expect(api.strategy(request('/share-target', { method: 'POST', origin: 'https://other.example' }), ORIGIN, false)).toBe('network')
  })

  it('NOTES-23 only whole answers of the own origin are kept, a page only with the mark of the start page', () => {
    const { api } = load()
    expect(api.keepable(shell(), 'page')).toBe(true)
    expect(api.keepable(answer('<h1>A note</h1>', { headers: { 'content-type': 'text/html' } }), 'page')).toBe(false)
    expect(api.keepable(answer('x', { headers: { 'x-nexnotes-shell': '1', 'content-type': 'application/json' } }), 'page')).toBe(false)
    expect(api.keepable({ ...shell(), redirected: true }, 'page')).toBe(false)
    expect(api.keepable({ ...shell(), type: 'opaque' }, 'page')).toBe(false)
    expect(api.keepable({ ...shell(), type: 'cors' }, 'page')).toBe(false)
    expect(api.keepable({ ...shell(), status: 404 }, 'page')).toBe(false)
    expect(api.keepable({ ...shell(), status: 206 }, 'page')).toBe(false)
    expect(api.keepable(answer('x', { headers: { 'content-type': 'text/html', 'x-nexnotes-shell': '1', 'cache-control': 'private, no-store' } }), 'page')).toBe(false)
    expect(api.keepable(null, 'asset')).toBe(false)
    expect(api.keepable(script(), 'asset')).toBe(true)
    // The start page the server gives for a file that is not there is no file.
    expect(api.keepable(shell(), 'file')).toBe(false)
    expect(api.keepable(shell(), 'asset')).toBe(false)
  })

  it('NOTES-23 the shell is the start page, the built files and the listed ones; nothing else', () => {
    const { api } = load()
    expect(api.shellEntry(ORIGIN + '/index.html')).toBe(true)
    expect(api.shellEntry(ORIGIN + '/assets/x.js')).toBe(true)
    expect(api.shellEntry(ORIGIN + '/logo.svg')).toBe(true)
    expect(api.shellEntry(ORIGIN + '/api/notes')).toBe(false)
    expect(api.shellEntry(ORIGIN + '/l/token')).toBe(false)
    expect(api.shellEntry(ORIGIN + '/notes/abc')).toBe(false)
  })
})

// ---- Pages without and with the network -------------------------------------------------------------------------------

describe('NOTES-23 the shell', () => {
  it('NOTES-23 AC-4 the start page is kept from the network and answers a page when the network is gone', async () => {
    const world = load()
    world.fetch.mockResolvedValueOnce(shell('the shell'))
    const first = fetchEvent(world, request('/folders', { mode: 'navigate' }))
    expect(((await first.answered) as FakeResponse).body).toBe('the shell')
    expect(world.caches.all()).toEqual([ORIGIN + '/index.html'])
    // No network: the kept start page, so the app can say "No connection" itself.
    world.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const offline = fetchEvent(world, request('/notes/abc', { mode: 'navigate' }))
    expect(((await offline.answered) as FakeResponse).body).toBe('the shell')
    // The server is down behind its proxy: the same.
    world.fetch.mockResolvedValueOnce(answer('Bad gateway', { status: 502, headers: { 'content-type': 'text/html' } }))
    const down = fetchEvent(world, request('/', { mode: 'navigate' }))
    expect(((await down.answered) as FakeResponse).body).toBe('the shell')
  })

  it('NOTES-23 a page drawn by the server with a note in it, or a sign-in of another site, is never kept', async () => {
    const world = load()
    world.fetch.mockResolvedValueOnce(answer('<h1>Secret note</h1>', { headers: { 'content-type': 'text/html' } }))
    expect(((await fetchEvent(world, request('/shared-page', { mode: 'navigate' })).answered) as FakeResponse).body).toBe('<h1>Secret note</h1>')
    world.fetch.mockResolvedValueOnce({ ...shell('sign-in of a proxy'), redirected: true })
    await fetchEvent(world, request('/', { mode: 'navigate' })).answered
    expect(world.caches.all()).toEqual([])
    // A read link is not even looked at.
    expect(fetchEvent(world, request('/l/token', { mode: 'navigate' })).answered).toBeNull()
    expect(fetchEvent(world, request('/api/notes')).answered).toBeNull()
  })

  it('NOTES-23 the answers of the API are never kept, whatever they say', async () => {
    const world = load()
    world.fetch.mockResolvedValue(shell('{"title":"A note"}'))
    for (const path of ['/api/notes', '/api/notes/abc', '/api/attachments/x/view', '/api/auth/me']) {
      expect(fetchEvent(world, request(path)).answered, path).toBeNull()
    }
    expect(world.fetch).not.toHaveBeenCalled()
    expect(world.caches.all()).toEqual([])
  })

  it('NOTES-23 built files come from the cache first, the network fills it', async () => {
    const world = load()
    world.fetch.mockResolvedValueOnce(script('code v1'))
    expect(((await fetchEvent(world, request('/assets/later-def.js')).answered) as FakeResponse).body).toBe('code v1')
    world.fetch.mockResolvedValueOnce(script('code v2'))
    expect(((await fetchEvent(world, request('/assets/later-def.js')).answered) as FakeResponse).body).toBe('code v1')
    expect(world.fetch).toHaveBeenCalledTimes(1)
  })

  it('NOTES-23 files without a hash come from the network first and from the cache without it', async () => {
    const world = load()
    world.fetch.mockResolvedValueOnce(answer('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    await fetchEvent(world, request('/logo.svg?v=2')).answered
    world.fetch.mockRejectedValueOnce(new TypeError('offline'))
    expect(((await fetchEvent(world, request('/logo.svg?v=3')).answered) as FakeResponse).body).toBe('<svg/>')
  })

  it('NOTES-23 install keeps the shell, checked one by one; only the very first worker takes over at once', async () => {
    const world = load()
    world.fetch.mockImplementation(async (req: { url: string }) => {
      const path = new URL(req.url).pathname
      if (path === '/index.html') return shell()
      if (path === '/manifest.webmanifest') return answer('{}', { redirected: true, headers: { 'content-type': 'application/json' } })
      if (path === '/logo.svg') return answer('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
      return script()
    })
    await lifecycle(world, 'install')
    expect(world.caches.all().sort()).toEqual([ORIGIN + '/assets/index-abc.js', ORIGIN + '/index.html', ORIGIN + '/logo.svg'])
    expect(world.self.skipWaiting).toHaveBeenCalledTimes(1)

    const later = load({ active: {} })
    later.fetch.mockResolvedValue(script())
    await lifecycle(later, 'install')
    expect(later.self.skipWaiting).not.toHaveBeenCalled()
    await message(later, { type: 'nexnotes-update' })
    expect(later.self.skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('NOTES-23 a new build has a cache of its own, and the old ones go when it takes over', async () => {
    const world = load({ version: 'b2' })
    await world.caches.open('nexnotes-shell-b1')
    await world.caches.open('nexnotes-shell-b2')
    await world.caches.open('something-else')
    expect(world.api.CACHE).toBe('nexnotes-shell-b2')
    await lifecycle(world, 'activate')
    expect(await world.caches.keys()).toEqual(['nexnotes-shell-b2', 'something-else'])
    expect(world.self.clients.claim).toHaveBeenCalled()
  })

  it('NOTES-23 without a build nothing is kept and no page is touched', async () => {
    const world = load({ built: false })
    expect(fetchEvent(world, request('/folders', { mode: 'navigate' })).answered).toBeNull()
    expect(fetchEvent(world, request('/assets/x.js')).answered).toBeNull()
    await lifecycle(world, 'install')
    expect(world.fetch).not.toHaveBeenCalled()
    expect(world.self.skipWaiting).toHaveBeenCalled()
  })

  it('NOTES-23 the worker names its build and files to the page', async () => {
    const world = load({ version: 'b7' })
    expect(await message(world, { type: 'nexnotes-shell' })).toEqual({ version: 'b7', shell: ['/logo.svg', '/manifest.webmanifest', '/assets/index-abc.js'] })
  })
})

// ---- Shared from another app ------------------------------------------------------------------------------------------

describe('NOTES-23 AC-5 the share target', () => {
  afterEach(() => vi.useRealTimers())

  it('NOTES-23 AC-5 reads the form checked: texts cut, only web addresses, only files', () => {
    const { api } = load()
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' })
    const read = api.readShare(form({ title: 'Kompost', text: 'a'.repeat(300000), url: ' https://garden.example/kompost ' }, [photo, 'not a file', null]))
    expect(read.title).toBe('Kompost')
    expect(read.text.length).toBe(200000)
    expect(read.url).toBe('https://garden.example/kompost')
    expect(read.files).toEqual([photo])
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://a b']) expect(api.readShare(form({ url })).url, url).toBe('')
    expect(api.readShare(form({ title: 5, text: { a: 1 } })).title).toBe('')
    expect(api.readShare(form({}, Array.from({ length: 30 }, (_, i) => new File(['x'], `f${i}.txt`)))).files).toHaveLength(20)
  })

  it('NOTES-23 EC-3 a text shared without a file carries no file: the empty part of the file field is none', () => {
    const { api } = load()
    // What a browser sends for a file field with nothing chosen: one part without name and bytes.
    const nothing = new File([], '', { type: 'application/octet-stream' })
    const empty = new File([], 'empty.txt', { type: 'text/plain' })
    expect(api.readShare(form({ text: 'Milch' }, [nothing])).files).toEqual([])
    // A real file that happens to be empty stays: the page says so (the server refuses it).
    expect(api.readShare(form({ text: 'Milch' }, [nothing, empty])).files).toEqual([empty])
  })

  it('NOTES-23 AC-5 keeps what was shared in memory only and sends the page to "Save to nexnotes"', async () => {
    const world = load()
    const photo = new File(['picture'], 'photo.jpg', { type: 'image/jpeg' })
    const post = { ...request('/share-target', { method: 'POST', mode: 'navigate' }), formData: async () => form({ title: 'Kompost', url: 'https://garden.example/k' }, [photo]) }
    const event = fetchEvent(world, post)
    const redirect = (await event.answered) as Response
    expect(redirect.status).toBe(303)
    const target = new URL(redirect.headers.get('location')!)
    expect(target.origin).toBe(ORIGIN)
    expect(target.pathname).toBe('/share')
    const id = target.searchParams.get('shared')!
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    // The event waits while the share waits: the worker stays alive for the page.
    expect(event.waits).toHaveLength(1)
    // Nothing of it in a cache, ever.
    expect(world.caches.all()).toEqual([])
    const taken = (await message(world, { type: 'nexnotes-share-take', id })) as { title: string; url: string; files: File[] }
    expect(taken).toMatchObject({ title: 'Kompost', url: 'https://garden.example/k', text: '' })
    expect(taken.files).toEqual([photo])
    // Taken twice (a sign-in on the way loads the page anew): still there until done.
    expect(await message(world, { type: 'nexnotes-share-take', id })).not.toBeNull()
    expect(await message(world, { type: 'nexnotes-share-take', id: 'f'.repeat(32) })).toBeNull()
    await message(world, { type: 'nexnotes-share-done', id })
    expect(await message(world, { type: 'nexnotes-share-take', id })).toBeNull()
    await event.waits[0]
  })

  it('NOTES-23 AC-5 a form that cannot be read leads to the page that says so', async () => {
    const world = load()
    const post = { ...request('/share-target', { method: 'POST', mode: 'navigate' }), formData: async () => Promise.reject(new TypeError('bad body')) }
    const redirect = (await fetchEvent(world, post).answered) as Response
    expect(new URL(redirect.headers.get('location')!).search).toBe('?shared=lost')
  })

  it('NOTES-23 AC-5 what was shared runs out after its time', async () => {
    vi.useFakeTimers()
    const world = load()
    const post = { ...request('/share-target', { method: 'POST', mode: 'navigate' }), formData: async () => form({ text: 'Milch' }) }
    const event = fetchEvent(world, post)
    const id = new URL(((await event.answered) as Response).headers.get('location')!).searchParams.get('shared')!
    vi.advanceTimersByTime(world.api.SHARE_KEEP_MS - 1000)
    expect(await message(world, { type: 'nexnotes-share-take', id })).not.toBeNull()
    vi.advanceTimersByTime(2000)
    expect(await message(world, { type: 'nexnotes-share-take', id })).toBeNull()
    await event.waits[0]
  })

  it('NOTES-23 signing out forgets what was shared and everything in the cache that is not the shell', async () => {
    const world = load()
    const post = { ...request('/share-target', { method: 'POST', mode: 'navigate' }), formData: async () => form({ text: 'Geheim' }) }
    const event = fetchEvent(world, post)
    const id = new URL(((await event.answered) as Response).headers.get('location')!).searchParams.get('shared')!
    const cache = await world.caches.open(world.api.CACHE)
    await cache.put('/index.html', shell())
    await cache.put('/assets/index-abc.js', script())
    await cache.put('/api/notes', answer('[]'))
    await cache.put('/notes/abc', answer('note'))
    const other = await world.caches.open('nexnotes-shell-old')
    await other.put('/api/auth/me', answer('{}'))
    await message(world, { type: 'nexnotes-forget' })
    expect(await message(world, { type: 'nexnotes-share-take', id })).toBeNull()
    expect(world.api.shared.size).toBe(0)
    expect(world.caches.all().sort()).toEqual([ORIGIN + '/assets/index-abc.js', ORIGIN + '/index.html'])
    await event.waits[0]
  })
})

// ---- Notifications stay as they were (NOTES-14) ----------------------------------------------------------------------

describe('NOTES-23 the notifications of NOTES-14 stay', () => {
  it('NOTES-23 a push still shows its notification with an address inside nexnotes', async () => {
    const world = load()
    const waits: Promise<unknown>[] = []
    world.listeners.push({ data: { json: () => ({ title: 'Anna', body: '+ Eier', url: 'https://evil.example/x' }) }, waitUntil: (p: Promise<unknown>) => void waits.push(p) })
    await Promise.all(waits)
    expect(world.self.registration.showNotification).toHaveBeenCalledWith('Anna', expect.objectContaining({ body: '+ Eier', data: { url: '/' } }))
    expect(world.listeners.notificationclick).toBeTypeOf('function')
  })
})
